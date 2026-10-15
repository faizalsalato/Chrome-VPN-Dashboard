#!/bin/bash
# ============================================================
# install-and-run.sh — Instala e roda o Dashboard
# Domínio: perguntado na instalação (ou --domain / BASE_DOMAIN)
#
# Cada instância de navegador ganha um subdomínio próprio
# (<slug>.<BASE_DOMAIN>) com vhost de nginx gerado pelo próprio
# dashboard (src/services/nginx.service.js) — este script só
# prepara o painel (o vhost raiz) e o serviço systemd.
#
#   ./install-and-run.sh                      # pergunta o domínio
#   ./install-and-run.sh --domain exemplo.com # sem interação
#   BASE_DOMAIN=exemplo.com ./install-and-run.sh
# ============================================================

set -e

# --- Parâmetros (flag, variável de ambiente ou pergunta) --------
# Ordem de precedência: flag (--domain) > ambiente (BASE_DOMAIN) > pergunta.
# Sem nada disso e com terminal, o script PERGUNTA o domínio (e o email do
# certificado); num pipeline (CI, cloud-init) ele usa o que veio do ambiente
# em vez de ficar preso à espera de alguém.
BASE_DOMAIN="${BASE_DOMAIN:-}"
EMAIL_ARG=""
ADMIN_USER_ARG=""
ADMIN_PASS_ARG=""
SENHA_GERADA=0
ASSUME_YES="${ASSUME_YES:-0}"

while [ $# -gt 0 ]; do
  case "$1" in
    --domain)    BASE_DOMAIN="${2:-}"; shift 2 2>/dev/null || shift ;;
    --domain=*)  BASE_DOMAIN="${1#*=}"; shift ;;
    --email)     EMAIL_ARG="${2:-}"; shift 2 2>/dev/null || shift ;;
    --email=*)   EMAIL_ARG="${1#*=}"; shift ;;
    --admin-user)    ADMIN_USER_ARG="${2:-}"; shift 2 2>/dev/null || shift ;;
    --admin-user=*)  ADMIN_USER_ARG="${1#*=}"; shift ;;
    --admin-pass)    ADMIN_PASS_ARG="${2:-}"; shift 2 2>/dev/null || shift ;;
    --admin-pass=*)  ADMIN_PASS_ARG="${1#*=}"; shift ;;
    --yes|-y)    ASSUME_YES=1; shift ;;
    --help|-h)
      cat <<'AJUDA'
Uso: install-and-run.sh [opções] [email]

  --domain exemplo.com     Domínio do painel (as instâncias ficam em
                           chrome1.exemplo.com, chrome2.exemplo.com…)
  --email  eu@exemplo.com  Email do certificado (Let's Encrypt)
  --admin-user nome        Login do painel (padrão: admin)
  --admin-pass senha       Senha do painel (padrão: pergunta; sem terminal,
                           gera uma aleatória e mostra no fim)
  --yes, -y                Não pedir confirmação no fim
  --help, -h               Esta ajuda

Sem --domain, o script pergunta (ou usa BASE_DOMAIN do ambiente).
AJUDA
      exit 0 ;;
    -*) echo "Opção desconhecida: $1 (use --help)"; exit 1 ;;
    *)  EMAIL_ARG="$1"; shift ;;   # compatibilidade: 1º argumento era o email
  esac
done

# Tudo aqui mexe em apt, systemd e nginx: sem root o script para no meio.
if [ "$(id -u)" != "0" ]; then
  echo "❌ Rode como root (ex.: sudo -i, depois ./install-and-run.sh)."
  echo "   O script instala pacotes, cria o serviço systemd e configura o nginx."
  exit 1
fi

# Domínio: rótulos com letras/números/hífen, separados por ponto, com pelo
# menos um ponto e uma extensão de 2+ letras. Nada de http://, barras, espaços
# ou ponto final (o certificado do Let's Encrypt recusaria).
valid_domain() {
  printf '%s' "$1" | grep -Eq '^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$'
}

valid_email() {
  printf '%s' "$1" | grep -Eq '^[^@[:space:]]+@([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$'
}

# Usuário do painel: 3 a 32 caracteres, começando por letra/número (evita
# nomes que confundem o systemd ou o formulário de login).
valid_user() {
  printf '%s' "$1" | grep -Eq '^[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$'
}

