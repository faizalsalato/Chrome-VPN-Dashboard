/**
 * Vhost das instâncias e, principalmente, o reuso do certificado: ele é emitido
 * uma vez por subdomínio, sobrevive à remoção do perfil e é reaproveitado
 * quando o perfil volta — sem nova emissão no Let's Encrypt.
 */
const fs = require('fs');
const path = require('path');

process.env.DOMAIN = process.env.DOMAIN || 'brave.rota.ath.cx';
const nginxService = require('../src/services/nginx.service');

const INSTANCIA = { id: 2, port: 4002 };
const SUBDOMINIO = 'chrome2.brave.rota.ath.cx';

describe('certPaths', () => {
  it('aponta para os arquivos do Let\'s Encrypt do subdomínio', () => {
    const { dir, certPath, keyPath } = nginxService.certPaths(SUBDOMINIO);

    expect(dir).toBe(path.join('/etc/letsencrypt/live', SUBDOMINIO));
    expect(certPath).toBe(path.join('/etc/letsencrypt/live', SUBDOMINIO, 'fullchain.pem'));
    expect(keyPath).toBe(path.join('/etc/letsencrypt/live', SUBDOMINIO, 'privkey.pem'));
  });
});

describe('generateServerBlock — antes do certificado existir', () => {
  it('sobe só em HTTP, apontando para a porta da instância', () => {
    const bloco = nginxService.generateServerBlock(INSTANCIA);

    expect(bloco).toContain('# Chrome 2 - Auto-generated');
    expect(bloco).toContain(`server_name ${SUBDOMINIO};`);
    expect(bloco).toContain('proxy_pass         http://localhost:4002;');
    expect(bloco).toContain('listen 80;');
    expect(bloco).not.toContain('ssl_certificate');
    expect(bloco).not.toContain('listen 443');
  });
});

describe('generateSecureServerBlock — certificado reaproveitado', () => {
  it('nasce em HTTPS usando o certificado que já existe', () => {
    const bloco = nginxService.generateSecureServerBlock(INSTANCIA);
    const { certPath, keyPath } = nginxService.certPaths(SUBDOMINIO);

    expect(bloco).toContain('listen 443 ssl;');
    expect(bloco).toContain(`ssl_certificate ${certPath};`);
    expect(bloco).toContain(`ssl_certificate_key ${keyPath};`);
    expect(bloco).toContain('include /etc/letsencrypt/options-ssl-nginx.conf;');
    expect(bloco).toContain('ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;');
    expect(bloco).toContain('proxy_pass         http://localhost:4002;');
  });

  it('redireciona HTTP para HTTPS, como o certbot faria', () => {
    const bloco = nginxService.generateSecureServerBlock(INSTANCIA);

    expect(bloco).toContain('listen 80;');
    expect(bloco).toContain('return 301 https://$host$request_uri;');
    // Dois blocos: o de 443 e o de redirecionamento.
    expect(bloco.match(/^server \{/gm).length).toBe(2);
  });
});

describe('hasReusableCert — quando o certificado pode ser reaproveitado', () => {
  afterEach(() => jest.restoreAllMocks());

  it('sem os arquivos do certificado, não reaproveita', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);

    expect(nginxService.hasReusableCert(SUBDOMINIO)).toBe(false);
  });

  it('com certificado válido, reaproveita', () => {
    const valido = { validTo: new Date(Date.now() + 80 * 24 * 3600 * 1000).toUTCString() };
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readFileSync').mockReturnValue('PEM');
    jest.spyOn(require('crypto'), 'X509Certificate').mockImplementation(() => valido);

    expect(nginxService.hasReusableCert(SUBDOMINIO)).toBe(true);
  });

  it('certificado a menos de 24h do vencimento é reemitido', () => {
    const quaseVencido = { validTo: new Date(Date.now() + 2 * 3600 * 1000).toUTCString() };
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readFileSync').mockReturnValue('PEM');
    jest.spyOn(require('crypto'), 'X509Certificate').mockImplementation(() => quaseVencido);

    expect(nginxService.hasReusableCert(SUBDOMINIO)).toBe(false);
  });
});

