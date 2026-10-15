#!/usr/bin/env bash
# Configura o nginx para servir o dashboard em sakr.ath.cx SOMENTE por HTTP (80).
# O HTTPS fica desativado por enquanto (o redirect e o bloco 443 foram removidos).
# Mantemos o challenge do Let's Encrypt para poder ativar o cert depois.
set -e

cat > /etc/nginx/sites-available/dashboard <<'CONF'
# Chrome VPN Dashboard - sakr.ath.cx
# Dashboard (Node.js) em 127.0.0.1:3100
# Servido por HTTP (80). HTTPS desativado por enquanto.

server {
    listen 80;
    listen [::]:80;
    server_name sakr.ath.cx www.sakr.ath.cx;

    # Envio de ficheiros para o perfil da instância: SEM teto de corpo. O padrão
    # do nginx é 1 MB, que barrava até fotos — o limite real passa a ser o espaço
    # em disco do servidor (o dashboard escreve o ficheiro em streaming).
    client_max_body_size 0;

    # Let's Encrypt HTTP-01 challenge (fica pronto para ativar o cert depois)
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    # Websockets + proxy reverso para o dashboard Node.js
    location / {
        proxy_pass         http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host       $host;
        proxy_set_header   X-Real-IP  $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout  3600s;
        proxy_send_timeout  3600s;
    }
}
CONF

ln -sf /etc/nginx/sites-available/dashboard /etc/nginx/sites-enabled/dashboard

echo '=== nginx -t ==='
nginx -t 2>&1 | grep -vE 'conflicting server name' || true

echo '=== restart ==='
nginx -s stop 2>/dev/null || true
sleep 1
pkill -9 nginx 2>/dev/null || true
sleep 1
nginx
sleep 2

echo '=== teste HTTP (Host: sakr.ath.cx) ==='
curl -s --max-time 6 -o /dev/null -w 'HTTP:%{http_code} type:%{content_type} len:%{size_download}\n' \
  -H 'Host: sakr.ath.cx' http://127.0.0.1/
curl -s --max-time 6 -H 'Host: sakr.ath.cx' http://127.0.0.1/ | grep -o '<title>[^<]*</title>' | head -1

