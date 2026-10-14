/**
 * Regras do navegador antidetect CloakBrowser.
 *
 * O que precisa ficar travado aqui: o comando que sobe o binário COM JANELA no
 * X do container (o KasmVNC, que também dá tela ao perfil), o roteador que
 * publica CDP e tela numa porta só, as flags de fingerprint que levam o
 * fuso/idioma/plataforma alinhados, o volume do perfil e a URL de conexão CDP
 * que o Playwright/Puppeteer usam.
 */
const cloakbrowser = require('../src/services/cloakbrowser.service');

const FINGERPRINT = {
  seed: 'chrome4',
  platform: 'MacIntel',
  timezone: 'Europe/Berlin',
  language: 'de-DE',
  hardwareConcurrency: 8,
  deviceMemory: 16,
  screen: { width: 1920, height: 1080 },
  clientHints: { platform: 'macOS', platformVersion: '15.0.0' },
  geo: { country: 'Germany', countryCode: 'DE', timezone: 'Europe/Berlin' }
};

function proxyConfig(overrides) {
  return Object.assign({
    type: 'proxy',
    id: 4,
    fingerprint: FINGERPRINT,
    proxy: { host: 'brd.superproxy.io', port: 44445, scheme: 'http', auth: false }
  }, overrides);
}

/** Linha de comando montada pelo `serveCommand` (o Cmd do container). */
function commandLine(config) {
  return cloakbrowser.serveCommand(config).join(' ');
}

describe('imagem e identificação', () => {
  it('usa a imagem derivada local (KasmVNC) nas instâncias', () => {
    expect(cloakbrowser.image()).toBe('chrome-vpn-dashboard-browser:latest');
  });

  it('reconhece só o valor "cloakbrowser"', () => {
    expect(cloakbrowser.isCloakBrowser('cloakbrowser')).toBe(true);
    expect(cloakbrowser.isCloakBrowser('chromium')).toBe(false);
    expect(cloakbrowser.isCloakBrowser(undefined)).toBe(false);
  });

  it('permite fixar a imagem base oficial por ambiente', () => {
    const previous = process.env.CLOAKBROWSER_IMAGE;
    process.env.CLOAKBROWSER_IMAGE = 'espelho.local/cloakbrowser:146';
    try {
      expect(cloakbrowser.baseImage()).toBe('espelho.local/cloakbrowser:146');
    } finally {
      if (previous === undefined) delete process.env.CLOAKBROWSER_IMAGE;
      else process.env.CLOAKBROWSER_IMAGE = previous;
    }
  });

  it('cada edição tem a sua imagem (antiga e nova podem coexistir)', () => {
    const previous = process.env.CLOAKBROWSER_IMAGE_FREE;
    process.env.CLOAKBROWSER_IMAGE_FREE = 'cloakhq/cloakbrowser:0.5.12';
    try {
      expect(cloakbrowser.editionOf({ cloakEdition: 'pro' })).toBe('pro');
      expect(cloakbrowser.editionOf('free')).toBe('free');
      expect(cloakbrowser.editionOf({})).toBe('free');

      expect(cloakbrowser.baseImage('free')).toBe('cloakhq/cloakbrowser:0.5.12');
      // A derivada acompanha a TAG da base: sem isso as duas versões
      // sobrescrever-se-iam no host.
      expect(cloakbrowser.image('free')).toBe('chrome-vpn-dashboard-browser:0.5.12');
      expect(cloakbrowser.image('pro')).toBe('chrome-vpn-dashboard-browser:latest');
    } finally {
      if (previous === undefined) delete process.env.CLOAKBROWSER_IMAGE_FREE;
      else process.env.CLOAKBROWSER_IMAGE_FREE = previous;
    }
  });
});