describe('isSameAsOnDisk — o vhost só é reescrito quando muda', () => {
  afterEach(() => jest.restoreAllMocks());

  it('arquivo idêntico dispensa reescrita e reload', () => {
    jest.spyOn(fs, 'readFileSync').mockReturnValue('vhost');

    expect(nginxService.isSameAsOnDisk('/etc/nginx/sites-available/chrome2', 'vhost')).toBe(true);
  });

  it('arquivo diferente (formato antigo, por exemplo) manda reescrever', () => {
    jest.spyOn(fs, 'readFileSync').mockReturnValue('vhost antigo');

    expect(nginxService.isSameAsOnDisk('/etc/nginx/sites-available/chrome2', 'vhost novo')).toBe(false);
  });

  it('arquivo ausente manda escrever', () => {
    jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    });

    expect(nginxService.isSameAsOnDisk('/etc/nginx/sites-available/chrome2', 'vhost')).toBe(false);
  });
});

describe('isCertFresh', () => {
  const agora = Date.parse('2026-01-01T00:00:00Z');

  it('folga maior que 24h é fresca', () => {
    expect(nginxService.isCertFresh('2026-03-01T00:00:00Z', agora)).toBe(true);
  });

  it('menos de 24h para vencer não é fresca', () => {
    expect(nginxService.isCertFresh('2026-01-01T10:00:00Z', agora)).toBe(false);
  });

  it('já vencido não é fresco', () => {
    expect(nginxService.isCertFresh('2025-12-01T00:00:00Z', agora)).toBe(false);
  });

  it('data ilegível não bloqueia o reuso', () => {
    expect(nginxService.isCertFresh('nao-e-data', agora)).toBe(true);
  });
});
/**
 * CloakBrowser: o mesmo subdomínio responde por dois caminhos, na MESMA porta.
 *
 * Os caminhos do CDP vão para o DevTools do Chrome (é por eles que o
 * Playwright/Puppeteer conectam); todo o resto é a tela do KasmVNC. Quem separa
 * os dois, dentro do container, é o roteador — o nginx só manda os caminhos do
 * CDP com os cabeçalhos que o Chrome exige. Sem essa separação a URL de conexão
 * e a da tela brigariam pela raiz do subdomínio.
 */
