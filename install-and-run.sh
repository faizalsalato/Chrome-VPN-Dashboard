#!/bin/bash
# ============================================================
# install-and-run.sh — Instala e roda o Dashboard
# Domínio: sakr.ath.cx (HTTPS via Nginx + Let's Encrypt)
# ============================================================

set -e

#DASHBOARD_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=3100
DOMAIN="saske.ath.cx"
DASHBOARD_PORT=3100
EMAIL="${1:-admin@$DOMAIN}"

echo "🚀 Dashboard Chrome/VPN - Instalação e Deploy"
echo "================================================"

# 1. Instalar Node.js se não tiver
if ! command -v node &> /dev/null; then
  echo "📦 Instalando Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "✅ Node.js $(node --version)"

# 2. Criar diretório da aplicação
APP_DIR="/opt/dashboard"
sudo mkdir -p $APP_DIR
sudo cp -r . $APP_DIR/
cd $APP_DIR

# 2. Instalar dependências do projeto
echo "📦 Instalando dependências npm..."
npm install --production 2>/dev/null

# 3. Criar diretório de dados
mkdir -p "$APP_DIR/data"

# 4. Matar processos anteriores se existirem
pkill -f "node src/server.js" 2>/dev/null || true
sleep 1


# 5. Criar arquivo de ambiente
if [ ! -f /opt/dashboard/.env ]; then
  cat > /opt/dashboard/.env << EOF
DOMAIN=$DOMAIN
BASE_PORT=${BASE_PORT:-3001}
MAX_INSTANCES=${MAX_INSTANCES:-20}
JWT_SECRET=${JWT_SECRET:-$(openssl rand -hex 32)}
SESSION_EXPIRY=${SESSION_EXPIRY:-86400}
ADMIN_USER=${ADMIN_USER:-sakaru}
ADMIN_PASS=${ADMIN_PASS:-sakaru}
NODE_ENV=production
EOF

  echo "⚠️  Edite /opt/dashboard/.env para trocar o JWT_SECRET!"
fi


# 7. Configurar Nginx + SSL
echo ""
echo "🌐 Configurando Nginx + HTTPS..."
apt-get install -y nginx certbot python3-certbot-nginx docker-compose

# 6. Criar serviço systemd
echo "⚙️ Criando serviço systemd..."
sudo tee /etc/systemd/system/dashboard.service > /dev/null << 'EOF'
[Unit]
Description=Chrome/VPN Dashboard
After=network.target docker.service nginx.service
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=/opt/dashboard
EnvironmentFile=/opt/dashboard/.env
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
EOF

# 7. Ativar e iniciar
sudo systemctl daemon-reload
sudo systemctl enable dashboard
sudo systemctl restart dashboard

# 2. Criar config Nginx para o dashboard
echo "📝 Criando configuração Nginx..."
cat > /etc/nginx/sites-available/dashboard <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://localhost:$DASHBOARD_PORT;
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

# 5. Obter certificado SSL com Let's Encrypt
echo "🔒 Obtendo certificado SSL..."
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect

# 4. MEMORIA SWAP
sudo fallocate -l 12G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

echo ""
echo "✅ Dashboard instalado e rodando na porta 3100!"
echo "📍 http://localhost:3100"
echo ""
echo "Comandos úteis:"
echo "  systemctl status dashboard    # Ver status"
echo "  systemctl restart dashboard   # Reiniciar"
echo "  journalctl -u dashboard -f    # Ver logs"
echo ""
echo "🔐 Login padrão: admin / admin123"