# Senha do painel: 8+ caracteres, sem espaços nem dois-pontos. O `Environment=`
# do systemd termina a linha no espaço e usa `:` para o valor por omissão —
# uma senha com qualquer um dos dois quebraria a unit.
valid_pass() {
  case "$1" in
    *[[:space:]]*|*:*) return 1 ;;
  esac
  [ ${#1} -ge 8 ]
}

if [ -z "$BASE_DOMAIN" ]; then
  if [ ! -t 0 ]; then
    echo "❌ Domínio não informado. Use: BASE_DOMAIN=exemplo.com $0  (ou --domain exemplo.com)"
    exit 1
  fi

  echo "🌐 Domínio do painel"
  echo "   O painel fica neste domínio e cada instância ganha um subdomínio"
  echo "   (chrome1.<domínio>, chrome2.<domínio>…). O DNS já precisa de apontar"
  echo "   para este servidor — o certificado do Let's Encrypt é pedido agora."
  echo

  while true; do
    # Sem `read` a funcionar (Ctrl-D, pipe sem dados) o laço giraria para sempre:
    # melhor sair com uma mensagem do que ficar a queimar CPU.
    if ! read -r -p "   Domínio (ex: exemplo.com): " BASE_DOMAIN; then
      echo
      echo "❌ Entrada encerrada sem domínio informado."
      exit 1
    fi
    if valid_domain "$BASE_DOMAIN"; then break; fi
    echo "   ✗ Domínio inválido. Escreva só o domínio — sem http://, sem barras, sem espaços."
  done
fi

if ! valid_domain "$BASE_DOMAIN"; then
  echo "❌ Domínio inválido: \"$BASE_DOMAIN\""
  exit 1
fi

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

# Email do certificado: flag > ambiente > pergunta (com admin@<domínio> já
# preenchido, é só Enter na maioria dos casos).
EMAIL="${EMAIL_ARG:-${EMAIL:-}}"
if [ -z "$EMAIL" ]; then
  # A sugestão fica FIXA: se ela fosse substituída pelo que o usuário digitou,
  # um email inválido viraria o novo "padrão" e o laço nunca sairia dele.
  sugestao="admin@$BASE_DOMAIN"

  if [ -t 0 ]; then
    echo
    echo "📧 Email do certificado (o Let's Encrypt avisa aqui antes de expirar)"
    while true; do
      if ! read -r -p "   Email [$sugestao]: " resposta_email; then
        echo
        echo "❌ Entrada encerrada sem email informado."
        exit 1
      fi
      EMAIL="${resposta_email:-$sugestao}"
      if valid_email "$EMAIL"; then break; fi
      echo "   ✗ Email inválido."
    done
  else
    EMAIL="$sugestao"
  fi
fi

# Login do painel: é o usuário que o dashboard cria no primeiro arranque (vai no
# unit do systemd, que é a fonte do ambiente do serviço).
ADMIN_USER="${ADMIN_USER_ARG:-${ADMIN_USER:-}}"
if [ -z "$ADMIN_USER" ]; then
  ADMIN_USER="admin"
  if [ -t 0 ]; then
    echo
    echo "👤 Login do painel"
    while true; do
      if ! read -r -p "   Usuário [$ADMIN_USER]: " resposta_user; then
        echo
        echo "❌ Entrada encerrada sem usuário informado."
        exit 1
      fi
      ADMIN_USER="${resposta_user:-$ADMIN_USER}"
      if valid_user "$ADMIN_USER"; then break; fi
      echo "   ✗ Usuário inválido (3–32 caracteres: letras, números, . _ -)."
    done
  fi
fi

if ! valid_user "$ADMIN_USER"; then
  echo "❌ Usuário inválido: \"$ADMIN_USER\""
  exit 1
fi

# Senha do painel: digitada duas vezes e sem eco. Sem terminal (CI, cloud-init)
# é gerada uma aleatória — melhor do que deixar `admin123` num servidor exposto.
ADMIN_PASS="${ADMIN_PASS_ARG:-${ADMIN_PASS:-}}"
if [ -z "$ADMIN_PASS" ]; then
  if [ -t 0 ]; then
    echo
    echo "🔑 Senha do painel (não aparece enquanto digita)"
    while true; do
      if ! read -r -s -p "   Senha (8+ caracteres): " senha1; then
        echo
        echo "❌ Entrada encerrada sem senha informada."
        exit 1
      fi
      echo
      if ! valid_pass "$senha1"; then
        echo "   ✗ Senha curta demais (mínimo 8) ou com espaço/dois-pontos."
        continue
      fi

      if ! read -r -s -p "   Repita a senha: " senha2; then
        echo
        echo "❌ Entrada encerrada sem senha informada."
        exit 1
      fi
      echo
      if [ "$senha1" != "$senha2" ]; then
        echo "   ✗ As senhas não conferem. Vamos de novo."
        continue
      fi

      ADMIN_PASS="$senha1"
      break
    done
  else
    ADMIN_PASS="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)"
    SENHA_GERADA=1
  fi
fi

if ! valid_pass "$ADMIN_PASS"; then
  echo "❌ Senha inválida: use 8+ caracteres, sem espaços nem dois-pontos."
  exit 1
fi

echo "🚀 Dashboard Chrome/VPN - Instalação e Deploy"
echo "================================================"
echo "   Domínio : $BASE_DOMAIN"
echo "   Email   : $EMAIL"
echo "   Painel  : porta $PORT  |  instâncias: $BASE_PORT+id"
echo "   Login   : $ADMIN_USER / $ADMIN_PASS"
if [ "$SENHA_GERADA" = "1" ]; then
  echo "   ⚠️  Senha gerada agora — guarde-a: não é mostrada outra vez."
fi
echo

# Última chance de corrigir o domínio antes de mexer no nginx e no certbot.
if [ "$ASSUME_YES" != "1" ] && [ -t 0 ]; then
  read -r -p "   Continuar? [S/n] " resposta || true
  case "$resposta" in
    n|N|nao|não|Não|NAO|NÃO) echo "Cancelado."; exit 0 ;;
  esac