describe('generateServerBlock — instância CloakBrowser', () => {
  const CLOAK = { id: 2, port: 4002, browser: 'cloakbrowser' };

  it('manda os caminhos do CDP para a porta do navegador', () => {
    const bloco = nginxService.generateServerBlock(CLOAK);

    for (const caminho of nginxService.CDP_PATHS) {
      expect(bloco).toContain(`location ${caminho} {`);
    }
    expect(bloco).toContain('proxy_pass         http://localhost:4002;');
  });

  it('manda a raiz para a tela — a mesma porta do roteador', () => {
    const bloco = nginxService.generateServerBlock(CLOAK);

    expect(bloco).toContain('location / {');
    expect(bloco).toContain('proxy_pass         http://localhost:4002;');
  });

  it('os dois caminhos convivem no mesmo vhost HTTPS', () => {
    const bloco = nginxService.generateSecureServerBlock(CLOAK);

    expect(bloco).toContain('location /json/ {');
    expect(bloco).toContain('location /devtools/ {');
    // CDP e tela saem pela MESMA porta publicada (o roteador separa por caminho).
    expect(bloco.match(/proxy_pass         http:\/\/localhost:4002;/g).length).toBe(
      nginxService.CDP_PATHS.length + 1
    );
    // Dois blocos: o de 443 e o de redirecionamento.
    expect(bloco.match(/^server \{/gm).length).toBe(2);
  });

  it('passa o Upgrade/Connection nos dois caminhos (WebSocket do CDP e da tela)', () => {
    const bloco = nginxService.generateSecureServerBlock(CLOAK);
    // Os caminhos do CDP existem nos DOIS vhosts (443 e 80) e a tela só no 443.
    const esperado = nginxService.CDP_PATHS.length * 2 + 1;

    expect(bloco.match(/proxy_set_header   Upgrade {4}\$http_upgrade;/g).length).toBe(esperado);
  });

  it('Chromium/Brave continuam com um caminho só', () => {
    const bloco = nginxService.generateServerBlock({ id: 4, port: 4004, browser: 'chromium' });

    expect(bloco).toContain('location / {');
    expect(bloco).not.toContain('location /json/ {');
    expect(bloco.match(/location /g).length).toBe(1);
  });

  // O Chrome monta a URL da sessão como `ws://<host>/devtools/...`; se a porta
  // 80 redirecionasse para HTTPS, o handshake do Playwright morreria.
  it('na porta 80 os caminhos do CDP são servidos sem redirect', () => {
    const bloco = nginxService.generateSecureServerBlock(CLOAK);
    const [https, http] = bloco.split(/^server \{/gm).slice(1);

    for (const caminho of nginxService.CDP_PATHS) {
      expect(http).toContain(`location ${caminho} {`);
    }
    expect(http).toContain('proxy_pass         http://localhost:4002;');
    // Só a raiz (a tela) é que sobe para HTTPS.
    expect(http).toContain('return 301 https://$host$request_uri;');
    expect(https).not.toContain('return 301');
  });

  it('Chromium/Brave continuam subindo tudo para HTTPS na porta 80', () => {
    const bloco = nginxService.generateSecureServerBlock({ id: 4, port: 4004, browser: 'chromium' });
    const [https, http] = bloco.split(/^server \{/gm).slice(1);

    expect(http).not.toContain('location /json/ {');
    expect(http.trim()).toContain('return 301 https://$host$request_uri;');
    expect(https).toContain('location / {');
  });
});

/**
 * O Chrome do CloakBrowser recusa qualquer Host que não seja IP/localhost
 * ("Host header is specified and is not an IP address or localhost" — HTTP 500)
 * e monta o `webSocketDebuggerUrl` a partir desse Host. Por isso os caminhos do
 * CDP trocam o Host para 127.0.0.1:<porta> e reescrevem o corpo de volta para o
 * endereço público: sem isso o Playwright/Puppeteer receberiam um endereço de
 * loopback, inalcançável de fora do servidor.
 */
describe('generateServerBlock — Host e WebSocket do CDP', () => {
  const CLOAK = { id: 2, port: 4002, browser: 'cloakbrowser' };

  it('manda Host de IP:porta nos caminhos do CDP', () => {
    const bloco = nginxService.generateServerBlock(CLOAK);

    expect(bloco).toContain('proxy_set_header   Host       127.0.0.1:4002;');
    // Um por caminho do CDP.
    expect(bloco.match(/Host       127\.0\.0\.1:4002;/g).length)
      .toBe(nginxService.CDP_PATHS.length);
  });

  it('reescreve o webSocketDebuggerUrl do corpo para o host público', () => {
    const http = nginxService.generateServerBlock(CLOAK);
    const https = nginxService.generateSecureServerBlock(CLOAK);

    // Em HTTP o cliente conecta em ws://; em HTTPS, em wss://.
    expect(http).toContain(`sub_filter         'ws://127.0.0.1:4002' 'ws://${SUBDOMINIO}';`);
    expect(https).toContain(`sub_filter         'ws://127.0.0.1:4002' 'wss://${SUBDOMINIO}';`);
  });

  it('descomprime a resposta (o sub_filter só vê texto puro)', () => {
    const bloco = nginxService.generateServerBlock(CLOAK);

    expect(bloco).toContain('proxy_set_header   Accept-Encoding "";');
    expect(bloco).toContain('sub_filter_types   application/json;');
    expect(bloco).toContain('sub_filter_once    off;');
  });

  it('a tela (raiz) mantém o Host original — quem responde é o KasmVNC', () => {
    const bloco = nginxService.generateServerBlock(CLOAK);
    const raiz = bloco.slice(bloco.indexOf('location / {'));

    expect(raiz).toContain('proxy_set_header   Host       $host;');
    expect(raiz).not.toContain('sub_filter');
  });

  it('Chromium/Brave não levam nenhuma dessas regras', () => {
    const bloco = nginxService.generateSecureServerBlock({ id: 4, port: 4004, browser: 'chromium' });

    expect(bloco).not.toContain('sub_filter');
    expect(bloco).toContain('proxy_set_header   Host       $host;');
  });
});
