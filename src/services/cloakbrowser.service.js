/**
 * CloakBrowserService
 *
 * Regras do navegador antidetect CloakBrowser (imagem `cloakhq/cloakbrowser`).
 *
 * Diferença central em relação ao Chromium/Brave: a impressão digital não vem
 * de extensão nenhuma — ela é compilada no binário e ligada por flags
 * (`--fingerprint=<seed>`, `--fingerprint-platform=`, `--fingerprint-timezone=`,
 * `--lang=`, `--fingerprint-webrtc-ip=`...). É por essas flags que o perfil
 * alinhado pelo dashboard (fuso, idioma, plataforma, tela) chega ao navegador.
 *
 * A TELA vem do KasmVNC (ver deploy/browser-image/Dockerfile): o servidor X do
 * container é o `Xvnc` do KasmVNC, que já sobe em `:99` no tamanho de tela do
 * perfil e serve o próprio cliente web. É o mesmo stack que o Chromium Linux
 * oficial usa — tela rápida (WebP, ajuste de qualidade), área de transferência
 * nos dois sentidos e redimensionamento pelo navegador sem nenhum container
 * companheiro. O `cloakserve` da imagem fica de fora: em `--headless=false` ele
 * força o backend "ozone headless" nos processos filhos e a tela sai preta.
 *
 * O CDP continua preso no loopback: o binário ignora `--remote-debugging-address`
 * (proteção dele) e o loopback do container não é alcançável pela porta
 * publicada. Quem resolve os dois acessos com UMA porta publicada é o
 * `src/browser/port-router.py` — embutido no comando do container —, que escuta
 * em `0.0.0.0:9223` e encaminha por caminho: `/json`, `/devtools` e
 * `/fingerprint` vão para o CDP (`127.0.0.1:9222`) e todo o resto para a tela
 * (`127.0.0.1:9225`). Assim o gluetun publica exatamente uma porta por
 * instância, como no Chromium/Brave.
 */
const fs = require('fs');
const path = require('path');
const browserImage = require('./browser-image.service');

// Porta do DevTools DENTRO do container (só loopback, ver o comentário acima).
const CDP_PORT = '9222/tcp';
const CDP_PORT_NUMBER = 9222;
// Porta da tela (KasmVNC) DENTRO do container: também só loopback, porque quem
// fala com ela é o roteador. Nada de expor o cliente web direto.
const SCREEN_PORT = '9225/tcp';
const SCREEN_PORT_NUMBER = 9225;
// A ÚNICA porta que sai do container: o roteador (CDP + tela por caminho).
const ROUTER_PORT = '9223/tcp';
const ROUTER_PORT_NUMBER = 9223;
// O roteador é escrito pelo próprio comando do container (heredoc): assim ele
// acompanha a spec (mudar o script recria o container) e não depende de
// nenhuma injeção de arquivo separada.
const ROUTER_SOURCE = path.join(__dirname, '..', 'browser', 'port-router.py');
const ROUTER_CONTAINER_PATH = '/tmp/port-router.py';
const ROUTER_END_MARKER = 'PORT_ROUTER_EOF';
// Semente padrão do binário (v146) — usada só quando o Docker não responde.
const FALLBACK_VERSION = '146.0.7680.177';
// O binário espera um número de 5 dígitos (SEED_MIN/SEED_MAX do wrapper).
const SEED_MIN = 10000;
const SEED_MAX = 99999;
// Perfil persistente (cookies/login) montado neste caminho por um volume.
const PROFILE_DIR = '/profile';
// Binário baixado pela imagem (a versão muda entre releases: por isso o glob).
const CHROME_BINARY = '/root/.cloakbrowser/chromium-*/chrome';
// Janela = tela cheia do X do container, que nasce no tamanho que o perfil
// declara (SCREEN_ENV abaixo).
const WINDOW_FLAG = '--start-maximized';
// Tamanho de tela quando o perfil não traz um: o notebook mais comum. É o mesmo
// padrão do Dockerfile da imagem do navegador (há teste amarrando os dois) e
// vale tanto para o X quanto para as flags --fingerprint-screen-*.
const DEFAULT_SCREEN = { width: 1366, height: 768 };
// O X do container nasce com o tamanho que o perfil anuncia: o binário é
// lançado com --fingerprint-screen-width/height, e um X maior que a tela
// declarada é uma contradição que a própria página enxerga.
const SCREEN_ENV = { width: 'SCREEN_WIDTH', height: 'SCREEN_HEIGHT' };
// Variáveis repassadas ao container quando existem no ambiente do dashboard.
const PASSTHROUGH_ENV = [
  'CLOAKBROWSER_LICENSE_KEY',
  'CLOAKBROWSER_FETCH_WIDEVINE'
];
// Campos do fingerprint que viram `--fingerprint-<nome>=<valor>`.
// O `cloakserve` faz exatamente este mapeamento nas conexões CDP; aqui as
// mesmas chaves entram como flags de lançamento (valem para o processo todo).
const CDP_FP_FIELDS = [
  ['platform-version', (fp) => (fp.clientHints || {}).platformVersion],
  ['hardware-concurrency', (fp) => fp.hardwareConcurrency],
  ['device-memory', (fp) => fp.deviceMemory],
  ['screen-width', (fp) => (fp.screen || {}).width],
  ['screen-height', (fp) => (fp.screen || {}).height]
];

