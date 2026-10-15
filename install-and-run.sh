#!/bin/bash
# ============================================================
# install-and-run.sh — Instala e roda o Dashboard
# Domínio: <BASE_DOMAIN> (HTTPS via Nginx + Let's Encrypt)
#
# Cada instância de navegador ganha um subdomínio próprio
# (<slug>.<BASE_DOMAIN>) com vhost de nginx gerado pelo próprio
# dashboard (src/services/nginx.service.js) — este script só
# prepara o painel (o vhost raiz) e o serviço systemd.
# ============================================================

set -e

# --- Parâmetros (sobrescreva por variável de ambiente) ---------
# BASE_DOMAIN: domínio raiz. O painel fica nele e cada instância
#   ganha <slug>.<BASE_DOMAIN> (ex.: chrome1.brave.rota.ath.cx).
BASE_DOMAIN="${BASE_DOMAIN:-brave.rota.ath.cx}"

# Porta HTTP do painel (onde o vhost raiz do nginx faz proxy_pass).
PORT="${PORT:-3001}"
DASHBOARD_PORT="$PORT"

# Porta base das instâncias: a instância de ordem N usa BASE_PORT+N
# (id=1 -> 4001, id=2 -> 4002 ...). O vhost de cada instância
# encaminha para cá.
BASE_PORT="${BASE_PORT:-4001}"

# Porta base dos forwarders locais de proxy autenticado.
PROXY_INJECTOR_BASE_PORT="${PROXY_INJECTOR_BASE_PORT:-8150}"

# Serviço systemd (nome único, para não colidir com outros painéis
# node já instalados no mesmo host — ex.: rotaproxy-dashboard).
SERVICE_NAME="${SERVICE_NAME:-chrome-vpn-dashboard}"
APP_DIR="${APP_DIR:-/opt/chrome-vpn-dashboard}"

EMAIL="${1:-admin@$BASE_DOMAIN}"

echo "🚀 Dashboard Chrome/VPN - Instalação e Deploy"
echo "================================================"

# 1. Instalar Node.js se não tiver
if ! command -v node &> /dev/null; then
  echo "📦 Instalando Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "✅ Node.js $(node --version)"

# O dashboard cria containers (navegador, gluetun) e fala com o Docker do host.
# Sem ele o painel sobe, mas nenhuma instância é criada.
if ! command -v docker &> /dev/null; then
  echo "⚠️  Docker não encontrado — instale-o antes de criar instâncias."
elif ! docker info &> /dev/null; then
  echo "⚠️  Docker instalado, mas o daemon não responde: verifique 'systemctl status docker'."
else
  echo "✅ Docker $(docker --version | cut -d' ' -f3 | tr -d ',')"
fi

# 2. Criar diretório da aplicação
sudo mkdir -p "$APP_DIR"
sudo cp -r . "$APP_DIR/"
cd "$APP_DIR"

# 2. Instalar dependências do projeto
echo "📦 Instalando dependências npm..."
npm install --production 2>/dev/null

# 3. Criar diretório de dados
mkdir -p "$APP_DIR/data"

# 4. Matar processos anteriores se existirem (só do próprio dashboard)
pkill -f "$APP_DIR.*node src/server.js" 2>/dev/null || true
sleep 1


# 5. Criar arquivo de ambiente (referência; a fonte da verdade é o
#    systemd — o dashboard NÃO lê .env, só process.env). Mantido para
#    documentar as variáveis; o unit carrega os mesmos valores via
#    Environment= abaixo.
if [ ! -f "$APP_DIR/.env" ]; then
  cat > "$APP_DIR/.env" << EOF
DOMAIN=$BASE_DOMAIN
PORT=$PORT
BASE_PORT=$BASE_PORT
MAX_INSTANCES=${MAX_INSTANCES:-20}
JWT_SECRET=${JWT_SECRET:-$(openssl rand -hex 32)}
SESSION_EXPIRY=${SESSION_EXPIRY:-86400}
ADMIN_USER=${ADMIN_USER:-admin}
ADMIN_PASS=${ADMIN_PASS:-admin123}
NGINX_ENABLED=true
PROXY_INJECTOR_BASE_PORT=$PROXY_INJECTOR_BASE_PORT
CERTBOT_EMAIL=$EMAIL
# CloakBrowser (antidetect). Imagem oficial + imagem derivada local com
# KasmVNC e áudio (ver deploy/browser-image/).
CLOAKBROWSER_IMAGE=cloakhq/cloakbrowser:latest
BROWSER_IMAGE=chrome-vpn-dashboard-browser:latest
KASM_PORT=9225
# Áudio do container: taxa e canais do PCM que vai para o cliente web
# (24000 x 1 canal ≈ 48 kB/s). Ver deploy/browser-image/audio-bridge.py.
AUDIO_RATE=24000
AUDIO_CHANNELS=1
# Envio de ficheiros para o perfil: 0 = SEM teto (o limite é o disco).
MAX_UPLOAD_BYTES=0
EOF

  echo "⚠️  Edite $APP_DIR/.env (referência) e o JWT_SECRET no unit systemd!"
