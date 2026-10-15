# Dashboard Chrome/VPN/Proxy Manager

Dashboard web para gerenciamento de instâncias Chrome com **VPN** (Gluetun + Surfshark) ou **Proxy** (normal ou autenticado) em Docker.

## Funcionalidades

- **Criar/Remover instâncias** — Gluetun + Chrome (VPN) ou Chrome com proxy, com um clique
- **Modo VPN** — Gluetun + Chrome, com troca de país
- **Modo Proxy normal** — Chrome aponta direto para `host:porta` via `--proxy-server`
- **Modo Proxy autenticado** — Chrome aponta para um forwarder local que injeta `Proxy-Authorization` (compatível com proxies que exigem usuário/senha, ex.: Bright Data)
- **Start/Stop/Restart** — Controle individual de cada instância
- **Escolha de navegador** — Cada instância usa **Chromium** ou **CloakBrowser** (selecionado na criação). O Brave saiu das opções; uma instância antiga gravada como `brave` continua a funcionar
- **Página inicial Google** — Todas as instâncias abrem no **Google** (padrão; muda com a env `BROWSER_HOME_URL`). Antes o CloakBrowser subia em `about:blank`, ou seja, tela em branco sem caixa de busca
- **Motor de busca padrão (Google)** — O CloakBrowser não traz o Google na lista de motores que compila (tem Bing/DuckDuckGo/Ecosia): sem motor padrão, escrever uma palavra na barra de endereços **não pesquisa** — ela é tratada como endereço e dá erro de DNS. O container instala o Google por **política gerida** (`/etc/chromium/policies/managed/dashboard.json`), que vale para perfis novos e já existentes (a preferência do perfil é protegida pelo Chromium e é descartada). Muda com `BROWSER_SEARCH_NAME` / `BROWSER_SEARCH_URL`. A mesma política **desliga o DNS-over-HTTPS** (`DnsOverHttpsMode: off`) e a **pré-busca de rede** (`NetworkPredictionOptions: 2`, mais `--dns-prefetch-disable`): sem isso o nome é resolvido por HTTPS no resolver público do Google — que o whoer vê noutro país e **desconta 30% da nota de anonimato**. Com a política, quem resolve é o proxy/VPN da instância: o DNS acompanha o IP de saída
- **CloakBrowser (antidetect)** — Navegador com os patches de fingerprint aplicados no próprio binário: a **tela** abre pelo cliente web do **KasmVNC** (dentro da própria imagem, com **som**) e a **automação** conecta por **CDP** (Playwright/Puppeteer)
- **Versão do CloakBrowser por instância** — Cada instância escolhe a versão **antiga (sem chave)** — o binário que vem na imagem, uma sessão em paralelo — ou a **nova (com licença)**: aí o container baixa o **binário mais recente** do vendor com a chave da biblioteca (é para esse que a licença Pro vale) e guarda-o num **volume partilhado** (`cloakbrowser-bin`), por isso o download acontece uma vez e não a cada recriação. Sem chave válida o download falha e o binário da imagem é usado na mesma. As chaves gerem-se no menu **Chaves CloakBrowser** (várias chaves; cada instância recebe a menos carregada). O botão **🔎 Verificar** desse menu pergunta ao vendor o plano, o prazo e os lugares em uso de cada chave — o prazo aparece destacado quando faltam 7 dias ou menos (e a vermelho quando já passou). O botão **⬆ Atualizar** atualiza o binário Pro para a versão mais recente do vendor **quando existir**: o wrapper (`cloakbrowser update`) só baixa se a versão resolvida for diferente da que está em cache — sem versão nova responde "já está na versão mais recente" e **nada é recriado**. Quando baixa, as instâncias Pro que estão a correr são recriadas com o binário novo (o perfil, os cookies e os logins ficam); as paradas apanham-no sozinhas no próximo start.
- **Marcadores semeados no perfil** — Todo perfil abre com os mesmos atalhos na barra de marcadores: **Webmail** (`mail.rota.ath.cx`) e **Rubilax** diretos, e as pastas **Verificação** (IPinfo «qual é o meu IP» e Whoer) e **Redes sociais** (Facebook, Instagram, X, YouTube, TikTok, WhatsApp Web, Telegram Web, LinkedIn, Reddit, Pinterest) — nos três navegadores. O arquivo `Bookmarks` é escrito **antes de o navegador arrancar** e o merge é idempotente: **nunca apaga nem reordena** o que o usuário guardou, só acrescenta o que falta (pelo URL); um arquivo ilegível não é tocado. Cada navegador tem a sua pasta (`/profile/Default` no CloakBrowser; o perfil padrão da LinuxServer no Chromium/Brave) e o ficheiro nasce com o dono certo. A lista muda em `src/services/bookmarks.service.js`
- **Trocar país da VPN** — Recria o container com nova localização
- **Trocar o proxy (pelo país)** — Numa instância proxy, o botão **País** lista a biblioteca rotulada pelo país de saída do último teste e recria o container com o proxy escolhido (o perfil é realinhado à geo do novo IP)
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
- **DNS**: o domínio do painel **e** o curinga `*.<domínio>` apontando para o servidor (cada instância ganha `chromeN.<domínio>`)