describe('chave de licença por instância', () => {
  const FINGERPRINT_ENV = { timezone: 'Europe/Berlin', screen: { width: 1366, height: 768 } };

  it('leva a chave da biblioteca quando a edição é a nova', () => {
    const env = cloakbrowser.containerEnv({
      cloakEdition: 'pro',
      cloakLicenseKey: 'chave-da-instancia',
      fingerprint: FINGERPRINT_ENV
    });

    expect(env).toContain('CLOAKBROWSER_LICENSE_KEY=chave-da-instancia');
  });

  it('na edição antiga não leva chave nenhuma — nem a do ambiente do dashboard', () => {
    const previous = process.env.CLOAKBROWSER_LICENSE_KEY;
    process.env.CLOAKBROWSER_LICENSE_KEY = 'chave-do-servico';
    try {
      const env = cloakbrowser.containerEnv({ cloakEdition: 'free', fingerprint: FINGERPRINT_ENV });
      expect(env.some((item) => item.startsWith('CLOAKBROWSER_LICENSE_KEY='))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.CLOAKBROWSER_LICENSE_KEY;
      else process.env.CLOAKBROWSER_LICENSE_KEY = previous;
    }
  });
});

describe('semente do binário', () => {
  it('deriva um número de 5 dígitos do seed do perfil', () => {
    const numero = cloakbrowser.seedNumber('chrome4');
    expect(Number.isInteger(numero)).toBe(true);
    expect(numero).toBeGreaterThanOrEqual(cloakbrowser.SEED_MIN);
    expect(numero).toBeLessThanOrEqual(cloakbrowser.SEED_MAX);
  });

  it('é estável: o mesmo perfil mantém a mesma identidade entre reinícios', () => {
    expect(cloakbrowser.seedNumber('chrome4')).toBe(cloakbrowser.seedNumber('chrome4'));
  });

  it('perfis diferentes não compartilham a semente', () => {
    expect(cloakbrowser.seedNumber('chrome4')).not.toBe(cloakbrowser.seedNumber('chrome5'));
  });
});

describe('comando do container (Chrome com janela no X do container)', () => {
  it('lança o binário do CloakBrowser direto no X (sem cloakserve)', () => {
    const command = cloakbrowser.serveCommand({ type: 'vpn', fingerprint: FINGERPRINT });

    expect(command[0]).toBe('/bin/sh');
    expect(commandLine({ type: 'vpn', fingerprint: FINGERPRINT }))
      .toContain('/root/.cloakbrowser/chromium-*/chrome');
    // O cloakserve renderiza fora da tela: nada de janela na tela do KasmVNC.
    expect(commandLine({ type: 'vpn', fingerprint: FINGERPRINT })).not.toContain('cloakserve');
    expect(commandLine({ type: 'vpn', fingerprint: FINGERPRINT })).not.toContain('--headless');
  });

  it('abre o CDP na 9222 e deixa o perfil persistente', () => {
    const line = commandLine({ type: 'vpn', fingerprint: FINGERPRINT });

    expect(line).toContain('--remote-debugging-port=9222');
    expect(line).toContain('--remote-debugging-address=0.0.0.0');
    expect(line).toContain(`--user-data-dir=${cloakbrowser.PROFILE_DIR}`);
    expect(line).toContain(cloakbrowser.WINDOW_FLAG);
  });

  it('sobe o roteador antes do Chrome (CDP e tela ficam só no loopback)', () => {
    const line = commandLine({ type: 'vpn', fingerprint: FINGERPRINT });

    // O heredoc escreve o programa no container; a chamada liga as DUAS portas
    // do loopback (DevTools e tela do KasmVNC) à porta publicada.
    expect(line).toContain(`cat > ${cloakbrowser.ROUTER_CONTAINER_PATH} `);
    expect(line).toContain(
      `python3 ${cloakbrowser.ROUTER_CONTAINER_PATH} ` +
      `--listen ${cloakbrowser.ROUTER_PORT_NUMBER} --cdp ${cloakbrowser.CDP_PORT_NUMBER}` +
      ` --screen ${cloakbrowser.SCREEN_PORT_NUMBER}`
    );
    // O roteador vem primeiro: o `exec` do Chrome é a última coisa da linha.
    expect(line.indexOf('port-router.py')).toBeLessThan(line.indexOf('exec /root/.cloakbrowser'));
  });

  it('abre o Google como página inicial (a tela não sobe em branco)', () => {
    const line = commandLine({ type: 'vpn', fingerprint: FINGERPRINT });

    // Padrão pedido: a tela abre no Google, com caixa de busca à mão.
    expect(cloakbrowser.HOME_URL).toBe('https://www.google.com/');
    expect(line).toContain(cloakbrowser.HOME_URL);
    // `about:blank` era o padrão antigo — tela em branco, sem busca.
    expect(line).not.toContain('about:blank');
  });

  it('a edição "nova" baixa o binário mais recente para o cache partilhado', () => {
    const pro = { type: 'vpn', fingerprint: FINGERPRINT, cloakEdition: 'pro', cloakLicenseKey: 'chave' };
    const script = cloakbrowser.serveCommand(pro)[2];

    // O install corre antes do Chrome e escreve no cache do volume...
    expect(script).toContain(`CLOAKBROWSER_CACHE_DIR=${cloakbrowser.CACHE_DIR}`);
    expect(script).toContain('cloakbrowser install');
    expect(script).toContain(`CLOAK_BIN=$(ls -d ${cloakbrowser.CACHE_DIR}/chromium-*/chrome`);
    // ...e o binário lançado é o do cache (com queda para o da imagem).
    expect(script).toContain('exec "$CLOAK_BIN"');

    expect(cloakbrowser.containerEnv(pro)).toContain(`CLOAKBROWSER_CACHE_DIR=${cloakbrowser.CACHE_DIR}`);
    expect(cloakbrowser.cacheBind()).toBe(`${cloakbrowser.CACHE_VOLUME}:${cloakbrowser.CACHE_DIR}`);
  });

  it('a edição "antiga" continua no binário da imagem, sem install nem cache', () => {
    const script = cloakbrowser.serveCommand({ type: 'vpn', fingerprint: FINGERPRINT })[2];

    expect(script).not.toContain('cloakbrowser install');
    expect(script).toContain('exec /root/.cloakbrowser/chromium-*/chrome');
    expect(cloakbrowser.containerEnv({ fingerprint: FINGERPRINT }))
      .not.toContain(`CLOAKBROWSER_CACHE_DIR=${cloakbrowser.CACHE_DIR}`);
  });

  it('sem proxy não inventa --proxy-server', () => {
    expect(commandLine({ type: 'vpn', fingerprint: FINGERPRINT })).not.toContain('--proxy-server');
  });

  it('no modo proxy passa a URL do proxy (sem credenciais quando não há auth)', () => {
    expect(commandLine(proxyConfig())).toContain('--proxy-server=http://brd.superproxy.io:44445');
  });

  it('credenciais do proxy vão inline e codificadas', () => {
    const line = commandLine(proxyConfig({
      proxy: { host: 'p.example', port: 8080, scheme: 'https', auth: true, user: 'u@x', pass: 'p:a/ss' }
    }));
    expect(line).toContain('--proxy-server=https://u%40x:p%3Aa%2Fss@p.example:8080');
  });

  it('sem proxy configurado não inventa flag', () => {
    expect(cloakbrowser.proxyUrl(null)).toBeNull();
    expect(cloakbrowser.proxyUrl({ host: 'p.example' })).toBeNull();
  });
});

describe('política gerida (motor de busca + DNS)', () => {
  it('escreve a política com o Google como motor padrão', () => {
    const comando = cloakbrowser.policyCommand();

    expect(comando).toContain(`mkdir -p ${cloakbrowser.POLICY_DIR}`);
    expect(comando).toContain(`cat > ${cloakbrowser.POLICY_FILE} <<'${cloakbrowser.POLICY_END_MARKER}'`);
    expect(comando).toContain('"DefaultSearchProviderEnabled":true');

    const politica = cloakbrowser.policy();
    expect(politica.DefaultSearchProviderName).toBe('Google');
    expect(politica.DefaultSearchProviderSearchURL).toBe('https://www.google.com/search?q={searchTerms}');
  });

  it('desliga o DNS-over-HTTPS (senão o DNS aparece noutro país)', () => {
    // Com DoH o nome é resolvido pelo Google: o whoer vê um resolver de outro
    // país e desconta 30% da nota de anonimato.
    expect(cloakbrowser.policy().DnsOverHttpsMode).toBe('off');
  });

  it('desliga a pré-busca de rede e de DNS (o prefetch resolve fora do proxy)', () => {
    expect(cloakbrowser.policy().NetworkPredictionOptions).toBe(2);

    const script = cloakbrowser.serveCommand({ type: 'vpn', fingerprint: FINGERPRINT })[2];
    expect(script).toContain('--dns-prefetch-disable');
  });

  it('apaga o ficheiro de política antigo antes de escrever o novo', () => {
    const comando = cloakbrowser.policyCommand();
    const posicaoRm = comando.indexOf('rm -f');

    expect(posicaoRm).toBeGreaterThan(-1);
    // O Chromium junta os ficheiros da pasta: o antigo não pode sobreviver.
    for (const antigo of cloakbrowser.LEGACY_POLICY_FILES) {
      expect(comando).toContain(`rm -f ${antigo}`);
      expect(posicaoRm).toBeLessThan(comando.indexOf(cloakbrowser.POLICY_FILE));
    }
  });

  it('a política viaja no comando do container, antes do Chrome arrancar', () => {
    const script = cloakbrowser.serveCommand({ type: 'vpn', fingerprint: FINGERPRINT })[2];

    expect(script).toContain(cloakbrowser.POLICY_FILE);
    // O Chrome lê as políticas no arranque: escrever depois não serviria de nada.
    expect(script.indexOf(cloakbrowser.POLICY_FILE))
      .toBeLessThan(script.indexOf('exec /root/.cloakbrowser'));
  });

  it('aceita outro motor por ambiente', () => {
    const anteriorNome = process.env.BROWSER_SEARCH_NAME;
    const anteriorUrl = process.env.BROWSER_SEARCH_URL;
    process.env.BROWSER_SEARCH_NAME = 'DuckDuckGo';
    process.env.BROWSER_SEARCH_URL = 'https://duckduckgo.com/?q={searchTerms}';
    try {
      const politica = cloakbrowser.policy();
      expect(politica.DefaultSearchProviderName).toBe('DuckDuckGo');
      expect(politica.DefaultSearchProviderSearchURL).toBe('https://duckduckgo.com/?q={searchTerms}');
    } finally {
      if (anteriorNome === undefined) delete process.env.BROWSER_SEARCH_NAME;
      else process.env.BROWSER_SEARCH_NAME = anteriorNome;
      if (anteriorUrl === undefined) delete process.env.BROWSER_SEARCH_URL;
      else process.env.BROWSER_SEARCH_URL = anteriorUrl;
    }
  });
});

describe('flags de fingerprint (o que alinha o perfil)', () => {
  it('leva semente, fuso, idioma, plataforma, tela e hardware', () => {
    const line = commandLine({ type: 'vpn', fingerprint: FINGERPRINT });

    expect(line).toContain(`--fingerprint=${cloakbrowser.seedNumber('chrome4')}`);
    expect(line).toContain('--fingerprint-timezone=Europe/Berlin');
    expect(line).toContain('--lang=de-DE');
    expect(line).toContain('--fingerprint-locale=de-DE');
    expect(line).toContain('--fingerprint-platform=macos');
    expect(line).toContain('--fingerprint-platform-version=15.0.0');
    expect(line).toContain('--fingerprint-screen-width=1920');
    expect(line).toContain('--fingerprint-screen-height=1080');
    expect(line).toContain('--fingerprint-hardware-concurrency=8');
    expect(line).toContain('--fingerprint-device-memory=16');
  });

  it('mascara o WebRTC com o IP de saída quando ele é conhecido', () => {
    const fingerprint = Object.assign({}, FINGERPRINT, {
      geo: Object.assign({}, FINGERPRINT.geo, { ip: '185.96.133.239' })
    });

    expect(commandLine({ type: 'vpn', fingerprint })).toContain('--fingerprint-webrtc-ip=185.96.133.239');
    // Sem IP de saída não há o que mascarar.
    expect(commandLine({ type: 'vpn', fingerprint: FINGERPRINT })).not.toContain('--fingerprint-webrtc-ip');
  });

  it('nunca manda campo vazio como texto "undefined"', () => {
    const line = commandLine({ id: 9, type: 'vpn', fingerprint: { seed: 'chrome9' } });

    expect(line).not.toContain('undefined');
    expect(line).not.toContain('null');
    expect(line).toContain(`--fingerprint=${cloakbrowser.seedNumber('chrome9')}`);
    expect(line).not.toContain('--fingerprint-timezone');
    expect(line).not.toContain('--fingerprint-screen-width');
  });

  it('sem fingerprint usa o id do perfil como semente', () => {
    expect(commandLine({ id: 7, type: 'vpn', fingerprint: null }))
      .toContain(`--fingerprint=${cloakbrowser.seedNumber('chrome7')}`);
  });

  it('plataforma Windows também é traduzida', () => {
    expect(cloakbrowser.platformName({ platform: 'Win32' })).toBe('windows');
    expect(cloakbrowser.platformName({ platform: 'MacIntel' })).toBe('macos');
    expect(cloakbrowser.platformName({})).toBe('linux');
  });

  it('não força plataforma quando o perfil não é Windows nem macOS', () => {
    expect(commandLine({ id: 1, type: 'vpn', fingerprint: { seed: 'chrome1' } }))
      .not.toContain('--fingerprint-platform');
  });
});

describe('roteador da porta publicada', () => {
  it('publica UMA porta (9223) para CDP e tela', () => {
    expect(cloakbrowser.ROUTER_PORT).toBe('9223/tcp');
    expect(cloakbrowser.ROUTER_PORT_NUMBER).toBe(9223);
    expect(cloakbrowser.CDP_PORT).toBe('9222/tcp');
    expect(cloakbrowser.CDP_PORT_NUMBER).toBe(9222);
    // A tela do KasmVNC nunca é publicada: quem fala com ela é o roteador.
    expect(cloakbrowser.SCREEN_PORT).toBe('9225/tcp');
    expect(cloakbrowser.SCREEN_PORT_NUMBER).toBe(9225);
  });

  it('embute o programa real do repositório, sem quebrar o heredoc', () => {
    const programa = cloakbrowser.routerProgram();
    const script = cloakbrowser.serveCommand({ type: 'vpn', fingerprint: FINGERPRINT })[2];

    expect(programa).toContain('socket');
    expect(programa).toContain('--listen');
    // O marcador abre e fecha o heredoc: exatamente duas ocorrências.
    expect(script.split('PORT_ROUTER_EOF').length - 1).toBe(2);
    expect(script).toContain(programa.trimEnd());
    // O programa não pode conter o próprio marcador (encerraria o heredoc).
    expect(programa).not.toContain('PORT_ROUTER_EOF');
  });

  it('decide o destino pelo caminho e encaminha para o loopback', () => {
    const programa = cloakbrowser.routerProgram();

    expect(programa).toContain('127.0.0.1');
    expect(programa).toContain('BUFFER_SIZE');
    // Os caminhos do CDP são os mesmos que o nginx separa do resto.
    for (const caminho of ['/json', '/devtools', '/fingerprint']) {
      expect(programa).toContain(caminho);
    }
  });
});

describe('volume do perfil', () => {
  it('mantém cookies/login fora do container', () => {
    expect(cloakbrowser.profileVolume(4)).toBe('cloakbrowser-profile-4');
    expect(cloakbrowser.profileBind(4)).toBe(`cloakbrowser-profile-4:${cloakbrowser.PROFILE_DIR}`);
  });
});

describe('ambiente do container', () => {
  const envOriginal = process.env.CLOAKBROWSER_LICENSE_KEY;

  afterEach(() => {
    if (envOriginal === undefined) delete process.env.CLOAKBROWSER_LICENSE_KEY;
    else process.env.CLOAKBROWSER_LICENSE_KEY = envOriginal;
  });

  it('exporta o TZ do perfil', () => {
    expect(cloakbrowser.containerEnv({ fingerprint: FINGERPRINT })).toContain('TZ=Europe/Berlin');
  });

  it('cai em Etc/UTC quando o perfil não tem fuso', () => {
    expect(cloakbrowser.containerEnv({})).toContain('TZ=Etc/UTC');
  });

  it('a licença deixou de vir do ambiente: agora é por instância (biblioteca)', () => {
    // Antes a chave vinha de CLOAKBROWSER_LICENSE_KEY do serviço. Agora vem da
    // biblioteca de chaves, por instância — o ambiente do dashboard NÃO licencia
    // nada (senão a edição "antiga", sem chave, acabaria licenciada sem querer).
    process.env.CLOAKBROWSER_LICENSE_KEY = 'abc123';
    expect(cloakbrowser.containerEnv({ fingerprint: FINGERPRINT })
      .some((e) => e.startsWith('CLOAKBROWSER_LICENSE_KEY='))).toBe(false);
  });
});

describe('endereços públicos da instância', () => {
  it('monta a URL de descoberta e a de conexão do CDP', () => {
    const cdp = cloakbrowser.describe('chrome4.sakr.ath.cx', FINGERPRINT);

    expect(cdp.port).toBe(9222);
    expect(cdp.endpointUrl).toBe('https://chrome4.sakr.ath.cx');
    expect(cdp.discoveryUrl).toBe('https://chrome4.sakr.ath.cx/json/version');
    expect(cdp.seed).toBe(cloakbrowser.seedNumber('chrome4'));
  });

  // O Chrome devolve a URL da sessão como `ws://<host>/devtools/...`; um
  // endpoint em HTTPS que redireciona quebraria o handshake do Playwright.
  it('conecta por HTTP (é o caminho onde o WebSocket do CDP fecha)', () => {
    expect(cloakbrowser.describe('chrome4.sakr.ath.cx', FINGERPRINT).connectUrl)
      .toBe('http://chrome4.sakr.ath.cx');
  });

  it('aponta a tela para o cliente do KasmVNC na raiz do subdomínio (sem query)', () => {
    const esperado = 'https://chrome4.sakr.ath.cx/';

    expect(cloakbrowser.desktopUrl('chrome4.sakr.ath.cx')).toBe(esperado);
    expect(cloakbrowser.describe('chrome4.sakr.ath.cx', FINGERPRINT).desktopUrl).toBe(esperado);
  });
});

describe('versão do Chromium embutido', () => {
  it('lê a versão da saída de `cloakbrowser info`', () => {
    const saida = [
      'CloakBrowser diagnostics',
      'Wrapper:   0.6.2',
      'Version:   146.0.7680.177.5 (free)',
      'Launch:    \u2713 Chromium 146.0.7680.177'
    ].join('\n');
    expect(cloakbrowser.versionOf(saida)).toBe('146.0.7680.177');
  });

  it('devolve null quando a saída não traz a versão', () => {
    expect(cloakbrowser.versionOf('sem navegador aqui')).toBeNull();
    expect(cloakbrowser.versionOf('')).toBeNull();
  });

  it('tem um comando de sonda próprio da imagem', () => {
    expect(cloakbrowser.versionProbe()).toContain('cloakbrowser info');
  });
});
