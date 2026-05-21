#!/bin/bash
# ============================================================
# setup-nginx.sh — Configura Nginx + SSL (Let's Encrypt) para o Dashboard
# Domínio: sakr.ath.cx
# ============================================================

set -e

DOMAIN="sakr.ath.cx"
DASHBOARD_PORT=3100
EMAIL="${1:-admin@$DOMAIN}"

echo "🌐 Configurando Nginx + HTTPS para $DOMAIN"
echo "================================================"

# 1. Instalar Nginx e Certbot
echo "📦 Instalando Nginx e Certbot..."
apt-get update
apt-get install -y nginx certbot python3-certbot-nginx

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

echo ""
echo "================================================"
echo "🎉 HTTPS CONFIGURADO!"
echo "================================================"
echo ""
echo "🔗 https://$DOMAIN"
echo ""
echo "O certificado renova automaticamente via certbot."
echo "================================================"