## Instalação Rápida

```bash
chmod +x install-and-run.sh
./install-and-run.sh
```

O instalador **pergunta o domínio** (e o email do certificado) e mostra o que vai
fazer antes de tocar em qualquer coisa:

```
🌐 Domínio do painel
   O painel fica neste domínio e cada instância ganha um subdomínio
   (chrome1.<domínio>, chrome2.<domínio>…). O DNS já precisa de apontar
   para este servidor — o certificado do Let's Encrypt é pedido agora.

   Domínio (ex: exemplo.com): _
```

Para correr **sem interação** (CI, cloud-init, Ansible), informe o domínio:

```bash
./install-and-run.sh --domain exemplo.com --email eu@exemplo.com --yes
# ou
BASE_DOMAIN=exemplo.com ./install-and-run.sh
```

O que ele faz: instala o Node.js (se faltar), copia o projeto para
`/opt/chrome-vpn-dashboard`, instala as dependências, cria o serviço systemd
(`chrome-vpn-dashboard`), gera o vhost do painel no nginx (**com
`client_max_body_size 0`**, para o envio de ficheiros), pede o certificado no
Let's Encrypt e liga a swap (idempotente). `./install-and-run.sh --help` lista as
opções.

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
| `CLOAKBROWSER_IMAGE` | `cloakhq/cloakbrowser:latest` | Imagem do navegador antidetect (fixe uma tag para travar a versão do binário) |
| `CLOAKBROWSER_IMAGE_FREE` | (= `CLOAKBROWSER_IMAGE`) | Imagem da versão **antiga** (sem chave) — fixe aqui uma tag antiga, ex.: `cloakhq/cloakbrowser:0.5.12` |
| `CLOAKBROWSER_IMAGE_PRO` | (= `CLOAKBROWSER_IMAGE`) | Imagem usada pela versão **nova** (com licença) — o *binário* é baixado pelo wrapper (ver abaixo) |
| `CLOAKBROWSER_VERSION` | (vazio) | Trava a versão do binário que a versão **nova** baixa (sem isto, baixa a mais recente do canal) |
| `CLOAKBROWSER_RELEASE_CHANNEL` | `stable` | Canal do binário que a versão **nova** baixa |
| `CLOAKBROWSER_LICENSE_KEY` | (vazio) | **Já não é usada**: a chave passou a ser por instância, guardada na biblioteca (menu *Chaves CloakBrowser*). O ambiente do dashboard não licencia nenhuma instância |
| `CLOAKBROWSER_FETCH_WIDEVINE` | (vazio) | Baixa o Widevine no container (só quando o perfil precisar de DRM) |
| `BROWSER_SEARCH_NAME` | `Google` | Nome do motor de busca padrão instalado por política nas instâncias CloakBrowser |
| `BROWSER_SEARCH_URL` | `https://www.google.com/search?q={searchTerms}` | URL de pesquisa do motor padrão (o `{searchTerms}` é obrigatório) |
| `BROWSER_SEARCH_SUGGEST_URL` | (sugestões do Google) | URL de sugestões do motor padrão |
| `BROWSER_IMAGE` | `chrome-vpn-dashboard-browser:latest` | Imagem derivada (KasmVNC + áudio) construída a partir da oficial; o dashboard reconstrói sozinho quando a receita muda |
| `KASM_PORT` | `9225` | Porta do cliente web do KasmVNC **dentro** do container (loopback; quem publica é o roteador) |
| `AUDIO_RATE` | `24000` | Taxa do PCM que vai para o cliente web (24000 × 1 canal ≈ 48 kB/s) |
| `AUDIO_CHANNELS` | `1` | Canais do áudio do container (2 dobra o tráfego) |
| `MAX_UPLOAD_BYTES` | `0` | Teto por ficheiro no envio para o perfil (0 = sem teto; o limite é o disco) |

## Modos de Conexão

Cada instância opera em um dos modos:

- **VPN** — Container `gluetun` (Wireguard/OpenVPN Surfshark) + `chrome`. O Chrome usa a rede do gluetun (`network_mode: container:gluetun`), então todo o tráfego sai pelo túnel. Suporta **troca de país**.
- **Proxy normal** — Apenas o container `chrome`, iniciado com `--proxy-server=http://host:porta`. Sem autenticação.
- **Proxy autenticado** — Apenas o container `chrome`. Como o Chrome headless não aceita `user:pass` no `--proxy-server`, o dashboard sobe um **forwarder TCP local** (`proxy-injector.service.js`) que recebe as conexões do Chrome (`host.docker.internal:porta`) e as repassa ao proxy real adicionando o cabeçalho `Proxy-Authorization`. O Chrome é iniciado com `--proxy-server=http://host.docker.internal:<porta-forwarder>`.

> O forwarder é iniciado/parado automaticamente junto com a instância (criação, start, stop e remoção).

## Navegadores (Chromium ou CloakBrowser)

Na criação da instância é possível escolher o navegador. O **Chromium** usa a imagem da LinuxServer.io com visualizador web (**Selkies**, com áudio) na porta 3000 e perfil em `/config`:

