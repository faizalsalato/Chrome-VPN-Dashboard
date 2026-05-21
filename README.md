# Dashboard Chrome/VPN Manager

Dashboard web para gerenciamento de instâncias Chrome com VPN (Gluetun + Surfshark) em Docker.

## Funcionalidades

- **Criar/Remover instâncias** — Gluetun + Chrome com um clique
- **Start/Stop/Restart** — Controle individual de cada instância
- **Trocar país da VPN** — Recria o container com nova localização
- **Status VPN em tempo real** — IP público e país via geolocalização
- **HTTPS automático** — Nginx + Let's Encrypt por subdomínio
- **Autenticação JWT** — Login com rate limiting (5 tentativas/5 min)
- **Interface responsiva** — Tema escuro, funciona em mobile

## Requisitos

- Ubuntu 20.04+
- Docker instalado
- Nginx instalado
- Certbot instalado (`apt install certbot python3-certbot-nginx`)
- Node.js 20+
- DNS wildcard `*.sakr.ath.cx` apontando para o servidor

## Instalação Rápida

```bash
cd /root/dash
chmod +x install-and-run.sh setup-nginx.sh
./install-and-run.sh
```

## Instalação Manual

```bash
# 1. Instalar dependências
apt install -y nginx certbot python3-certbot-nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# 2. Instalar pacotes npm
cd /root/dash
npm install --production

# 3. Criar pasta de dados
mkdir -p data

# 4. Abrir portas no firewall
ufw allow 80
ufw allow 443

# 5. Rodar
export DOMAIN=sakr.ath.cx
export JWT_SECRET=$(openssl rand -hex 32)
node src/server.js
```

## Variáveis de Ambiente

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `DOMAIN` | `sakr.ath.cx` | Domínio base para subdomínios |
| `BASE_PORT` | `3001` | Porta inicial para instâncias |
| `MAX_INSTANCES` | `20` | Máximo de instâncias permitidas |
| `JWT_SECRET` | `super-secret-change-me` | Segredo para tokens JWT |
| `SESSION_EXPIRY` | `86400` | Expiração da sessão (segundos) |
| `ADMIN_USER` | `admin` | Usuário padrão |
| `ADMIN_PASS` | `admin123` | Senha padrão |
| `CERTBOT_EMAIL` | `admin@DOMAIN` | Email para Let's Encrypt |

## Acesso

- **URL**: `http://IP_DO_SERVIDOR:3100` (ou via Nginx/Cloudflared)
- **Login**: `admin` / `admin123`

## Estrutura

```
dashboard/
├── src/
│   ├── server.js              # Express (porta 3100)
│   ├── database.js            # SQLite
│   ├── middleware/
│   │   └── auth.middleware.js # JWT verification
│   ├── routes/
│   │   ├── auth.router.js     # Login/logout/verify
│   │   └── instances.router.js # CRUD instâncias
│   └── services/
│       ├── auth.service.js    # JWT + rate limiting
│       ├── docker.service.js  # Gerenciamento containers
│       ├── instance.service.js # Orquestrador
│       ├── nginx.service.js   # Config Nginx + SSL
│       └── vpn.service.js     # Status VPN via IP geolocation
├── public/
│   ├── index.html             # Dashboard
│   ├── login.html             # Login
│   ├── css/styles.css         # Tema escuro responsivo
│   └── js/                    # Frontend SPA
├── data/                      # SQLite (auto-criado)
├── package.json
├── Dockerfile
├── install-and-run.sh
└── setup-nginx.sh
```

## API Endpoints

### Autenticação
- `POST /api/auth/login` — Login (retorna JWT)
- `POST /api/auth/logout` — Logout
- `GET /api/auth/verify` — Verificar token

### Instâncias (requer JWT)
- `GET /api/instances` — Listar todas
- `POST /api/instances` — Criar nova (body: `{ country }`)
- `DELETE /api/instances/:id` — Remover
- `POST /api/instances/:id/start` — Iniciar
- `POST /api/instances/:id/stop` — Parar
- `POST /api/instances/:id/restart` — Reiniciar
- `POST /api/instances/:id/country` — Trocar país (body: `{ country }`)
- `GET /api/instances/:id/vpn` — Info VPN

## Rodar em Background

```bash
nohup node src/server.js > /tmp/dashboard.log 2>&1 &
```

## Rodar com systemd

```bash
cat > /etc/systemd/system/dashboard.service << EOF
[Unit]
Description=Chrome/VPN Dashboard
After=network.target docker.service

[Service]
Type=simple
WorkingDirectory=/root/dash
Environment=DOMAIN=sakr.ath.cx
Environment=JWT_SECRET=$(openssl rand -hex 32)
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable dashboard
systemctl start dashboard
```

## Países Disponíveis

United States, United Kingdom, Canada, Germany, France, Netherlands, Switzerland, Japan, Singapore, Australia, Brazil, Italy, Spain, Sweden, Norway, Poland, India, South Korea, Mexico, Portugal