fi


# 7. Configurar Nginx + SSL
echo ""
echo "🌐 Configurando Nginx + HTTPS..."
apt-get install -y nginx certbot python3-certbot-nginx

# 6. Criar serviço systemd (fonte da verdade do ambiente: o dashboard
#    lê process.env, NÃO .env — daí as variáveis irem em Environment=).
echo "⚙️ Criando serviço systemd ($SERVICE_NAME)..."
sudo tee "/etc/systemd/system/${SERVICE_NAME}.service" > /dev/null << EOF
[Unit]
Description=Chrome VPN Dashboard ($BASE_DOMAIN)
Documentation=https://github.com/faizalsalato/Chrome-VPN-Dashboard
After=network.target docker.service
Wants=docker.service

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=PORT=$PORT
Environment=DOMAIN=$BASE_DOMAIN
Environment=BASE_PORT=$BASE_PORT
Environment=MAX_INSTANCES=${MAX_INSTANCES:-20}
Environment=JWT_SECRET=${JWT_SECRET:-change-this-secret}
Environment=SESSION_EXPIRY=${SESSION_EXPIRY:-86400}
Environment=ADMIN_USER=${ADMIN_USER:-admin}
Environment=ADMIN_PASS=${ADMIN_PASS:-admin123}
Environment=NGINX_ENABLED=true
Environment=PROXY_INJECTOR_BASE_PORT=$PROXY_INJECTOR_BASE_PORT
Environment=CERTBOT_EMAIL=$EMAIL
# CloakBrowser / KasmVNC (tela + áudio) e envio de ficheiros
Environment=CLOAKBROWSER_IMAGE=cloakhq/cloakbrowser:latest
Environment=BROWSER_IMAGE=chrome-vpn-dashboard-browser:latest
Environment=KASM_PORT=9225
Environment=AUDIO_RATE=24000
Environment=AUDIO_CHANNELS=1
Environment=MAX_UPLOAD_BYTES=0
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=3
StandardOutput=append:/var/log/chrome-vpn-dashboard.log
StandardError=append:/var/log/chrome-vpn-dashboard.log

[Install]
WantedBy=multi-user.target
EOF

# 7. Ativar e iniciar
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"

# 2. Criar config Nginx para o dashboard (vhost raiz do painel)
echo "📝 Criando configuração Nginx..."
cat > /etc/nginx/sites-available/dashboard <<EOF
server {
    listen 80;
    server_name $BASE_DOMAIN;

    # Envio de ficheiros para o perfil da instância (botão ⬆ Enviar): SEM teto de
    # corpo — o padrão do nginx é 1 MB, que barrava até fotos. O pedido também
    # não é bufferizado: o ficheiro passa direto para o dashboard, que o grava
    # em streaming (o limite real é o espaço em disco).
    client_max_body_size 0;

    location / {
        proxy_pass http://localhost:$DASHBOARD_PORT;
        proxy_request_buffering off;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
EOF

# 3. Ativar site
ln -sf /etc/nginx/sites-available/dashboard /etc/nginx/sites-enabled/dashboard
rm -f /etc/nginx/sites-enabled/default

# 4. Testar e recarregar Nginx
nginx -t
systemctl reload nginx
echo "✅ Nginx configurado (HTTP)"

# 5. Obter certificado SSL com Let's Encrypt (painel + wildcard por
#    subdomínio NÃO é coberto aqui — cada instância pede o seu cert
#    quando é criada pelo dashboard).
echo "🔒 Obtendo certificado SSL..."
certbot --nginx -d "$BASE_DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect

# 4. MEMORIA SWAP (uma vez: repetir o install não recria o ficheiro)
if ! swapon --show | grep -q '/swapfile'; then
  if [ ! -f /swapfile ]; then
    sudo fallocate -l "${SWAP_SIZE:-12G}" /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
  fi
  sudo swapon /swapfile
fi
# A swap tem de voltar depois de um reboot.
grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab > /dev/null

echo ""
echo "✅ Dashboard instalado e rodando na porta $PORT!"
echo "📍 https://$BASE_DOMAIN"
echo ""
echo "Comandos úteis:"
echo "  systemctl status $SERVICE_NAME      # Ver status"
echo "  systemctl restart $SERVICE_NAME     # Reiniciar"
echo "  tail -f /var/log/chrome-vpn-dashboard.log   # Ver logs"
echo ""
echo "🔐 Login padrão: ${ADMIN_USER:-admin} / ${ADMIN_PASS:-admin123}"
echo "⚠️  TROQUE o JWT_SECRET e as credenciais em /etc/systemd/system/${SERVICE_NAME}.service"