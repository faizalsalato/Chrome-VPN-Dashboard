#!/bin/bash
# ============================================================
# install.sh — Instala o Dashboard direto no servidor Ubuntu
# Usage: bash install.sh
# ============================================================

set -e

echo "🚀 Instalando Dashboard Chrome/VPN..."

# 1. Instalar Node.js 20 se não tiver
if ! command -v node &> /dev/null || [[ $(node -v | cut -d. -f1 | tr -d 'v') -lt 20 ]]; then
  echo "📦 Instalando Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "✅ Node.js $(node -v)"

# 2. Criar diretório da aplicação
APP_DIR="/opt/dashboard"
sudo mkdir -p $APP_DIR
sudo cp -r . $APP_DIR/
cd $APP_DIR

# 3. Instalar dependências
echo "📦 Instalando dependências..."
sudo npm install --production

# 4. Criar diretório de dados
sudo mkdir -p /opt/dashboard/data

# 5. Criar arquivo de ambiente
if [ ! -f /opt/dashboard/.env ]; then
  cat > /opt/dashboard/.env << 'EOF'
DOMAIN=sakaru.pro
BASE_PORT=3001
MAX_INSTANCES=20
JWT_SECRET=troque-este-segredo-agora
SESSION_EXPIRY=86400
ADMIN_USER=admin
ADMIN_PASS=admin123
NODE_ENV=production
EOF
  echo "⚠️  Edite /opt/dashboard/.env para trocar o JWT_SECRET!"
fi

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
