#!/bin/sh
# Sobe o áudio do container ANTES do servidor de tela (o entrypoint chama isto
# logo antes do `Xvnc`): o PulseAudio com o sink virtual e a ponte que transmite
# o som do navegador para o cliente web do KasmVNC.
#
# Por que aqui e não no Dockerfile: o sink precisa existir em TODA recriação do
# container (o /tmp não sobrevive), e o Chrome só arranca depois — daí o lugar
# ser o entrypoint, na frente do X.
set -u

RATE="${AUDIO_RATE:-24000}"
CHANNELS="${AUDIO_CHANNELS:-1}"
PORT="${AUDIO_PORT:-9226}"

# Modo sistema: o Chrome roda como root e o pulseaudio de usuário se recusa a
# subir como root. O socket que os clientes usam é o de /etc/pulse/system.pa
# (PULSE_SERVER já vem do Dockerfile).
mkdir -p /var/run/pulse
pulseaudio --system --disallow-exit --daemonize=yes >/tmp/pulseaudio.log 2>&1

# Espera o socket aparecer: o Chrome (e o parec) falham se conectarem antes.
i=0
while [ ! -S /tmp/pulse-native ] && [ "$i" -lt 50 ]; do
  i=$((i + 1))
  sleep 0.1
done

if [ ! -S /tmp/pulse-native ]; then
  echo "[audio] PulseAudio não subiu — o som fica mudo nesta instância" >&2
  tail -5 /tmp/pulseaudio.log >&2
fi

python3 /usr/local/bin/audio-bridge.py \
  --listen "$PORT" --rate "$RATE" --channels "$CHANNELS" \
  >/tmp/audio-bridge.log 2>&1 &
