# Dashboard Chrome/VPN/Proxy Manager

Dashboard web para gerenciamento de instâncias Chrome com **VPN** (Gluetun + Surfshark) ou **Proxy** (normal ou autenticado) em Docker.

## Funcionalidades

- **Criar/Remover instâncias** — Gluetun + Chrome (VPN) ou Chrome com proxy, com um clique
- **Modo VPN** — Gluetun + Chrome, com troca de país
- **Modo Proxy normal** — Chrome aponta direto para `host:porta` via `--proxy-server`
- **Modo Proxy autenticado** — Chrome aponta para um forwarder local que injeta `Proxy-Authorization` (compatível com proxies que exigem usuário/senha, ex.: Bright Data)
- **Start/Stop/Restart** — Controle individual de cada instância
- **Escolha de navegador** — Cada instância usa **Chromium** ou **Brave** (selecionado na criação)
- **Trocar país da VPN** — Recria o container com nova localização
- **Status em tempo real** — IP público, país (VPN) ou IP de saída do proxy, via geolocalização
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
| `PROXY_INJECTOR_BASE_PORT` | `8100` | Porta base dos forwarders de proxy autenticado (um por instância: `BASE+id`) |

## Modos de Conexão

Cada instância opera em um dos modos:

- **VPN** — Container `gluetun` (Wireguard/OpenVPN Surfshark) + `chrome`. O Chrome usa a rede do gluetun (`network_mode: container:gluetun`), então todo o tráfego sai pelo túnel. Suporta **troca de país**.
- **Proxy normal** — Apenas o container `chrome`, iniciado com `--proxy-server=http://host:porta`. Sem autenticação.
- **Proxy autenticado** — Apenas o container `chrome`. Como o Chrome headless não aceita `user:pass` no `--proxy-server`, o dashboard sobe um **forwarder TCP local** (`proxy-injector.service.js`) que recebe as conexões do Chrome (`host.docker.internal:porta`) e as repassa ao proxy real adicionando o cabeçalho `Proxy-Authorization`. O Chrome é iniciado com `--proxy-server=http://host.docker.internal:<porta-forwarder>`.

> O forwarder é iniciado/parado automaticamente junto com a instância (criação, start, stop e remoção).

## Navegadores (Chromium ou Brave)

Na criação da instância é possível escolher o navegador. Ambos usam imagens da LinuxServer.io com visualizador web (noVNC/Selkies) na porta 3000 e perfil em `/config`:

| | Chromium (padrão) | Brave |
|---|---|---|
| Imagem | `lscr.io/linuxserver/chromium:latest` | `lscr.io/linuxserver/brave:latest` |
| Variável de flags | `CHROME_CLI` | `BRAVE_CLI` |
| shm | 512MB | 1GB (recomendado pela doc oficial) |
| Coluna no DB | `browser = 'chromium'` | `browser = 'brave'` |

- **API**: envie `"browser": "brave"` (ou `"chromium"`) no `POST /api/instances`.
- O **fingerprint** e o **proxy** funcionam idênticos nos dois navegadores (a extensão é injetada em `/config/fp-extension` e carregada com `--load-extension`).
- A **troca de país da VPN** preserva o navegador escolhido.
- O card exibe o badge do navegador (🦁 Brave / 🌀 Chromium).

## Provedores VPN (Surfshark / ExpressVPN)

Cada instância VPN usa um dos provedores suportados pelo Gluetun (OpenVPN):

| | Surfshark (padrão) | ExpressVPN |
|---|---|---|
| `VPN_SERVICE_PROVIDER` | `surfshark` | `expressvpn` |
| Credenciais | `OPENVPN_USER` / `OPENVPN_PASSWORD` (conta Surfshark) | `OPENVPN_USER` / `OPENVPN_PASSWORD` (credenciais OpenVPN da ExpressVPN) |
| Servidores | `SERVER_COUNTRIES` | `SERVER_COUNTRIES` (também aceita `SERVER_CITIES`) |

- **Menu "Credenciais VPN"** (botão 🔑 na barra de ações): salve usuário/senha OpenVPN de cada provedor. A senha é **mascarada** (nunca retornada pela API). Salvar = **push para o banco** do dashboard (`vpn_credentials`).
- As credenciais legadas continuam como **fallback** até você salvar as novas.
- **API**: `GET /api/vpn-credentials` (status por provedor) e `PUT /api/vpn-credentials/:provider` (`{"username","password"}`).
- Na criação: seletor **"Provedor VPN"** (Surfshark/ExpressVPN); o card exibe o badge 🦈 Surfshark / 🛡️ ExpressVPN.
- A **troca de país** preserva provedor, navegador e fingerprint.

