const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const cloakbrowser = require('./cloakbrowser.service');

const NGINX_SITES_PATH = '/etc/nginx/sites-available';
const NGINX_ENABLED_PATH = '/etc/nginx/sites-enabled';
const CERT_LIVE_PATH = '/etc/letsencrypt/live';
const DOMAIN = process.env.DOMAIN || 'sakr.ath.cx';
const CERTBOT_EMAIL = process.env.CERTBOT_EMAIL || `admin@${DOMAIN}`;

// Um certificado a menos de 24h do vencimento é reemitido em vez de reusado.
const RENEW_MARGIN_MS = 24 * 60 * 60 * 1000;

// Cabeçalhos comuns a qualquer upstream do vhost. O par
// `Upgrade`/`Connection` é o que deixa o WebSocket passar (o noVNC e o
// WebSocket do CDP dependem disso).
//
// O `Host` é um parâmetro, não uma constante: os caminhos do CDP precisam
// mandá-lo como IP:porta (o Chrome recusa qualquer outro valor) e o nginx usa
// só o PRIMEIRO `proxy_set_header Host` de cada localização — declarar dois no
// mesmo bloco deixaria o genérico vencer.
const proxyHeaders = (hostHeader) => `        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host       ${hostHeader};
        proxy_set_header   X-Forwarded-Host $host;
        proxy_set_header   X-Real-IP  $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout  3600s;
        proxy_send_timeout  3600s;
`;

// Bloco de proxy comum aos dois modos (HTTP e HTTPS) do vhost da instância.
const PROXY_LOCATION = (port, locationPath = '/', extraHeaders = '', hostHeader = '$host') => `    location ${locationPath} {
        proxy_pass         http://localhost:${port};
${proxyHeaders(hostHeader)}${extraHeaders}    }
`;

// Caminhos que pertencem ao CDP do CloakBrowser: a descoberta (`/json/...`), o
// WebSocket (`/devtools/...`) e o roteamento por seed do cloakserve
// (`/fingerprint/<seed>/...`). São exatamente os que o Playwright/Puppeteer
// usam em `connect_over_cdp`.
const CDP_PATHS = ['/json/', '/devtools/', '/fingerprint/'];

/**
 * Cabeçalhos exclusivos dos caminhos do CDP — o navegador atrás deles é o
 * Chrome do CloakBrowser, que é mais exigente que o noVNC: o corpo que ele
 * devolve monta o `webSocketDebuggerUrl` a partir do Host recebido, então
 * `ws://127.0.0.1:<porta>` é reescrito para o endereço público — sem isso o
 * Playwright/Puppeteer receberiam uma URL inalcançável de fora do servidor.
 * `sub_filter` exige a resposta descomprimida.
 */
const CDP_HEADERS = (port, publicHost, wsScheme) => `        proxy_set_header   Accept-Encoding "";
        sub_filter_types   application/json;
        sub_filter_once    off;
        sub_filter         'ws://127.0.0.1:${port}' '${wsScheme}://${publicHost}';
`;

// Todos os caminhos de CDP apontando para a porta do navegador, cada um com o
// Host de IP:porta que o Chrome exige (ver o comentário de `proxyHeaders`).
// `wsScheme` é o esquema que o cliente vai de fato usar (ws na porta 80, wss em
// HTTPS).
const CDP_LOCATIONS = (port, publicHost, wsScheme) =>
  CDP_PATHS
    .map((item) => PROXY_LOCATION(
      port,
      item,
      CDP_HEADERS(port, publicHost, wsScheme),
      `127.0.0.1:${port}`
    ))
    .join('');

class NginxService {
  /**
   * Blocos de localização do vhost.
   *
   * Chromium/Brave e CloakBrowser falam com UMA porta por instância. No
   * CloakBrowser essa porta é o roteador do container, que separa por caminho:
   * os caminhos do CDP (descoberta e WebSocket, usados por
   * Playwright/Puppeteer) vão para o DevTools do Chrome, e todo o resto é a
   * tela do KasmVNC. Os caminhos do CDP precisam de cabeçalhos próprios (Host
   * de IP e reescrita do corpo) — os demais não.
   */
  locationsBlock(instance, wsScheme = 'wss') {
    if (!cloakbrowser.isCloakBrowser(instance.browser)) {
      return PROXY_LOCATION(instance.port);
    }
    const subdomain = `chrome${instance.id}.${DOMAIN}`;
    return `${CDP_LOCATIONS(instance.port, subdomain, wsScheme)}` +
      `${PROXY_LOCATION(instance.port)}`;
  }