class CloakBrowserService {
  /**
   * Imagem usada nas instâncias: a oficial com o KasmVNC no lugar do Xvfb e com
   * o X no tamanho de tela do perfil (construída localmente, ver
   * browser-image.service).
   */
  image() {
    return browserImage.image();
  }

  /** Imagem oficial que serve de base para o build (sobrescrevível por env). */
  baseImage() {
    return browserImage.baseImage();
  }

  /** O navegador desta instância é o CloakBrowser? */
  isCloakBrowser(browser) {
    return browser === 'cloakbrowser';
  }

  /**
   * Esconder o infobar de `--no-sandbox` com `--test-type`? É opt-in
   * (CLOAKBROWSER_TEST_TYPE=1) por causa do trade-off: o `--test-type` marca o
   * browser como "modo de teste", o que alguns serviços de login e detectores
   * de anti-bot conseguem ver. Só liga quem aceita esse custo em troca de
   * esconder o aviso cosmético.
   */
  testType() {
    const value = String(process.env.CLOAKBROWSER_TEST_TYPE || '').toLowerCase();
    return value === '1' || value === 'true' || value === 'yes' || value === 'on';
  }

  /** URL do proxy com credenciais inline (o binário aceita user:pass na URL). */
  proxyUrl(proxy) {
    if (!proxy || !proxy.host || !proxy.port) return null;
    const scheme = proxy.scheme === 'https' ? 'https' : 'http';
    const host = `${proxy.host}:${proxy.port}`;
    if (!proxy.auth || !proxy.user) return `${scheme}://${host}`;
    const user = encodeURIComponent(proxy.user);
    const pass = encodeURIComponent(proxy.pass || '');
    return `${scheme}://${user}:${pass}@${host}`;
  }

  /**
   * Volume do perfil (cookies, login, histórico). Fica fora do container para
   * que recriar a instância — o que acontece quando fuso/idioma mudam — não
   * apague a sessão do usuário.
   */
  profileVolume(id) {
    return `cloakbrowser-profile-${id}`;
  }

  /** Bind do volume de perfil no container do navegador. */
  profileBind(id) {
    return `${this.profileVolume(id)}:${PROFILE_DIR}`;
  }

  /**
   * Semente numérica do binário a partir do id do perfil ("chrome3").
   *
   * O binário espera 5 dígitos; o wrapper original sorteia e guarda num arquivo.
   * Aqui ela é derivada do seed do dashboard (FNV-1a) porque o perfil precisa
   * manter a MESMA identidade entre reinícios.
   */
  seedNumber(seed) {
    const text = String(seed || '');
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return SEED_MIN + (hash % (SEED_MAX - SEED_MIN + 1));
  }

  /** Plataforma no vocabulário do CloakBrowser ("macos" / "windows"). */
  platformName(fingerprint) {
    const platform = String((fingerprint && fingerprint.platform) || '').toLowerCase();
    if (platform.includes('mac')) return 'macos';
    if (platform.includes('win')) return 'windows';
    return 'linux';
  }

  /**
   * Tamanho de tela do perfil, com o notebook comum como fallback. É o MESMO
   * número que vai para o X (via SCREEN_ENV) e para as flags
   * --fingerprint-screen-*: se discordassem, a página veria um X maior que a
   * tela que ela própria anuncia.
   */
  screen(fingerprint) {
    const screen = (fingerprint && fingerprint.screen) || {};
    const width = parseInt(screen.width, 10);
    const height = parseInt(screen.height, 10);
    return {
      width: Number.isFinite(width) && width > 0 ? width : DEFAULT_SCREEN.width,
      height: Number.isFinite(height) && height > 0 ? height : DEFAULT_SCREEN.height
    };
  }