| | Chromium (padrão) |
|---|---|
| Imagem | `lscr.io/linuxserver/chromium:latest` |
| Variável de flags | `CHROME_CLI` |
| shm | 512MB |
| Coluna no DB | `browser = 'chromium'` |

- **Brave saiu das opções.** O suporte continua no código (`chrome-container.service.js`, com o `brave` na lista de navegadores legados) para uma instância antiga gravada como `brave` seguir a funcionar; a API recusa criar novas.
- **API**: envie `"browser": "chromium"` (ou `"cloakbrowser"`) no `POST /api/instances`.
- O **fingerprint** e o **proxy** funcionam idênticos nos dois navegadores (a extensão é injetada em `/config/fp-extension` e carregada com `--load-extension`).
- A **troca de país da VPN** e a **troca de proxy** preservam o navegador escolhido.
- O card exibe o badge do navegador (🦁 Brave / 🌀 Chromium).

O terceiro navegador (**CloakBrowser**) não segue esse desenho — veja a seção seguinte.

## CloakBrowser (antidetect por CDP)

`browser: "cloakbrowser"` cria a instância com o binário do [CloakBrowser](https://cloakbrowser.dev/): um Chromium com os patches de fingerprint aplicados **no próprio binário**, servido como um servidor **CDP**. É a diferença estrutural em relação ao Chromium/Brave:

| | Chromium/Brave | CloakBrowser |
|---|---|---|
| Imagem | `lscr.io/linuxserver/...` | `cloakhq/cloakbrowser:latest` |
| Acesso | Área de trabalho web (KasmVNC/Selkies) | **CDP** na porta **9223** (roteador para o DevTools, que escuta só no loopback) + tela do **KasmVNC** na MESMA porta |
| Como sobe | variável `CHROME_CLI`/`BRAVE_CLI` | binário lançado no `Xvnc` do KasmVNC, com o roteador (CDP + tela + áudio) embutido no comando do container |
| Fingerprint | Extensão MV3 injetada em `/config` | Flags de lançamento (`--fingerprint=`, `--lang=`, `--fingerprint-timezone=`…) — a extensão **não** é injetada |
| Proxy autenticado | Forwarder local injeta `Proxy-Authorization` | Credenciais **inline** (`--proxy-server=https://user:pass@host:porta`) |
| Porta publicada no modo VPN | `3000/tcp` (pelo gluetun) | `9223/tcp` (pelo gluetun) |
| Tela | no kernel da própria imagem | **KasmVNC dentro da própria imagem** (cliente web + som, sem container companheiro) |

### Tela (KasmVNC), áudio e CDP no MESMO endereço

A imagem derivada do CloakBrowser troca o `Xvfb` do entrypoint pelo **`Xvnc` do KasmVNC** (`deploy/browser-image/Dockerfile`): o mesmo processo que é o servidor X de `:99` serve também o cliente web da tela, já no tamanho de tela do perfil. **Não há container companheiro nem volume de socket X** — tela, áudio e navegador são o mesmo container.

O roteador da porta separa os caminhos:

| Caminho | Vai para | Serve |
|---|---|---|
| `/json/`, `/devtools/`, `/fingerprint/` | CDP (`127.0.0.1:9222`) | descoberta e WebSocket do **CDP** |
| `/audio` | ponte de áudio (`127.0.0.1:9226`) | fluxo **PCM** que o cliente web toca (ver *Áudio da tela*) |
| todo o resto (`/`) | tela do KasmVNC (`127.0.0.1:9225`) | cliente web da **tela** |

- **Card**: mostra **só o botão 🖥 Abrir tela** (a porta e a URL saíram do cartão); o `CDP` continua a sair na API (`GET /api/instances`).
- **Ciclo de vida**: a tela sobe, para e é removida junto com a instância — é o mesmo container.
- **Perfil**: o que sobrevive entre recriações é o volume `cloakbrowser-profile-<id>` (cookies, logins, marcadores e os ficheiros enviados), removido só quando a instância é removida.
- **Instâncias antigas**: ao dar start, o container é recriado com o comando novo (roteador + áudio) e o vhost é reescrito.

### O roteador da porta (por que a porta é 9223)

O binário do CloakBrowser **prende o DevTools em `127.0.0.1`** e ignora `--remote-debugging-address` (proteção do próprio produto): o loopback do container não é alcançável pela porta publicada. A tela do KasmVNC e a ponte de áudio também ficam no loopback — não faz sentido expor o cliente web direto.

Por isso o comando do container sobe, antes do navegador, o `src/browser/port-router.py` (só biblioteca padrão). Ele escuta em `0.0.0.0:9223` e escolhe o destino pelo **caminho** da requisição; depois disso os bytes seguem intactos (é um túnel TCP puro), então os WebSockets do CDP e do KasmVNC atravessam sem tradução:

```
nginx ──▶ porta publicada (9223, publicada pelo gluetun no modo VPN)
                │
                ├── /json, /devtools, /fingerprint ──▶ Chrome (127.0.0.1:9222)
                ├── /audio                        ──▶ ponte  (127.0.0.1:9226)
                └── todo o resto (/)              ──▶ tela   (127.0.0.1:9225)
```

Consequências práticas:

- A porta publicada de um perfil CloakBrowser é **9223** (não 9222, que fica só no loopback) — e é a **única** porta da instância: CDP, tela e áudio saem por ela.
- O roteador vai **embutido no comando do container** (heredoc no `Cmd`). Ele faz parte da spec: mudar o script recria o container que estiver rodando com a versão anterior.
- Uma instância **já em execução** só troca de spec quando é reiniciada: o `start` recria o container quando o comando mudou (foi assim que o áudio chegou às instâncias que já existiam).

### Como conectar

A URL de conexão do CDP sai pela API autenticada (`GET /api/instances`, campo `cdp.connectUrl`):

```python
from playwright.sync_api import sync_playwright

with sync_playwright() as pw:
    browser = pw.chromium.connect_over_cdp(URL_COPIADA_NO_CARD)  # http://chromeN.DOMINIO
    page = browser.new_page()
    page.goto("https://example.com")
```

- **Descoberta**: `GET http://chromeN.DOMINIO/json/version` (e `/json/list` para as abas). O `webSocketDebuggerUrl` que vem no corpo já aponta para o subdomínio público.
- **Onde o fingerprint entra**: não há query — o dashboard alinha o perfil no **comando do container** (`--fingerprint=<seed>`, `--fingerprint-platform=`, `--fingerprint-timezone=`, `--lang=`, `--fingerprint-hardware-concurrency=`, `--fingerprint-screen-width/height=`, `--fingerprint-webrtc-ip=<IP de saída>`), a partir do fingerprint gerado pela localização real da VPN/proxy. As strings de **WebGL não são sobrescritas** de propósito: as do dashboard estão no formato OpenGL e contradiriam o patch de origem.
- **Autenticação**: o dashboard exige login para tudo, e a URL de conexão só sai pela API autenticada (`GET /api/instances`, campo `cdp`). O CDP do Chrome não tem camada de autenticação própria — quem tiver a URL conecta. Fechar isso exigiria Basic Auth no vhost (não habilitado hoje).
- **Nginx**: os caminhos do CDP (`/json/`, `/devtools/`, `/fingerprint/`) exigem dois ajustes, ambos no vhost:
  - o `Host` é trocado para `127.0.0.1:<porta>` — o Chrome responde **500** (`Host header is specified and is not an IP address or localhost`) a qualquer outro valor;
  - como o Chrome monta o `webSocketDebuggerUrl` a partir desse `Host`, o corpo da resposta é reescrito com `sub_filter` (resposta descomprimida, `sub_filter_types application/json`) para `ws://chromeN.DOMINIO` (vhost HTTP) ou `wss://chromeN.DOMINIO` (vhost HTTPS) — sem isso o cliente receberia um endereço de loopback, inalcançável de fora.
  - Os cabeçalhos de upgrade (`Upgrade`/`Connection`) valem para os dois caminhos, então o WebSocket do CDP e o do KasmVNC passam pelo mesmo vhost.

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
- Na criação: seletor **"Provedor VPN"** (Surfshark/ExpressVPN); o card exibe o selo **Surf** / **Express**.
- A **troca de país** preserva provedor, navegador e fingerprint.
- **Nomes de país por provedor**: o gluetun repassa `SERVER_COUNTRIES` ao provedor, e a ExpressVPN usa outros nomes — «United States» é recusado com `the country specified is not valid` e o túnel **não arranca** (a instância parece «não conectar», mesmo com as credenciais certas). O dashboard traduz: `United States → USA`, `United Kingdom → UK`, `India → India (via UK)`. O Surfshark usa os mesmos nomes do dashboard (`src/services/gluetun-container.service.js`).

## Biblioteca de Proxies (🔌)

O menu **"Proxies"** (botão 🔌 na barra de ações) é uma biblioteca de proxies reutilizáveis, igual ao menu de Credenciais VPN:

- **Cadastrar/editar/remover** proxies (nome, host, porta, esquema HTTP/SOCKS, usuário/senha). A senha é **mascarada** (nunca retornada na listagem — só `hasPassword`).
- **Escolher na criação**: ao criar uma instância do tipo Proxy, o campo **"Proxy salvo"** lista os proxies cadastrados e **preenche automaticamente** host/porta/usuário/senha (inclusive o modo autenticado).
- **Importar em lote**: cole uma lista (um proxy por linha) no textarea e clique em **"Importar Lista"**. Formatos aceitos: `host:porta:user:pass` (Bright Data), `host:porta`, `user:pass@host:porta` e `http(s)://host:porta`. Linhas em branco e com `#` são ignoradas. **Duplicados** (mesmo host:porta:usuário) são ignorados automaticamente. O nome é gerado a partir de `user@host:porta`.
- **API**: `GET/POST/PUT/DELETE /api/proxies`, `GET /api/proxies/:id/full` (com senha, uso interno na criação) e `POST /api/proxies/bulk` (importação em lote; body `{ list: "..." }` ou `{ items: [...] }`).
- **No cartão da instância**: instâncias do tipo Proxy mostram **onde o proxy sai** — IP, `cidade, país`, fuso e ISP do último teste guardado na biblioteca — e não o endereço do proxy. A ligação é a coluna `instances.proxy_id` (gravada na criação e na troca de proxy); instâncias criadas antes da coluna são religadas pelo host/porta/usuário no arranque do banco.

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
- **Nota (whoer.net)** — a nota de anonimato desconta **30%** quando o servidor DNS resolve **noutro país** que o IP de saída. Quem escolhe o resolver é o provedor do proxy, não o dashboard: proxies cujo resolver geolocaliza no país de saída (ex.: os de Denver/US) dão **90%**, enquanto os de Munique (resolver público visto na Bélgica) ficam nos **70%**. Medido no próprio browser, pelo CDP, depois de a política desligar o DNS-over-HTTPS e a pré-busca. Nas instâncias **VPN** o DNS vai todo pelo túnel e resolve no país de saída: **United States = 100%** (sem descontos); a Alemanha fica em **90%** por causa do `-10% Systemzeit` (a base do whoer não acompanha o horário de verão), que é uma comparação deles e não do perfil.


## Perfis e Fingerprint (antidetect, estilo GoLogin)

Cada instância funciona como um **perfil de navegador** com identidade própria:

- **Fingerprint determinístico por perfil** — gerado a partir do id da instância (`fingerprint.service.js`): userAgent/platform, resolução de tela, timezone, idioma, hardwareConcurrency, deviceMemory e WebGL (vendor/renderer). O mesmo perfil sempre mantém a mesma identidade entre sessões.
- **Injeção via extensão MV3** — a extensão em `src/fingerprint-extension/` (content script com `world: "MAIN"`, `document_start`) sobrescreve `navigator`, `screen` e WebGL no mundo da página. Ela é injetada no container via `docker putArchive` (funciona com container parado) em `/config/fp-extension` e carregada com `--load-extension` no `CHROME_CLI`.
- **Persistência** — o fingerprint é salvo como JSON na coluna `fingerprint` da tabela `instances` e **re-injetado automaticamente** a cada start/restart (idempotente).
- **API** — no `POST /api/instances` é possível enviar um objeto `fingerprint` parcial (ex.: `{"timezone": "Europe/Lisbon"}`) para sobrescrever campos específicos; os demais continuam determinísticos.
- **UI** — o card da instância exibe OS, resolução, timezone e idioma do perfil.

### Alinhamento com a saída real (regra central)

Sempre que uma instância sobe, o dashboard resolve a **localização real do IP de saída** (VPN ou proxy) e **re-alinha o perfil a ela**: fuso horário, `language`/`languages` e `geo` (país, cidade, IP) saem da localização, nunca de um valor fixo. O navegador nunca deve mostrar um fuso/idioma diferente daquele do IP.

- O alinhamento **espera o túnel revelar o IP real** (`_resolveExitWhenReady`) e, se a VPN demorar a conectar, agenda re-tentativas tardias (45s e 120s) sem recriar o container nem derrubar a sessão.
- Quando o IP real cai numa cidade diferente da capital do país, o fuso é refinado para o da cidade e, se preciso, o browser é **recriado** para que `TZ` e `--lang` do container também batam com o perfil (`recreateChromeContainer`).
- A versão do Chrome na UA/Client Hints é sempre a **versão real do binário** da imagem (`chrome-version.service.js`), para a UA e o `navigator.userAgentData` não discordarem entre si.

### Limitação conhecida: cabeçalhos HTTP

O mascaramento atua **dentro da página** (JS, via content script em `world: "MAIN"`). Os **cabeçalhos HTTP** que o navegador envia continuam sendo os do binário Linux do container (`User-Agent: ... (X11; Linux x86_64) ...` e `sec-ch-ua-platform: "Linux"`), então verificadores que leem o cabeçalho (ex.: o campo "OS" do whoer.net) ainda reportam Linux.

- `--user-agent` no `CHROME_CLI` muda o JS e o cabeçalho `User-Agent`, mas **não** os Client Hints (`sec-ch-ua-*`).
- `--disable-features=UserAgentClientHints` não desliga os Client Hints nesta imagem (testado).
- `declarativeNetRequest` (regras `modifyHeaders` numa extensão MV3) **não é viável aqui**: com `declarative_net_request` no manifest, o Chrome deixa de carregar a extensão passada por `--load-extension` — e sem a extensão nem o JS é mascarado. Testado no container: com o manifest o `navigator.platform` ficou `Linux x86_64` e sem ele voltou a `MacIntel`.
- Resolver isso exige reescrever os cabeçalhos **fora** do navegador (proxy HTTP(S) com MITM e CA própria no caminho do tráfego), o que é uma mudança de arquitetura — não é feito hoje.

> **No CloakBrowser essa limitação não existe.** Como os patches são no binário, a plataforma anunciada não vem do Linux do container: num container Debian, o `/json/version` da própria imagem responde `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/146.0.0.0`. É a opção para perfis que precisam passar por verificadores que leem cabeçalho e Client Hints.

## Acesso

- **URL**: `http://IP_DO_SERVIDOR:3100` (ou via Nginx/Cloudflared)
- **Login**: `admin` / `admin123`
- **Cartão da instância**: mostra **só o botão 🖥 Abrir tela** (no CloakBrowser é a tela do KasmVNC; no Chromium/Brave é a área de trabalho do subdomínio). A **porta** e a **URL** saíram do cartão. O título é curto e separado por `|` — `1 | Cloak | Surf` (número | tipo | navegador | provedor VPN); com nome, ele entra logo depois do número (`1 | conta da loja | Cloak | Surf`) e encurta com `…` se for comprido.

## Estrutura

```
dashboard/
├── src/
│   ├── server.js              # Express (PORT do ambiente; 3100 por omissão)
│   ├── database.js            # SQLite + migrações (colunas novas entram sozinhas)
│   ├── middleware/
│   │   └── auth.middleware.js # Verificação do JWT
│   ├── routes/
│   │   ├── auth.router.js     # Login/logout/verify
│   │   ├── instances.router.js # Instâncias: CRUD, start/stop, país, proxy, ficheiros, editar
│   │   ├── proxies.router.js  # Biblioteca de proxies (+ teste e geo)
│   │   ├── vpn.router.js      # Credenciais dos provedores VPN
│   │   └── cloak-licenses.router.js # Chaves do CloakBrowser (verificar/atualizar)
│   ├── browser/
│   │   └── port-router.py     # UMA porta por instância: CDP + tela + áudio, por caminho
│   └── services/
│       ├── auth.service.js              # JWT + rate limiting
│       ├── docker.service.js            # Ciclo de vida dos containers + putArchive
│       ├── chrome-container.service.js  # Spec do container do navegador
│       ├── gluetun-container.service.js # Spec do container do túnel
│       ├── cloakbrowser.service.js      # Regras do CloakBrowser (flags, comando, política)
│       ├── browser-image.service.js     # Imagem derivada (KasmVNC + áudio) e a sua receita
│       ├── bookmarks.service.js         # Marcadores semeados em cada perfil
│       ├── profile-files.service.js     # Ficheiros enviados para o perfil (Downloads)
│       ├── cloak-licenses.service.js    # Biblioteca de chaves (validate + session/count)
│       ├── instance.service.js          # Orquestrador (criar, editar, renomear, trocar saída)
│       ├── nginx.service.js             # Vhost + cert de cada instância
│       ├── vpn.service.js               # Status da VPN via geo do IP de saída
│       ├── proxies.service.js           # CRUD e geo dos proxies
│       └── proxy-injector.service.js    # Forwarder TCP p/ proxy autenticado
├── public/
│   ├── index.html             # Dashboard
│   ├── login.html             # Login
│   ├── css/styles.css         # Tema escuro responsivo
│   └── js/                    # Frontend SPA (vpn-countries.js = países por provedor)
├── deploy/
│   ├── browser-image/         # Dockerfile da imagem do navegador + áudio (PulseAudio + ponte)
│   ├── nginx-dashboard.conf   # Vhost de referência do painel (client_max_body_size 0)
│   ├── setup-nginx.sh         # Vhost do painel só em HTTP (instalações simples)
│   └── chrome-vpn-dashboard.service # Unit systemd de referência
├── test/                      # Jest (a suite corre no servidor, com Docker disponível)
├── mitm-proxy/                # Proxy MITM auxiliar (opcional)
├── data/                      # SQLite (auto-criado)
├── package.json
├── Dockerfile                 # Imagem só do painel (API + web); Docker/nginx ficam no host
└── install-and-run.sh         # Instalação completa: Node, systemd, nginx, certbot, swap
```

## API Endpoints

### Autenticação
- `POST /api/auth/login` — Login (retorna JWT)
- `POST /api/auth/logout` — Logout
- `GET /api/auth/verify` — Verificar token

### Instâncias (requer JWT)
- `GET /api/instances` — Listar todas (instâncias CloakBrowser trazem o bloco `cdp` com `endpointUrl`, `discoveryUrl` e `connectUrl` e o bloco `vnc` com `port` e `url` da tela; a rota exige JWT, então as URLs só saem para quem tem sessão)
- `POST /api/instances` — Criar nova
  - **VPN**: body `{ "type": "vpn", "country": "Germany" }` — aceita `"browser": "chromium" | "brave" | "cloakbrowser"`
  - **Proxy normal**: body `{ "type": "proxy", "proxy": { "host": "1.2.3.4", "port": 8080, "scheme": "http", "auth": false } }`
  - **Proxy autenticado**: body `{ "type": "proxy", "proxy": { "host": "brd.superproxy.io", "port": 44445, "user": "...", "pass": "...", "scheme": "http", "auth": true } }`
- `DELETE /api/instances/:id` — Remover
- `POST /api/instances/:id/start` — Iniciar
- `POST /api/instances/:id/stop` — Parar
- `POST /api/instances/:id/restart` — Reiniciar
- `POST /api/instances/:id/country` — Trocar país (apenas VPN; body: `{ country }`). Preserva a identidade do perfil (plataforma/tela/GPU) e o volume do perfil (cookies/login): só os containers são refeitos
- `POST /api/instances/:id/proxy` — Trocar o proxy (apenas instâncias proxy; body: `{ proxyId }`, o id de um proxy da biblioteca — a senha fica no servidor)
- `POST /api/instances/:id/cloak-edition` — Troca a versão do CloakBrowser (body: `{ edition: "free" | "pro" }`; `free` = binário antigo sem chave, `pro` = binário novo com a chave da biblioteca). Preserva o perfil
- `GET /api/instances/:id/vpn` — Info VPN/proxy (IP e país de saída)

### Chaves do CloakBrowser (requer JWT)
- `GET /api/cloak-licenses` — Lista as chaves (só as pontas, nunca a chave inteira) com o plano e quantas instâncias usam cada uma
- `POST /api/cloak-licenses` — Adiciona chaves (body: `{ "keys": "chave1\nchave2" }`; uma por linha, duplicadas são ignoradas)
- `DELETE /api/cloak-licenses/:id` — Remove uma chave (as instâncias que a usavam passam a usar outra da biblioteca)
- `POST /api/cloak-licenses/check` — Pergunta ao vendor (`cloakbrowser.dev/api/license/*`) o estado de todas as chaves: plano, prazo e lugares em uso (`active`/`limit`). É o botão **🔎 Verificar** do menu. Sem resposta do vendor (rede/DNS) a chave **não** é marcada como inválida: o erro é devolvido e o plano/prazo já conhecido fica intacto
- `POST /api/cloak-licenses/update` — Atualiza o binário Pro para a versão mais recente do vendor, quando existir (botão **⬆ Atualizar**). Corre o `cloakbrowser update` num container descartável com o volume de cache montado e, se houve mesmo download, recria as instâncias Pro que estão a correr. Resposta: `{ updated, downloadedVersion, version, upToDate, failed, recreated }`

## Rodar em Background

```bash
nohup node src/server.js > /tmp/dashboard.log 2>&1 &
```

## Rodar com systemd

O instaldor `install-and-run.sh` já cria e ativa este unit. Ele usa
`Environment=` (não `EnvironmentFile`) porque **o dashboard lê `process.env`,
não um `.env`** — o `.env` no diretório é apenas referência. O ambiente real
vive no unit. Exemplo equivalente ao que o script gera:

```bash
cat > /etc/systemd/system/chrome-vpn-dashboard.service << EOF
[Unit]
Description=Chrome VPN Dashboard (brave.rota.ath.cx)
After=network.target docker.service
Wants=docker.service

[Service]
Type=simple
WorkingDirectory=/opt/chrome-vpn-dashboard
Environment=PORT=3001
Environment=DOMAIN=brave.rota.ath.cx
Environment=BASE_PORT=4001
Environment=MAX_INSTANCES=20
Environment=JWT_SECRET=troque-isto
Environment=NGINX_ENABLED=true
Environment=PROXY_INJECTOR_BASE_PORT=8150
Environment=CERTBOT_EMAIL=admin@brave.rota.ath.cx
# CloakBrowser / KasmVNC (tela embutida)
Environment=CLOAKBROWSER_IMAGE=cloakhq/cloakbrowser:latest
Environment=BROWSER_IMAGE=chrome-vpn-dashboard-browser:latest
Environment=KASM_PORT=9225
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=3
StandardOutput=append:/var/log/chrome-vpn-dashboard.log
StandardError=append:/var/log/chrome-vpn-dashboard.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable chrome-vpn-dashboard
systemctl start chrome-vpn-dashboard
```

Cada instância de navegador ganha um **subdomínio próprio**
(`<slug>.<DOMAIN>`, ex.: `chrome1.brave.rota.ath.cx`) com vhost de nginx gerado
automaticamente pelo dashboard quando a instância é criada. O vhost encaminha
`/json`, `/devtools` e `/fingerprint` para o CDP e o resto (`/`) para a tela do
KasmVNC, tudo na mesma porta publicada (`BASE_PORT + id`).

> **Live access do CloakBrowser:** abra `https://chrome1.brave.rota.ath.cx/`.
> O link é o subdomínio puro, **sem query string**: parâmetros como
> `resize=scale` faziam o cliente redimensionar a tela e encolhiam a janela do
> navegador. O WebSocket do KasmVNC fica em `/websockify` (o cliente noVNC envia
> o header `Sec-WebSocket-Origin`; o vhost já faz o `sub_filter` `ws://`→`wss://`).
### Áudio da tela (KasmVNC)

O **KasmVNC não transmite áudio** — é limitação do próprio projeto (o áudio é um
canal do Kasm Workspaces, que é produto fechado). Como o container também não tem
placa de som, o dashboard monta o caminho inteiro dentro da imagem derivada
(`deploy/browser-image/`):

1. o entrypoint sobe um **PulseAudio em modo sistema** com um **sink virtual**
   (`module-null-sink`): é para ele que o Chrome manda o som, porque não existe
   saída de verdade;
2. a **ponte** (`audio-bridge.py`) lê o **monitor** desse sink com `parec` e
   serve o PCM cru (s16le, sem cabeçalho) em `/audio`, num fluxo HTTP;
3. o roteador da porta da instância (`port-router.py --audio 9226`) manda
   `/audio` para a ponte — o som sai pela **mesma porta publicada** do CDP e da
   tela, sem porto novo;
4. o cliente web do KasmVNC recebe um botão **🔇 Som** (`kasm-audio.js`,
   injetado no `index.html` da imagem): um clique liga o som e a escolha fica
   lembrada para as visitas seguintes.

> **Como usar:** abra a tela e clique em **🔇 Som** no canto inferior direito. O
> clique é obrigatório — o Chrome só libera áudio depois de um gesto do usuário.

Ajustes por ambiente (no container), para quando o link é apertado:

| Variável | Padrão | O que faz |
| --- | --- | --- |
| `AUDIO_RATE` | `24000` | taxa do PCM em Hz (24000 × 1 canal ≈ 48 kB/s) |
| `AUDIO_CHANNELS` | `1` | canais de som (2 dobra o tráfego) |
| `AUDIO_PORT` | `9226` | porta da ponte no loopback (o dashboard passa a mesma em `--audio`) |

> **Mudou o Dockerfile? A imagem se reconstrói sozinha.** A imagem derivada
> guarda a etiqueta `dashboard.recipe` com a impressão do Dockerfile e dos
> arquivos que ele copia; quando a impressão muda, a próxima instância
> CloakBrowser reconstrói a imagem — e o container é recriado, porque o comando
> dele mudou. Sem isso, uma imagem antiga continuaria a ser usada para sempre.

### Envio de ficheiros para o perfil (⬆ Enviar)

O botão **⬆ Enviar** do cartão manda um ficheiro do seu computador para a pasta
**Downloads** do perfil da instância — é o que o seletor de ficheiros do site
abre quando publica nas redes (o site vê o sistema de ficheiros do *container*,
não o do seu PC).

**Não há limite de tamanho.** O ficheiro vai **cru** no corpo do pedido
(`application/octet-stream`, com o nome em `X-File-Name`), o dashboard escreve-o
num ficheiro temporário no disco em *streaming* e de lá ele segue para o
container num tar lido em blocos — sem nunca passar pela memória do dashboard
nem pelo `express.json`. O único limite é o espaço em disco do servidor (o botão
mostra a percentagem durante o envio).

> Antes disto, 24 MB falhavam: o ficheiro ia em base64 dentro de um JSON (33%
> maior), o `express.json` cortava em 25 MB e — antes disso — o
> `client_max_body_size` do nginx, que vale **1 MB** por omissão, cortava tudo o
> que passasse disso. O vhost do dashboard (`deploy/nginx-dashboard.conf` e
> `deploy/setup-nginx.sh`) passou a trazer `client_max_body_size 0` (sem teto).

| Variável | Padrão | O que faz |
| --- | --- | --- |
| `MAX_UPLOAD_BYTES` | `0` (sem teto) | Teto por ficheiro, em bytes, para travar um envio gigante por engano |

> O contrato antigo (JSON `{name, data}` com base64) continua a funcionar, para
> scripts — mas é ele que fica sujeito ao teto e ao limite de corpo do
> `express.json`.

### Editar / renomear a instância (✏ Editar)

O botão **✏ Editar** do cartão abre um diálogo com o que dá para mudar:

| Campo | O que acontece |
| --- | --- |
| **Nome** | É só o rótulo do cartão (`1 | conta da loja | Cloak | Surf`). **Não toca no container**: o navegador, o perfil e os logins continuam exatamente onde estão. Vazio volta a mostrar só o número. |
| **Saída** (país da VPN ou proxy da biblioteca) | Reinicia a instância para sair por outro sítio. O **perfil é preservado** — cookies e logins ficam. Vem com "manter a atual" já selecionado. |
| **Versão do CloakBrowser** | Alterna entre o binário antigo (sem chave) e o novo (com licença da biblioteca). Também reinicia. |

Só o que **mudou** é enviado: abrir o diálogo e salvar sem mexer em nada não
reinicia instância nenhuma. O nome também pode ser dado já na criação.

- **API**: `PATCH /api/instances/:id` com `{"name": "conta da loja"}` — nome vazio
  tira o rótulo. O nome é saneado no servidor (espaços repetidos viram um só,
  caracteres de controlo saem, sobra cortada em 60 caracteres) e vai **escapado**
  para o HTML do cartão.
- Trocar a saída ou a versão usa as rotas que já existiam:
  `POST /:id/country`, `POST /:id/proxy` e `POST /:id/cloak-edition`.



## Países Disponíveis

A lista vem do **gluetun**, por provedor — cada um tem a sua e a grafia varia:

- **Surfshark** (~100 países): `United States`, `United Kingdom`, `India`, `Puerto Rico`, `Marocco` (o gluetun só aceita esta grafia; o rótulo mostrado é **Morocco**)…
- **ExpressVPN** (~90 países): `USA`, `UK`, `India (via UK)` e `India (via Singapore)`, `Cayman Islands`, `Guam`…

O seletor de país do dashboard (na criação e na troca de país) é preenchido com a lista do provedor escolhido, a partir de `public/js/vpn-countries.js`. O backend continua a traduzir nomes "por extenso" para o que a ExpressVPN espera (`United States → USA`, `United Kingdom → UK`, `India → India (via UK)`) em `src/services/gluetun-container.service.js`, para pedidos antigos ou feitos diretamente pela API.
