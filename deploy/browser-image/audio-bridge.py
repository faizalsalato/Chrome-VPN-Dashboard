#!/usr/bin/env python3
"""Ponte de áudio do container: o som que toca no navegador vira um fluxo PCM.

Por que existe: a tela vem do KasmVNC, e o KasmVNC NÃO transmite áudio — o
próprio projeto confirma ("KasmVNC does not support audio"; o áudio é um canal
do Kasm Workspaces, que é produto fechado). Como a imagem também não tem placa
de som, sem esta ponte o navegador toca para o vazio.

O desenho:

  * o entrypoint sobe um PulseAudio em modo SISTEMA (o Chrome roda como root e o
    pulseaudio de usuário recusa root) com um sink VIRTUAL (`module-null-sink`,
    configurado em /etc/pulse/system.pa): é para esse sink que o Chrome manda o
    som, porque não existe saída de verdade;
  * esta ponte lê o MONITOR do sink — `parec`, que já vem no pulseaudio-utils —
    e serve os bytes crus (PCM s16le, sem cabeçalho) num fluxo HTTP em
    streaming, no caminho `/audio`;
  * o cliente injetado no cliente web do KasmVNC (`kasm-audio.js`) lê esse fluxo
    com `fetch()` + ReadableStream e alimenta um `AudioContext`.

Opus/ffmpeg ficam de fora de propósito: PCM cru não precisa de pacote nenhum
além do que já está na imagem, e a taxa/canais vêm do ambiente
(AUDIO_RATE/AUDIO_CHANNELS) para o operador escolher o compromisso com a banda.

O tráfego nunca sai do loopback: quem publica é o roteador da porta da
instância (port-router.py), que manda `/audio` para cá.

Sem dependências externas (só a biblioteca padrão).
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Fração de segundo de som por leitura do `parec`: o fluxo fica contínuo sem o
# cliente acumular atraso.
BLOCK_MS = 20
# O `parec`, sem isto, entrega o som em blocos grandes (segundos) — o que
# apareceria como som aos pedaços.
LATENCY_MS = 40
# Taxa/canais por omissão: o bastante para voz e vídeo num link modesto
# (24000 x 1 x 16 bits = 48 kB/s). O ambiente troca pelo que o link aguentar.
DEFAULT_RATE = 24000
DEFAULT_CHANNELS = 1
# Nome do sink virtual (o mesmo de /etc/pulse/system.pa).
SINK = 'virtual'


def pcm_command(rate: int, channels: int) -> list:
    """Comando que despeja o monitor do sink virtual em PCM cru no stdout."""
    return [
        'parec',
        f'--device={SINK}.monitor',
        '--raw',
        '--format=s16le',
        f'--rate={rate}',
        f'--channels={channels}',
        f'--latency-msec={LATENCY_MS}',
    ]


class AudioHandler(BaseHTTPRequestHandler):
    """Serve o fluxo de áudio em `/audio` e nada mais."""

    # HTTP/1.0 + `Connection: close`: o corpo é delimitado pelo fim da conexão,
    # que é o que permite um fluxo sem tamanho conhecido (o navegador entrega os
    # pedaços conforme chegam).
    protocol_version = 'HTTP/1.0'

    def do_GET(self) -> None:  # noqa: N802 (nome exigido pela classe base)
        if self.path.split('?', 1)[0] != '/audio':
            self.send_error(404, 'Use /audio')
            return
        self.stream_audio()

    def stream_audio(self) -> None:
        """Liga o `parec` a esta resposta, até o cliente desligar."""
        rate = self.server.rate
        channels = self.server.channels
        block = max(2, rate * channels * 2 * BLOCK_MS // 1000)

        self.send_response(200)
        # `audio/L16` é o nome IETF do PCM com sinal de 16 bits; os dois
        # cabeçalhos X-* dizem ao cliente como montar o AudioContext.
        self.send_header('Content-Type', f'audio/L16;rate={rate};channels={channels}')
        self.send_header('X-Audio-Rate', str(rate))
        self.send_header('X-Audio-Channels', str(channels))
        self.send_header('Cache-Control', 'no-store')
        # Sem isto o nginx do subdomínio segura os pedaços (proxy_buffering é ON
        # por omissão) e o som chega com segundos de atraso.
        self.send_header('X-Accel-Buffering', 'no')
        self.send_header('Connection', 'close')
        self.end_headers()

        process = subprocess.Popen(
            pcm_command(rate, channels),
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL
        )

        try:
            while True:
                chunk = process.stdout.read(block)
                if not chunk:
                    break
                self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            # Cliente fechou a aba (ou desligou o botão): é o fim normal.
            pass
        finally:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()

    def log_message(self, format, *args) -> None:  # noqa: A002
        # Uma linha por conexão basta; o log do container não precisa da
        # contagem de pacotes.
        print(f'[audio-bridge] {self.address_string()} {format % args}', file=sys.stderr)


class AudioServer(ThreadingHTTPServer):
    """Um servidor por container; cada cliente ganha o seu próprio `parec`."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, handler, rate: int, channels: int):
        super().__init__(address, handler)
        self.rate = rate
        self.channels = channels


def main(argv: list = None) -> int:
    parser = argparse.ArgumentParser(description='Ponte de áudio do CloakBrowser')
    parser.add_argument('--listen', type=int, default=9226, help='porta no loopback')
    parser.add_argument('--rate', type=int, default=DEFAULT_RATE, help='taxa do PCM em Hz')
    parser.add_argument('--channels', type=int, default=DEFAULT_CHANNELS, help='canais do PCM')
    args = parser.parse_args(argv)

    server = AudioServer(('127.0.0.1', args.listen), AudioHandler, args.rate, args.channels)
    print(
        f'[audio-bridge] 127.0.0.1:{args.listen} -> {SINK}.monitor '
        f'({args.rate} Hz, {args.channels} canal(is))',
        file=sys.stderr
    )

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        return 0
    finally:
        server.server_close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