## Biblioteca de Proxies (🔌)

O menu **"Proxies"** (botão 🔌 na barra de ações) é uma biblioteca de proxies reutilizáveis, igual ao menu de Credenciais VPN:

- **Cadastrar/editar/remover** proxies (nome, host, porta, esquema HTTP/SOCKS, usuário/senha). A senha é **mascarada** (nunca retornada na listagem — só `hasPassword`).
- **Escolher na criação**: ao criar uma instância do tipo Proxy, o campo **"Proxy salvo"** lista os proxies cadastrados e **preenche automaticamente** host/porta/usuário/senha (inclusive o modo autenticado).
- **API**: `GET/POST/PUT/DELETE /api/proxies` e `GET /api/proxies/:id/full` (com senha, uso interno na criação).

### 🧪 Testar proxy (live/morto + geolocalização)

Cada proxy tem um botão **"🧪 Testar"** (na lista e no formulário de cadastro) que faz uma **requisição real através do proxy** e retorna:

| Campo | Descrição |
|---|---|
| **Status** | ● LIVE (verde) ou ● MORTO (vermelho) |
| **Latência** | tempo de resposta em ms |
| **IP** | IP de saída (exit node) |
| **País / Bandeira** | país + bandeira (via `countryCode`) |
| **Região / Cidade / CEP** | subdivisão do IP |
| **Coordenadas** | latitude / longitude |
| **Fuso horário** | timezone do IP |
| **ISP / Org / AS** | operadora e ASN |
| **Erro** | motivo quando MORTO (ex.: `ECONNREFUSED`, timeout, auth 407) |

- **API de teste**: `POST /api/proxies/test` (proxy informado no corpo) e `POST /api/proxies/:id/test` (proxy já salvo, busca credenciais no banco).
- A geolocalização usa **ip-api.com** com **retry automático** em caso de rate-limit (limite do plano gratuito).


## Perfis e Fingerprint (antidetect, estilo GoLogin)

Cada instância funciona como um **perfil de navegador** com identidade própria:

- **Fingerprint determinístico por perfil** — gerado a partir do id da instância (`fingerprint.service.js`): userAgent/platform, resolução de tela, timezone, idioma, hardwareConcurrency, deviceMemory e WebGL (vendor/renderer). O mesmo perfil sempre mantém a mesma identidade entre sessões.
- **Injeção via extensão MV3** — a extensão em `src/fingerprint-extension/` (content script com `world: "MAIN"`, `document_start`) sobrescreve `navigator`, `screen` e WebGL no mundo da página. Ela é injetada no container via `docker putArchive` (funciona com container parado) em `/config/fp-extension` e carregada com `--load-extension` no `CHROME_CLI`.
- **Persistência** — o fingerprint é salvo como JSON na coluna `fingerprint` da tabela `instances` e **re-injetado automaticamente** a cada start/restart (idempotente).
- **API** — no `POST /api/instances` é possível enviar um objeto `fingerprint` parcial (ex.: `{"timezone": "Europe/Lisbon"}`) para sobrescrever campos específicos; os demais continuam determinísticos.
- **UI** — o card da instância exibe OS, resolução, timezone e idioma do perfil.

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
│       ├── vpn.service.js     # Status VPN via IP geolocation
│       └── proxy-injector.service.js # Forwarder TCP p/ proxy autenticado
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
- `POST /api/instances` — Criar nova
  - **VPN**: body `{ "type": "vpn", "country": "Germany" }`
  - **Proxy normal**: body `{ "type": "proxy", "proxy": { "host": "1.2.3.4", "port": 8080, "scheme": "http", "auth": false } }`
  - **Proxy autenticado**: body `{ "type": "proxy", "proxy": { "host": "brd.superproxy.io", "port": 44445, "user": "...", "pass": "...", "scheme": "http", "auth": true } }`
- `DELETE /api/instances/:id` — Remover
- `POST /api/instances/:id/start` — Iniciar
- `POST /api/instances/:id/stop` — Parar
- `POST /api/instances/:id/restart` — Reiniciar
- `POST /api/instances/:id/country` — Trocar país (apenas VPN; body: `{ country }`)
- `GET /api/instances/:id/vpn` — Info VPN/proxy (IP e país de saída)

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
