# Imagem do navegador CloakBrowser usada pelo dashboard.
#
# Por que existe: a imagem oficial sobe um Xvfb FIXO dentro do /entrypoint.sh
# (`Xvfb :99 -screen 0 1920x1080x24`), que além de não ter tela nenhuma para o
# usuário não acompanha o tamanho declarado pelo perfil. O dashboard lança o
# Chrome com `--fingerprint-screen-width/height` tirados do perfil — se o X for
# 1920x1080 e a tela anunciada for 1366x768, isso é uma contradição detectável
# (um X maior que a tela do próprio navegador não existe em máquina real).
#
# O patch faz duas coisas, ambas no mesmo lugar (o servidor X do container):
#
#  1. instala o KasmVNC 1.3.3 — o `Xvnc` passa a ser o servidor X de `:99`. É o
#     mesmo stack do Chromium Linux oficial: tela rápida (WebP, ajuste de
#     qualidade no cliente), área de transferência nos dois sentidos e ajuste de
#     escala no navegador. O cliente web é servido pelo próprio Xvnc
#     (`-httpd /usr/share/kasmvnc/www`) na porta do `-websocketPort`, sempre no
#     LOOPBACK: quem publica é o roteador do dashboard (port-router.py), junto
#     com o CDP, na mesma porta da instância.
#
#  2. troca a linha do Xvfb por esse Xvnc, com a geometria vinda de
#     SCREEN_WIDTH/SCREEN_HEIGHT (o tamanho de tela do perfil, o mesmo que vai
#     nas flags --fingerprint-screen-*).
#
# `-rfbport -1` desliga o VNC cru (só WebSocket, na porta do -websocketPort) e
# `-interface 127.0.0.1` mantém o cliente web fora do alcance da rede. O arquivo
# do `.deb` é escolhido pela arquitetura do próprio build (amd64/arm64), sem
# depender de buildx.
ARG BROWSER_BASE_IMAGE=cloakhq/cloakbrowser:latest
FROM ${BROWSER_BASE_IMAGE}

# wget/ca-certificates são só para o download do .deb; xclip é o que a área de
# transferência do KasmVNC usa para ler/escrever a seleção do X.
RUN apt-get update \
 && apt-get install -y --no-install-recommends wget ca-certificates xclip pulseaudio pulseaudio-utils \
 && ARCH="$(dpkg --print-architecture)" \
 && wget -q "https://github.com/kasmtech/KasmVNC/releases/download/v1.3.3/kasmvncserver_bookworm_1.3.3_${ARCH}.deb" \
 && apt-get install -y -f "./kasmvncserver_bookworm_1.3.3_${ARCH}.deb" \
 && rm -f "./kasmvncserver_bookworm_1.3.3_${ARCH}.deb" \
 && rm -rf /var/lib/apt/lists/* \
 && command -v Xvnc \
 && command -v parec && test -d /usr/share/kasmvnc/www

# KasmVNC guarda configuração por usuário em ~/.vnc; o diretório precisa existir
# antes do primeiro start (o container roda como root).
RUN mkdir -p /root/.vnc

# Áudio do container. Os quatro arquivos vêm do repositório (o contexto de build
# é só esta pasta) e o COPY acontece depois do KasmVNC porque o cliente web
# (`kasm-audio.js`) é servido de dentro do www dele.
COPY pulse-virtual.pa /usr/local/share/pulse-virtual.pa
COPY audio-bridge.py /usr/local/bin/audio-bridge.py
COPY audio-start.sh /usr/local/bin/audio-start.sh
COPY kasm-audio.js /usr/share/kasmvnc/www/kasm-audio.js

# O sink virtual entra no system.pa (é o arquivo que o `pulseaudio --system` lê)
# e o cliente é injetado no index.html do KasmVNC. Os modos de execução são
# fixados à mão porque o repositório vive no Windows e o COPY não traz bit de
# execução.
RUN cat /usr/local/share/pulse-virtual.pa >> /etc/pulse/system.pa \
 && chmod 0755 /usr/local/bin/audio-bridge.py /usr/local/bin/audio-start.sh \
 && sed -i \
      's#<title>KasmVNC</title>#<title>KasmVNC</title><script src="/kasm-audio.js" defer></script>#' \
      /usr/share/kasmvnc/www/index.html \
 && grep -q 'kasm-audio.js' /usr/share/kasmvnc/www/index.html

# Xvfb -> Xvnc (KasmVNC), com a geometria e a porta do cliente web vindas do
# ambiente. O `&` final (servidor em background) é literal no entrypoint — no
# sed ele precisa de escape, tanto ele quanto o do `2>&1`.
RUN sed -i \
      's#Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp &.*#Xvnc :99 -websocketPort "${KASM_PORT:-9225}" -rfbport -1 -geometry "${SCREEN_WIDTH:-1366}x${SCREEN_HEIGHT:-768}" -depth 24 -SecurityTypes None -DisableBasicAuth -interface 127.0.0.1 -publicIP 127.0.0.1 -AlwaysShared -httpd /usr/share/kasmvnc/www >/tmp/xvnc.log 2>\&1 \&#' \
      /entrypoint.sh \
 && grep -q 'Xvnc :99' /entrypoint.sh \
 && ! grep -q '^Xvfb ' /entrypoint.sh

# Áudio: a linha do áudio entra ANTES do Xvnc (o sink virtual tem de existir
# quando o Chrome arrancar — é para ele que o som vai).
RUN sed -i \
      's#^Xvnc :99#/usr/local/bin/audio-start.sh\nXvnc :99#' \
      /entrypoint.sh \
 && grep -q 'audio-start.sh' /entrypoint.sh

# O socket do PulseAudio que o Chrome e o `parec` usam (ver pulse-virtual.pa).
# O entrypoint é quem sobe o servidor; aqui fica só o endereço dele.
ENV PULSE_SERVER=unix:/tmp/pulse-native
# Porta da ponte de áudio no loopback: o roteador da instância publica o
# caminho /audio e o dashboard manda este mesmo número em `--audio`.
ENV AUDIO_PORT=9226