  /** Variáveis que fazem o X do container nascer no tamanho do perfil. */
  screenEnv(fingerprint) {
    const screen = this.screen(fingerprint);
    return [
      `${SCREEN_ENV.width}=${screen.width}`,
      `${SCREEN_ENV.height}=${screen.height}`
    ];
  }

  /**
   * Flags que levam o perfil alinhado para o binário. Campos vazios ficam de
   * fora (o binário aplica o padrão dele; nunca recebe "undefined").
   */
  fingerprintFlags(config) {
    const fingerprint = (config && config.fingerprint) || {};
    const flags = [`--fingerprint=${this.seedNumber(fingerprint.seed || `chrome${config.id}`)}`];

    const platform = this.platformName(fingerprint);
    if (platform !== 'linux') flags.push(`--fingerprint-platform=${platform}`);

    if (fingerprint.timezone) flags.push(`--fingerprint-timezone=${fingerprint.timezone}`);
    if (fingerprint.language) {
      flags.push(`--lang=${fingerprint.language}`);
      flags.push(`--fingerprint-locale=${fingerprint.language}`);
    }

    for (const [name, read] of CDP_FP_FIELDS) {
      const value = read(fingerprint);
      if (value === undefined || value === null || value === '') continue;
      flags.push(`--fingerprint-${name}=${value}`);
    }

    // Sem proxy não há IP de saída conhecido: só mascara quando ele existe.
    const exitIp = (fingerprint.geo || {}).ip;
    if (exitIp) flags.push(`--fingerprint-webrtc-ip=${exitIp}`);

    if (config && config.type === 'proxy') {
      const proxy = this.proxyUrl(config.proxy);
      if (proxy) flags.push(`--proxy-server=${proxy}`);
    }

    return flags;
  }

  /** Programa do roteador (lido do repositório e embutido no comando). */
  routerProgram() {
    return fs.readFileSync(ROUTER_SOURCE, 'utf-8');
  }

  /**
   * Trecho do comando que escreve o roteador dentro do container e o sobe em
   * background. Ele reconecta a cada conexão, então pode subir antes do Chrome
   * e do KasmVNC existirem — não há corrida entre os três.
   */
  routerCommand() {
    const program = this.routerProgram().trimEnd();
    return [
      `cat > ${ROUTER_CONTAINER_PATH} <<'${ROUTER_END_MARKER}'`,
      program,
      ROUTER_END_MARKER,
      `python3 ${ROUTER_CONTAINER_PATH}` +
        ` --listen ${ROUTER_PORT_NUMBER} --cdp ${CDP_PORT_NUMBER} --screen ${SCREEN_PORT_NUMBER}` +
        ' >/tmp/port-router.log 2>&1 &'
    ].join('\n');
  }

  /**
   * Comando do container: primeiro o roteador (CDP + tela), depois o binário do
   * CloakBrowser lançado direto no X do container. Vai como `sh -lc` porque o
   * caminho do binário tem a versão no nome (glob) e o entrypoint da imagem faz
   * `exec "$@"`.
   */
  serveCommand(config) {
    const parts = [
      'exec',
      CHROME_BINARY,
      '--no-sandbox',
      // Esconde o infobar amarelo "You are using an unsupported command-line
      // flag: --no-sandbox" que o Chromium mostra em modo headed. É obrigatório
      // aqui porque o container corre como root e o AppArmor do host
      // (apparmor_restrict_unprivileged_userns=1) impede o sandbox de
      // namespaces — sem `--no-sandbox` o binário nem arranca. Ressalva: o
      // `--test-type` marca o browser como "modo de teste", o que alguns
      // serviços (login Google) e detectores conseguem ver; por isso só entra
      // quando explicitamente ligado por CLOAKBROWSER_TEST_TYPE (ver abaixo).
      ...(this.testType() ? ['--test-type'] : []),
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
      // Em modo headed o Chromium bloqueia WebGL em GPU de software (X sem
      // GPU): esta flag deixa o SwiftShader servir o WebGL. É o que o wrapper usa.
      '--ignore-gpu-blocklist',
      // O binário ignora este endereço de propósito (prende no loopback); a
      // flag fica porque é a forma padrão de pedir o DevTools ligado. Quem
      // expõe para fora é o roteador acima.
      '--remote-debugging-address=0.0.0.0',
      `--remote-debugging-port=${CDP_PORT_NUMBER}`,
      `--user-data-dir=${PROFILE_DIR}`,
      WINDOW_FLAG,
      ...this.fingerprintFlags(config),
      'about:blank'
    ];
    return ['/bin/sh', '-lc', `${this.routerCommand()}\n${parts.join(' ')}`];
  }