  /**
   * Corpo do vhost da porta 80.
   *
   * Chromium/Brave: o navegador é acessado por HTTPS, então a porta 80 só
   * redireciona.
   *
   * CloakBrowser: os caminhos do CDP são servidos AQUI, sem redirecionar. O
   * Chrome monta a URL da sessão como `ws://<host>/devtools/...` (ele não sabe
   * do TLS terminado no nginx) e o Playwright conecta nessa URL — um 301 para
   * HTTPS quebraria o handshake. O resto (a tela do KasmVNC) vai para HTTPS:
   * é uma página, e em HTTPS o WebSocket dela sai como `wss://`.
   */
  httpBody(instance) {
    if (!cloakbrowser.isCloakBrowser(instance.browser)) {
      return '    return 301 https://$host$request_uri;\n';
    }
    const subdomain = `chrome${instance.id}.${DOMAIN}`;
    return `${CDP_LOCATIONS(instance.port, subdomain, 'ws')}    location / {
        return 301 https://$host$request_uri;
    }
`;
  }

  /**
   * Vhost somente HTTP — usado antes da primeira emissão do certificado.
   * Como não há TLS aqui, a URL de sessão anunciada ao cliente é `ws://`.
   */
  generateServerBlock(instance) {
    const { id } = instance;
    const subdomain = `chrome${id}.${DOMAIN}`;

    return `# Chrome ${id} - Auto-generated
server {
    listen 80;
    server_name ${subdomain};

${this.locationsBlock(instance, 'ws')}}
`;
  }

  /**
   * Vhost completo (HTTPS + redirecionamento 80→443) para um certificado que já
   * existe. Evita chamar o certbot quando o perfil é recriado: o certificado é
   * emitido uma única vez por subdomínio e reaproveitado.
   */
  generateSecureServerBlock(instance) {
    const { id } = instance;
    const subdomain = `chrome${id}.${DOMAIN}`;
    const { certPath, keyPath } = this.certPaths(subdomain);

    return `# Chrome ${id} - Auto-generated
server {
    listen 443 ssl;
    server_name ${subdomain};

${this.locationsBlock(instance)}
    ssl_certificate ${certPath};
    ssl_certificate_key ${keyPath};
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
}

server {
    listen 80;
    server_name ${subdomain};

${this.httpBody(instance)}}
`;
  }

  /** O arquivo do vhost já tem exatamente o conteúdo que seria escrito? */
  isSameAsOnDisk(filePath, expected) {
    try {
      return fs.readFileSync(filePath, 'utf-8') === expected;
    } catch (err) {
      return false;
    }
  }

  /** Caminhos do certificado do subdomínio (padrão do Let's Encrypt). */
  certPaths(subdomain) {
    const dir = path.join(CERT_LIVE_PATH, subdomain);
    return {
      dir,
      certPath: path.join(dir, 'fullchain.pem'),
      keyPath: path.join(dir, 'privkey.pem')
    };
  }

  /**
   * Já existe certificado utilizável para o subdomínio? Se sim, o vhost é
   * escrito pronto em HTTPS e o certbot não é chamado de novo (reuso).
   */
  hasReusableCert(subdomain) {
    const { certPath, keyPath } = this.certPaths(subdomain);
    if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) return false;

