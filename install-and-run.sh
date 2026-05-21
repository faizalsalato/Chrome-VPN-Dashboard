#!/bin/bash
# ============================================================
# install-and-run.sh — Instala e roda o Dashboard
# Domínio: sakr.ath.cx (HTTPS via Nginx + Let's Encrypt)
# ============================================================

set -e

DASHBOARD_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=3100
DOMAIN="sakr.ath.cx"

echo "🚀 Dashboard Chrome/VPN - Instalação e Deploy"
echo "================================================"

# 1. Instalar Node.js se não tiver
if ! command -v node &> /dev/null; then
  echo "📦 Instalando Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "✅ Node.js $(node --version)"

# 2. Instalar dependências do projeto
echo "📦 Instalando dependências npm..."
cd "$DASHBOARD_DIR"
npm install --production 2>/dev/null

# 3. Criar diretório de dados
mkdir -p "$DASHBOARD_DIR/data"

# 4. Matar processos anteriores se existirem
pkill -f "node src/server.js" 2>/dev/null || true
sleep 1

# 5. Configurar variáveis de ambiente
export DOMAIN="$DOMAIN"
export BASE_PORT="${BASE_PORT:-3001}"
export MAX_INSTANCES="${MAX_INSTANCES:-20}"
export JWT_SECRET="${JWT_SECRET:-$(openssl rand -hex 32)}"
export SESSION_EXPIRY="${SESSION_EXPIRY:-86400}"
export ADMIN_USER="${ADMIN_USER:-admin}"
export ADMIN_PASS="${ADMIN_PASS:-admin123}"
export NODE_ENV=production

# 6. Iniciar o dashboard em background
echo "🖥️  Iniciando dashboard na porta $PORT..."
cd "$DASHBOARD_DIR"
nohup node src/server.js > /tmp/dashboard.log 2>&1 &
DASHBOARD_PID=$!
sleep 2

# Verificar se iniciou
if ! kill -0 $DASHBOARD_PID 2>/dev/null; then
  echo "❌ Falha ao iniciar dashboard. Log:"
  cat /tmp/dashboard.log
  exit 1
fi

echo "✅ Dashboard rodando (PID: $DASHBOARD_PID)"

# 7. Configurar Nginx + SSL
echo ""
echo "🌐 Configurando Nginx + HTTPS..."
bash "$DASHBOARD_DIR/setup-nginx.sh"

echo ""
echo "================================================"
echo "🎉 DASHBOARD PRONTO!"
echo "================================================"
echo ""
echo "🔗 URL: https://$DOMAIN"
echo ""
echo "👤 Login: ${ADMIN_USER} / ${ADMIN_PASS}"
echo ""
echo "================================================"
echo "PID Dashboard: $DASHBOARD_PID"
echo "Para parar: kill $DASHBOARD_PID"
echo "Logs: /tmp/dashboard.log"
echo "================================================"