  /**
   * Ambiente do container: fuso do perfil, tamanho de tela do X e as variáveis
   * opcionais repassadas do ambiente do dashboard.
   */
  containerEnv(config) {
    const fingerprint = (config && config.fingerprint) || {};
    const env = [`TZ=${fingerprint.timezone || 'Etc/UTC'}`];
    env.push(...this.screenEnv(fingerprint));
    for (const name of PASSTHROUGH_ENV) {
      const value = process.env[name];
      if (value) env.push(`${name}=${value}`);
    }
    return env;
  }

  /** URL pública do endpoint CDP (o que aparece no cartão da instância). */
  endpointUrl(subdomain) {
    return `https://${subdomain}`;
  }

  /**
   * URL da tela (cliente web do KasmVNC), servida na raiz do subdomínio pelo
   * roteador. Sem query string: parâmetros como `resize=scale` faziam o cliente
   * redimensionar a tela e encolhiam a janela do navegador — o X tem de ficar
   * no tamanho que o perfil anuncia (`--fingerprint-screen-*`).
   */
  desktopUrl(subdomain) {
    return `https://${subdomain}/`;
  }

  /**
   * Bloco CDP exposto pela API para o cartão da instância.
   *
   * `connectUrl` é o endereço que o Playwright/Puppeteer usam em
   * `connect_over_cdp`. Fica em HTTP de propósito: nesse caminho o nginx
   * encaminha `/json/` e `/devtools/` sem redirecionar, e o Chrome monta a URL
   * `ws://` da sessão a partir do Host — que só fecha em `wss` com redireção.
   */
  describe(subdomain, fingerprint) {
    return {
      port: CDP_PORT_NUMBER,
      endpointUrl: this.endpointUrl(subdomain),
      discoveryUrl: `https://${subdomain}/json/version`,
      connectUrl: `http://${subdomain}`,
      desktopUrl: this.desktopUrl(subdomain),
      seed: fingerprint ? this.seedNumber(fingerprint.seed) : null
    };
  }

  /**
   * Versão do Chromium embutido, lida da saída de `cloakbrowser info`
   * ("Launch: ✓ Chromium 146.0.7680.177").
   */
  versionOf(output) {
    const match = String(output || '').match(/Chromium\s+(\d+\.\d+\.\d+(?:\.\d+)?)/);
    return match ? match[1] : null;
  }

  /** Comando usado para perguntar a versão à imagem. */
  versionProbe() {
    return 'cloakbrowser info 2>&1';
  }
}

module.exports = new CloakBrowserService();
module.exports.DEFAULT_IMAGE = browserImage.DEFAULT_IMAGE;
module.exports.DEFAULT_BASE_IMAGE = browserImage.DEFAULT_BASE_IMAGE;
module.exports.DEFAULT_SCREEN = DEFAULT_SCREEN;
module.exports.SCREEN_ENV = SCREEN_ENV;
module.exports.CDP_PORT = CDP_PORT;
module.exports.CDP_PORT_NUMBER = CDP_PORT_NUMBER;
module.exports.SCREEN_PORT = SCREEN_PORT;
module.exports.SCREEN_PORT_NUMBER = SCREEN_PORT_NUMBER;
module.exports.ROUTER_PORT = ROUTER_PORT;
module.exports.ROUTER_PORT_NUMBER = ROUTER_PORT_NUMBER;
module.exports.ROUTER_CONTAINER_PATH = ROUTER_CONTAINER_PATH;
module.exports.ROUTER_SOURCE = ROUTER_SOURCE;
module.exports.ROUTER_END_MARKER = ROUTER_END_MARKER;
module.exports.FALLBACK_VERSION = FALLBACK_VERSION;
module.exports.SEED_MIN = SEED_MIN;
module.exports.SEED_MAX = SEED_MAX;
module.exports.PROFILE_DIR = PROFILE_DIR;
module.exports.WINDOW_FLAG = WINDOW_FLAG;