    try {
      const cert = new crypto.X509Certificate(fs.readFileSync(certPath, 'utf-8'));
      return this.isCertFresh(cert.validTo);
    } catch (err) {
      // Não deu para ler o certificado: reusar é melhor do que reemitir.
      return true;
    }
  }

  /** Vencimento com folga suficiente para reusar o certificado. */
  isCertFresh(validTo, now = Date.now()) {
    const expiresAt = Date.parse(validTo);
    if (Number.isNaN(expiresAt)) return true;
    return expiresAt - now > RENEW_MARGIN_MS;
  }

  async addServerBlock(instance) {
    const subdomain = `chrome${instance.id}.${DOMAIN}`;

    // Se o nginx estiver desabilitado via env, apenas ignora (modo local).
    if (!this._isEnabled()) {
      console.log(`[${new Date().toISOString()}] [INFO] [nginx] NGINX_ENABLED=false — server block ignorado para ${subdomain}`);
      return;
    }

    // Se o nginx não estiver ativo, não tenta configurar/recarregar: a
    // instância continua acessível diretamente pela porta (modo local).
    if (!this._isActive()) {
      console.warn(`[${new Date().toISOString()}] [WARN] [nginx] Nginx inativo — server block ignorado para ${subdomain} (acesso pela porta direta)`);
      return;
    }

    // Certificado já emitido para este subdomínio => o vhost já nasce em HTTPS.
    const reuseCert = this.hasReusableCert(subdomain);
    const configContent = reuseCert
      ? this.generateSecureServerBlock(instance)
      : this.generateServerBlock(instance);
    const filePath = path.join(NGINX_SITES_PATH, `chrome${instance.id}`);
    const enabledPath = path.join(NGINX_ENABLED_PATH, `chrome${instance.id}`);

    // Vhost já igual ao que seria escrito: nada a fazer. Sem esta checagem,
    // garantir o vhost a cada start (é o que o CloakBrowser faz — a separação
    // CDP/tela depende dele) recarregaria o nginx à toa e reescreveria o
    // arquivo de instâncias cujo formato mudou de versão para versão.
    if (this.isSameAsOnDisk(filePath, configContent)) {
      return;
    }

    // Write config
    fs.writeFileSync(filePath, configContent, 'utf-8');

    // Enable site
    try {
      if (fs.existsSync(enabledPath)) fs.unlinkSync(enabledPath);
      fs.symlinkSync(filePath, enabledPath);
    } catch (err) {
      console.warn(`[WARN] [nginx] Symlink:`, err.message);
    }

    // Test and reload nginx
    this._testConfig();
    this._reload();

    if (reuseCert) {
      console.log(`[${new Date().toISOString()}] [INFO] [nginx] Server block criado para ${subdomain} — certificado existente reutilizado (sem nova emissão)`);
      return;
    }

    console.log(`[${new Date().toISOString()}] [INFO] [nginx] Server block criado para ${subdomain}`);

    // Generate SSL certificate with certbot
    try {
      console.log(`[${new Date().toISOString()}] [INFO] [nginx] Gerando certificado SSL para ${subdomain}...`);
      execSync(
        `certbot --nginx -d ${subdomain} --non-interactive --agree-tos -m ${CERTBOT_EMAIL} --redirect`,
        { timeout: 60000, stdio: 'pipe' }
      );
      console.log(`[${new Date().toISOString()}] [INFO] [nginx] SSL ativo para ${subdomain}`);
    } catch (err) {
      console.warn(`[WARN] [nginx] Certbot falhou para ${subdomain}: ${err.stderr ? err.stderr.toString() : err.message}`);
      // Não faz rollback - o site funciona em HTTP mesmo sem SSL
    }
  }

  /**
   * Remove o vhost do subdomínio, mas MANTÉM o certificado emitido: se o perfil
   * for recriado depois, o mesmo certificado é reutilizado (sem nova emissão e
   * sem consumir cota do Let's Encrypt). A renovação continua a cargo do
   * certbot.timer, que não depende do vhost da instância.
   */
  async removeServerBlock(id) {
    const subdomain = `chrome${id}.${DOMAIN}`;
    const filePath = path.join(NGINX_SITES_PATH, `chrome${id}`);
    const enabledPath = path.join(NGINX_ENABLED_PATH, `chrome${id}`);

    // Remove symlink
    if (fs.existsSync(enabledPath)) {
      fs.unlinkSync(enabledPath);
    }

    // Remove config file
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Reload nginx (apenas se ativo; senão só limpa os arquivos)
    if (this._isEnabled() && this._isActive()) {
      try {
        this._testConfig();
        this._reload();
      } catch (err) {
        console.warn(`[WARN] [nginx] Erro ao recarregar:`, err.message);
      }
    }

    console.log(`[${new Date().toISOString()}] [INFO] [nginx] Server block removido para ${subdomain}`);

    if (this.hasReusableCert(subdomain)) {
      console.log(`[${new Date().toISOString()}] [INFO] [nginx] Certificado de ${subdomain} mantido para reuso (nenhuma nova emissão será feita se o perfil voltar)`);
    }
  }

  /** Habilita/desabilita o gerenciamento do nginx (NGINX_ENABLED=false => modo local). */
  _isEnabled() {
    return String(process.env.NGINX_ENABLED || 'true').toLowerCase() !== 'false';
  }

  /** Verifica se o serviço nginx está ativo (para pular reload/certbot quando parado). */
  _isActive() {
    try {
      execSync('systemctl is-active --quiet nginx', { timeout: 4000, stdio: 'pipe' });
      return true;
    } catch (err) {
      return false;
    }
  }

  _testConfig() {
    try {
      execSync('nginx -t', { timeout: 5000, stdio: 'pipe' });
    } catch (err) {
      throw new Error(`Configuração Nginx inválida: ${err.stderr ? err.stderr.toString() : err.message}`);
    }
  }

  _reload() {
    try {
      execSync('systemctl reload nginx', { timeout: 5000, stdio: 'pipe' });
    } catch (err) {
      throw new Error(`Falha ao recarregar Nginx: ${err.message}`);
    }
  }
}

module.exports = new NginxService();
module.exports.PROXY_LOCATION = PROXY_LOCATION;
module.exports.CDP_PATHS = CDP_PATHS;
