#!/usr/bin/env python3
"""Roteador de porta do container do CloakBrowser.

UM único porto publicado serve DOIS serviços dentro do container:

  * o CDP do Chrome (descoberta `/json/...`, WebSocket `/devtools/...`) —
    preso em `127.0.0.1:9222` pelo binário, que ignora
    `--remote-debugging-address` de propósito;
  * a tela do KasmVNC (cliente web e WebSocket) — presa em `127.0.0.1:9225`.

Sem este roteador nenhum dos dois sairia do container: o loopback não é
alcançável pela porta publicada. Ele também evita um segundo porto publicado —
o gluetun continua publicando exatamente uma porta por instância.

A escolha é por CAMINHO, lida da primeira linha HTTP da conexão. Depois de
escolher o destino os bytes seguem intactos (é um túnel TCP puro), então o
WebSocket do CDP e o do KasmVNC atravessam sem nenhuma tradução.

Uso:
    port-router.py --listen 9223 --cdp 9222 --screen 9225

Sem dependências externas (só a biblioteca padrão), porque a imagem do
CloakBrowser não traz socat/nc.
"""

from __future__ import annotations

import argparse
import socket
import sys
import threading

# Tamanho do bloco de cópia: 64 KiB cobre bem o tráfego do CDP e da tela.
BUFFER_SIZE = 65536
BACKLOG = 128
# Teto para a leitura da primeira linha HTTP: uma linha de requisição normal
# tem dezenas de bytes; o limite só existe para uma conexão que nunca manda
# requisição nenhuma não prender a thread para sempre.
REQUEST_HEAD_LIMIT = 8192
# Prefixos de caminho que pertencem ao CDP. `/json` cobre `/json` e `/json/...`;
# `/devtools` cobre o WebSocket; `/fingerprint` é o roteamento por seed.
CDP_PATH_PREFIXES = ('/json', '/devtools', '/fingerprint')
# Métodos HTTP que reconhecemos na primeira linha. Qualquer coisa que não
# comece por um deles vai para a TELA (é o destino que tolera ruído: o cliente
# web do KasmVNC responde a requisições malformadas com a própria página).
HTTP_METHODS = (b'GET ', b'POST ', b'HEAD ', b'PUT ', b'OPTIONS ', b'DELETE ', b'PATCH ')


def _pump(source: socket.socket, destination: socket.socket) -> None:
    """Copia bytes de `source` para `destination` até o fim da conexão."""
    try:
        while True:
            chunk = source.recv(BUFFER_SIZE)
            if not chunk:
                break
            destination.sendall(chunk)
    except OSError:
        # Conexão encerrada de um dos lados (o normal no fim de uma sessão WS).
        pass
    finally:
        for endpoint in (source, destination):
            try:
                endpoint.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def _read_request_line(client: socket.socket) -> bytes:
    """Lê o suficiente para conhecer a primeira linha da requisição.

    Devolve os bytes já consumidos — que precisam ser repassados ao destino — e
    para na primeira quebra de linha. Se o cliente fechar ou estourar o limite
    sem mandar uma linha completa, devolve o que tiver.
    """
    buffer = b''
    while b'\r\n' not in buffer and b'\n' not in buffer and len(buffer) < REQUEST_HEAD_LIMIT:
        try:
            chunk = client.recv(BUFFER_SIZE)
        except OSError:
            break
        if not chunk:
            break
        buffer += chunk
    return buffer


def _path_of(head: bytes) -> str:
    """Extrai o caminho da primeira linha HTTP ("GET /algo HTTP/1.1")."""
    line = head.split(b'\n', 1)[0].strip()
    parts = line.split()
    if len(parts) < 2:
        return ''
    if not any(line.startswith(method) for method in HTTP_METHODS):
        return ''
    return parts[1].decode('latin-1', 'replace')


def _target_port(head: bytes, cdp_port: int, screen_port: int) -> int:
    """Porta de destino para esta conexão: CDP ou tela."""
    path = _path_of(head)
    # Sem caminho reconhecível não há como ser CDP: a tela é o destino padrão.
    if path and path.startswith(CDP_PATH_PREFIXES):
        return cdp_port
    return screen_port


def _bridge(client: socket.socket, head: bytes, cdp_port: int, screen_port: int) -> None:
    """Liga um cliente ao destino escolhido, nos dois sentidos."""
    port = _target_port(head, cdp_port, screen_port)
    target = ('127.0.0.1', port)

    try:
        upstream = socket.create_connection(target, timeout=10)
    except OSError as error:
        print(f"[port-router] alvo {target[0]}:{target[1]} indisponível: {error}", file=sys.stderr)
        client.close()
        return

    upstream.settimeout(None)
    client.settimeout(None)

    # O que já foi lido (a linha de requisição) tem de chegar ao destino antes
    # do resto: sem isso o upstream esperaria uma requisição que já passou.
    if head:
        try:
            upstream.sendall(head)
        except OSError:
            upstream.close()
            client.close()
            return

    # Uma thread por sentido: tanto o CDP quanto o KasmVNC são half-duplex com
    # mensagens longas e o `select` de uma thread só atrasaria o handshake.
    to_upstream = threading.Thread(target=_pump, args=(client, upstream), daemon=True)
    to_upstream.start()
    _pump(upstream, client)

    try:
        upstream.close()
    except OSError:
        pass


def serve(listen_port: int, cdp_port: int, screen_port: int) -> None:
    """Aceita conexões em 0.0.0.0:<listen_port> e as repassa por caminho."""
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(('0.0.0.0', listen_port))
    server.listen(BACKLOG)
    print(
        f"[port-router] 0.0.0.0:{listen_port} -> CDP 127.0.0.1:{cdp_port} | "
        f"tela 127.0.0.1:{screen_port}",
        file=sys.stderr
    )

    while True:
        try:
            client, _ = server.accept()
        except OSError:
            continue
        threading.Thread(
            target=_handle,
            args=(client, cdp_port, screen_port),
            daemon=True
        ).start()


def _handle(client: socket.socket, cdp_port: int, screen_port: int) -> None:
    """Lê a linha de requisição e delega a ponte correspondente."""
    head = _read_request_line(client)
    _bridge(client, head, cdp_port, screen_port)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description='Roteador de porta do CloakBrowser')
    parser.add_argument('--listen', type=int, default=9223, help='porta pública dentro do container')
    parser.add_argument('--cdp', type=int, default=9222, help='porta do CDP no loopback')
    parser.add_argument('--screen', type=int, default=9225, help='porta da tela (KasmVNC) no loopback')
    args = parser.parse_args(argv)

    try:
        serve(args.listen, args.cdp, args.screen)
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