fi

# 1. Instalar Node.js se não tiver
if ! command -v node &> /dev/null; then
  echo "📦 Instalando Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "✅ Node.js $(node --version)"

# 2. Docker: o dashboard cria containers (navegador, gluetun) e fala com o
#    Docker do HOST — sem ele o painel sobe, mas nenhuma instância é criada.
if command -v docker &> /dev/null && docker info &> /dev/null; then
  echo "✅ Docker $(docker --version | cut -d' ' -f3 | tr -d ',')"
else
  echo "📦 Instalando Docker..."
  if curl -fsSL https://get.docker.com | sh; then
    systemctl enable --now docker >/dev/null 2>&1 || true
    sleep 3
    if docker info &> /dev/null; then
      echo "✅ Docker $(docker --version | cut -d' ' -f3 | tr -d ',')"
    else
      echo "⚠️  Docker instalado, mas o daemon não responde: verifique 'systemctl status docker'."
    fi
  else
    echo "⚠️  Não consegui instalar o Docker automaticamente."
    echo "    Instale à mão (https://docs.docker.com/engine/install/) e rode este script de novo."
  fi
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
  # O .env tem o JWT e a senha do painel: só o root lê.
  chmod 600 "$APP_DIR/.env"
fi


# 7. Configurar Nginx + SSL
echo ""
echo "🌐 Configurando Nginx + HTTPS..."
apt-get install -y nginx certbot python3-certbot-nginx openssl curl

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
# O unit carrega o JWT e a senha do painel em Environment=: fica 600 (só root).
sudo chmod 600 "/etc/systemd/system/${SERVICE_NAME}.service"
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

# Firewall: se o ufw estiver ativo, 80/443 têm de estar liberados — senão o
# certificado não é emitido e o painel não responde de fora. O script NÃO mexe
# nas regras do firewall (isso é decisão de quem administra o servidor).
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
  echo "ℹ️  ufw ativo — confirme que 80 e 443 estão liberados:"
  echo "    ufw allow 80/tcp && ufw allow 443/tcp"
fi

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
echo "🔐 Login do painel: ${ADMIN_USER} / ${ADMIN_PASS}"
echo "⚠️  Para trocar depois: edite /etc/systemd/system/${SERVICE_NAME}.service e remova o usuário do banco (o dashboard só cria o login na primeira vez que arranca)."