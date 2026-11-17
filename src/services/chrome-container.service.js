/**
 * ChromeContainerService
 *
 * Monta a especificação do container do navegador (Chromium ou Brave) a partir
 * do perfil: fuso horário (TZ), idioma (`--lang`/`--accept-lang`), proxy e a
 * extensão de fingerprint. O TZ do sistema e o idioma do navegador saem SEMPRE
 * do mesmo perfil que o JS da página, para que não haja contradição entre o IP
 * de saída, o relógio e o Accept-Language.
 */
const Docker = require('dockerode');
const localeProfile = require('./locale-profile.service');
const cloakbrowser = require('./cloakbrowser.service');
const chromiumImage = require('./chromium-image.service');
const firefox = require('./firefox.service');
const dnsRouting = require('./dns-routing.service');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// Imagem DERIVADA da LinuxServer: a oficial sem o --test-type no wrapper. O
// CloakBrowser nao passa por aqui (la o --test-type e opt-in).
const CHROME_IMAGE = chromiumImage.image();
const BRAVE_IMAGE = 'lscr.io/linuxserver/brave:latest';
const FIREFOX_IMAGE = 'lscr.io/linuxserver/firefox:latest';
// Flags base do Chromium (headless-friendly). Preservadas pelo wrapper do LinuxServer.
const BASE_CLI = '--no-sandbox --disable-gpu --disable-dev-shm-usage';
// Caminho da extensão de fingerprint dentro do container (bate com o
// EXT_SUBDIR do fingerprint.service — há teste garantindo a igualdade).
const EXTENSION_CONTAINER_PATH = '/config/fp-extension';
const PUID = '1000';
const PGID = '1000';
const DEFAULT_TIMEZONE = 'Etc/UTC';
// O CloakBrowser sobe KasmVNC (Xvnc) + Chrome: mesmo /dev/shm folgado do Brave.
const SHM_SIZE = {
  chromium: 536870912,
  brave: 1073741824,
  cloakbrowser: 1073741824,
  // O Firefox/Selkies e tao sedento de /dev/shm quanto o Brave.
  firefox: 1073741824
};
const BROWSERS = ['chromium', 'cloakbrowser', 'firefox'];
// 'brave' saiu das opções (a UI só oferece Chromium e CloakBrowser), mas o
// suporte fica: uma instância antiga gravada como brave segue a funcionar, em
// vez de virar Chromium sem avisar.
const LEGACY_BROWSERS = ['brave'];
const DISPLAY_PORT = '3000/tcp';
const HOST_GATEWAY_ALIAS = 'host.docker.internal:host-gateway';

/** Normaliza o navegador pedido; qualquer valor desconhecido vira chromium. */
function normalizeBrowser(browser) {
  if (BROWSERS.includes(browser) || LEGACY_BROWSERS.includes(browser)) return browser;
  return 'chromium';
}

/**
 * Imagem do navegador escolhido no perfil. Aceita o `config` inteiro (que traz
 * a edição do CloakBrowser) ou só o nome do navegador.
 */
function imageFor(configOrBrowser) {
  const config = typeof configOrBrowser === 'string' ? { browser: configOrBrowser } : (configOrBrowser || {});
  if (config.browser === 'brave') return BRAVE_IMAGE;
  if (config.browser === 'firefox') return FIREFOX_IMAGE;
  if (cloakbrowser.isCloakBrowser(config.browser)) return cloakbrowser.image(config.cloakEdition);
  return CHROME_IMAGE;
}

/** Variável de flags do navegador (Chromium e Brave leem nomes diferentes). */
function cliVarFor(browser) {
  return browser === 'brave' ? 'BRAVE_CLI' : 'CHROME_CLI';
}

/**
 * Porta que o navegador expõe DENTRO do container: Chromium/Brave servem a
 * área de trabalho na 3000; no CloakBrowser tanto o CDP (9222) quanto a tela do
 * KasmVNC (9225) ficam no loopback, e quem expõe os dois para fora — com UMA
 * porta — é o roteador do `cloakbrowser.service` na 9223. É esta porta que o
 * gluetun publica no modo VPN.
 */
function internalPortFor(browser) {
  return cloakbrowser.isCloakBrowser(browser) ? cloakbrowser.ROUTER_PORT : DISPLAY_PORT;
}

class ChromeContainerService {
  /**
   * Endereço do proxy visto de dentro do container.
   * Proxy autenticado passa pelo forwarder local, que injeta o
   * Proxy-Authorization (o Chrome não aceita user:pass na flag).
   */
  proxyServerFor(config) {
    if (config.type !== 'proxy' || !config.proxy) return null;
    // MITM primeiro: ele já sabe falar com o proxy upstream (inclusive com
    // credenciais), e é o único caminho que reescreve User-Agent/Sec-CH-UA*.
    if (config.mitmPort) {
      return `http://host.docker.internal:${config.mitmPort}`;
    }
    // SOCKS5 autenticado: o Chrome aponta para o NOSSO relay, que injeta a
    // credencial no handshake e resolve o nome pelo resolvedor do pais. Sem
    // isto o Chrome teria de falar com o upstream, nao saberia a credencial e
    // o DNS seria o do proxy.
    if (config.proxy.scheme === 'socks5' && config.relayPort) {
      return `socks5://host.docker.internal:${config.relayPort}`;
    }
    if (config.proxy.auth && config.forwarderPort) {
      return `http://host.docker.internal:${config.forwarderPort}`;
    }
    const scheme = config.proxy.scheme || 'http';
    return `${scheme}://${config.proxy.host}:${config.proxy.port}`;
  }

  /**
   * Hosts cujo certificado o Chrome deve aceitar do MITM.
   *
   * Vem de MITM_HOSTS (lista separada por vírgula) — é configuração, não
   * descoberta: emitir certificado para um host que o Chrome não visita só
   * aumentaria a lista de pins sem motivo. Os hosts de checagem de IP e de
   * login são os que mais interessam, porque são os que leem os cabeçalhos.
   */
  mitmHosts() {
    const configured = String(process.env.MITM_HOSTS || '').trim();
    const list = (configured || 'ipinfo.io,ip-api.com,api.ipify.org,www.google.com,accounts.google.com,example.com')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    return list;
  }

  /** Pins SPKI dos hosts do MITM, para o --ignore-certificate-errors-spki-list. */
  mitmPins(config) {
    if (!config || !config.mitmPort) return [];
    const mitmProxy = require('./mitm-proxy.service');
    return mitmProxy.pinsFor(this.mitmHosts());
  }
  /** Linha de flags do navegador para este perfil. */
  buildCli(config) {
    // O Firefox nao le CHROME_CLI/BRAVE_CLI: as flags abaixo nao teriam efeito
    // nele (a configuracao entra por policies.json, ver firefox.service).
    // Devolver string vazia e melhor do que empilhar flags que ninguem le.
    if (firefox.isFirefox(config.browser)) return '';

    const flags = [BASE_CLI];
    const fingerprint = config.fingerprint || null;

    if (fingerprint && fingerprint.language) {
      flags.push(`--lang=${fingerprint.language}`);
    }
    if (fingerprint && Array.isArray(fingerprint.languages) && fingerprint.languages.length) {
      flags.push(`--accept-lang=${localeProfile.acceptLanguage(fingerprint.languages)}`);
    }

    const proxyServer = this.proxyServerFor(config);
    if (proxyServer) flags.push(`--proxy-server=${proxyServer}`);
    if (fingerprint) flags.push(`--load-extension=${EXTENSION_CONTAINER_PATH}`);

    // MITM: o Chrome precisa aceitar o certificado que o proxy local apresenta.
    // O pin SPKI é mais estreito do que instalar uma CA no container — o Chrome
    // aceita exatamente os certificados cujo SPKI estiver nesta lista, e nada
    // mais. Os hosts são os que o perfil costuma abrir; qualquer outro host que
    // o Chrome visite por HTTPS passa por túnel cego, sem inspeção.
    if (config.mitmPort) {
      const pins = this.mitmPins(config);
      if (pins.length) {
        flags.push(`--ignore-certificate-errors-spki-list=${pins.join(',')}`);
      }
    }

    // A página inicial é a MESMA nas três imagens: a constante vive no
    // cloakbrowser.service (é ele quem monta o comando do CloakBrowser) e aqui
    // só é reusada, para o Chromium e o Brave abrirem no mesmo lugar. Vai por
    // último porque uma URL solta no fim do CHROME_CLI/BRAVE_CLI é o que o
    // wrapper da LinuxServer manda o binário abrir.
    flags.push(cloakbrowser.HOME_URL);

    return flags.join(' ');
  }

  /** Ambiente do container: TZ e idioma vêm do perfil do fingerprint. */
  buildEnv(config) {
    // O CloakBrowser não lê CHROME_CLI: as flags dele vão no comando do
    // container (o roteador e o binário) e o fuso continua vindo do perfil.
    if (cloakbrowser.isCloakBrowser(config.browser)) {
      return cloakbrowser.containerEnv(config);
    }
    if (firefox.isFirefox(config.browser)) {
      return firefox.containerEnv(config);
    }

    const fingerprint = config.fingerprint || {};
    const timezone = fingerprint.timezone || DEFAULT_TIMEZONE;
    return [
      `PUID=${PUID}`,
      `PGID=${PGID}`,
      `TZ=${timezone}`,
      `${cliVarFor(config.browser)}=${this.buildCli(config)}`
    ];
  }

  /** Mapa das variáveis que controlamos (usado para detectar mudança de spec). */
  desiredEnv(config) {
    const map = {};
    for (const entry of this.buildEnv(config)) {
      const eq = entry.indexOf('=');
      map[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return map;
  }

  buildHostConfig(config) {
    const hostConfig = {
      ShmSize: SHM_SIZE[config.browser] || SHM_SIZE.chromium,
      RestartPolicy: { Name: 'unless-stopped' }
    };

    if (config.type === 'vpn') {
      // Compartilha o namespace de rede do gluetun: todo o tráfego sai no túnel.
      hostConfig.NetworkMode = `container:${config.gluetunName}`;
    } else {
      // O CloakBrowser expõe o roteador (9223: CDP + tela por caminho), o
      // Chromium/Brave servem a área de trabalho (3000): é esta porta que o
      // nginx acessa.
      hostConfig.PortBindings = { [internalPortFor(config.browser)]: [{ HostPort: String(config.port) }] };
      // O CloakBrowser aceita usuário:senha na própria URL do proxy, então não
      // precisa do forwarder — o host.docker.internal é só do Chromium/Brave.
      if (!cloakbrowser.isCloakBrowser(config.browser)) {
        hostConfig.ExtraHosts = [HOST_GATEWAY_ALIAS];
      }

      // DNS do país: no modo proxy o navegador não partilha o namespace do
      // gluetun, por isso o resolvedor tem de ser apontado explicitamente.
      // Só se aplica quando há resolução local (SOCKS5/Firefox); com proxy HTTP
      // o nome vai no CONNECT e o resolvedor local nunca é consultado.
      if (config.dnsResolver && config.dnsResolver.ip) {
        hostConfig.Dns = [config.dnsResolver.ip];
        hostConfig.DnsOptions = ['timeout:2', 'attempts:2'];
      }
    }

    // O CloakBrowser é o único que precisa de volume: o do perfil
    // (`cloakbrowser-profile-<id>`), que guarda cookies/login e sobrevive à
    // recriação do container quando o fuso/idioma do perfil mudam. A tela não
    // precisa de volume algum: quem a serve é o KasmVNC dentro do próprio
    // container do navegador.
    if (cloakbrowser.isCloakBrowser(config.browser)) {
      const binds = [cloakbrowser.profileBind(config.id)];
      // A edição "nova" baixa o binário mais recente do vendor para um cache
      // partilhado: o volume faz o download acontecer uma vez, e não a cada
      // recriação do container.
      if (cloakbrowser.editionOf(config) === 'pro') {
        binds.push(cloakbrowser.cacheBind());
      }
      hostConfig.Binds = binds;
    }

    return hostConfig;
  }

  /** Opções completas de docker.createContainer para o perfil. */
  buildCreateOptions(config) {
    const options = {
      Image: imageFor(config),
      name: `chrome${config.id}`,
      Env: this.buildEnv(config),
      HostConfig: this.buildHostConfig(config)
    };

    // O CloakBrowser recebe as flags pelo comando: o entrypoint da imagem faz
    // `exec "$@"` (o CHROME_CLI não existe nessa imagem).
    if (cloakbrowser.isCloakBrowser(config.browser)) {
      options.Cmd = cloakbrowser.serveCommand(config);
    }
    // O Firefox recebe a politica gerida pelo ENTRYPOINT, nao pelo Cmd: a
    // imagem declara Entrypoint=["/init"] e, se o script fosse Cmd, o /init
    // recebia-o como argumento e o s6 abortava ("can only run as pid 1").
    if (firefox.isFirefox(config.browser)) {
      options.Entrypoint = firefox.serveCommand(config);
    }

    // Nota: sem ExposedPorts no modo VPN — o Chrome compartilha o namespace de
    // rede do gluetun (declarar ExposedPorts junto com NetworkMode
    // "container:" é rejeitado pelo Docker).
    if (config.type !== 'vpn') {
      options.ExposedPorts = { [internalPortFor(config.browser)]: {} };
    }
    return options;
  }

  async create(config) {
    return docker.createContainer(this.buildCreateOptions(config));
  }

  async remove(id) {
    const container = docker.getContainer(`chrome${id}`);
    try {
      await container.remove({ force: true });
    } catch (err) {
      if (err.statusCode !== 404) throw err;
    }
  }

  /** Remove o volume do perfil (a sessão morre junto com a instância). */
  async removeProfileVolume(id) {
    try {
      await docker.getVolume(cloakbrowser.profileVolume(id)).remove({ force: true });
    } catch (err) {
      if (err.statusCode !== 404) throw err;
    }
  }

  /** Container existe? Devolve o inspect ou null. */
  async inspect(id) {
    try {
      return await docker.getContainer(`chrome${id}`).inspect();
    } catch (err) {
      if (err.statusCode === 404) return null;
      throw err;
    }
  }

  /**
   * true quando o container atual já está com a imagem, o TZ, o idioma e a
   * rede que o perfil exige (ou seja, não precisa recriar).
   */
  matchesSpec(info, config) {
    if (!info) return false;
    if (info.Config.Image !== imageFor(config)) return false;

    // No CloakBrowser o proxy viaja no comando do container: trocar de proxy
    // (ou de modo headless) exige recriar o container.
    if (cloakbrowser.isCloakBrowser(config.browser)) {
      const desiredCmd = this.buildCreateOptions(config).Cmd || [];
      if (JSON.stringify(info.Config.Cmd || []) !== JSON.stringify(desiredCmd)) return false;
    }
    // O Firefox vive no Entrypoint: e ele que tem de bater certo, senao a
    // instancia antiga (com o script no lugar errado) nunca seria recriada.
    if (firefox.isFirefox(config.browser)) {
      const desiredEntry = this.buildCreateOptions(config).Entrypoint || [];
      if (JSON.stringify(info.Config.Entrypoint || []) !== JSON.stringify(desiredEntry)) return false;
    }

    const desired = this.desiredEnv(config);
    const actual = {};
    for (const entry of info.Config.Env || []) {
      const eq = entry.indexOf('=');
      if (eq > 0) actual[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    for (const [key, value] of Object.entries(desired)) {
      if (actual[key] !== value) return false;
    }

    const hostConfig = info.HostConfig || {};
    if (config.type === 'vpn') {
      if (hostConfig.NetworkMode !== `container:${config.gluetunName}`) return false;
    } else if (hostConfig.NetworkMode === `container:${config.gluetunName}`) {
      return false;
    }

    // O resolvedor mudou (troca de país do proxy) exige recriar: o Dns de um
    // container em execução não pode ser alterado.
    const desiredDns = config.dnsResolver && config.dnsResolver.ip
      ? [config.dnsResolver.ip] : [];
    const actualDns = hostConfig.Dns || [];
    if (JSON.stringify(actualDns) !== JSON.stringify(desiredDns)) return false;

    // O volume do perfil precisa estar montado: é o motivo para recriar as
    // instâncias criadas antes desta versão.
    if (cloakbrowser.isCloakBrowser(config.browser)) {
      const binds = hostConfig.Binds || [];
      if (!binds.includes(cloakbrowser.profileBind(config.id))) return false;
    }

    return true;
  }

  /**
   * Garante que o container do Chrome existe com a spec do perfil, recriando-o
   * quando o fuso/idioma mudaram (ex.: a VPN reconectou em outro país).
   * A extensão de fingerprint vive dentro do container, então quem recria
   * precisa re-injetar depois.
   *
   * @returns {Promise<{exists: boolean, created: boolean, recreated: boolean}>}
   */
  async ensure(config) {
    const info = await this.inspect(config.id);

    if (!info) {
      await this.create(config);
      await this._ensureDnsNetwork(config);
      return { exists: true, created: true, recreated: false };
    }

    if (this.matchesSpec(info, config)) {
      await this._ensureDnsNetwork(config);
      return { exists: true, created: false, recreated: false };
    }

    await this.remove(config.id);
    await this.create(config);
    await this._ensureDnsNetwork(config);
    return { exists: true, created: true, recreated: true };
  }

  /**
   * Liga o container à rede dos gluetuns para que o resolvedor do país seja
   * alcançável. Sem isto o DOCKER-ISOLATION bloqueia o tráfego entre as redes
   * bridge (172.17.x) e rotaproxy_default (172.18.x) — medido no servidor.
   * Idempotente: o serviço verifica se já está ligado.
   */
  async _ensureDnsNetwork(config) {
    if (!config.dnsResolver || !config.dnsResolver.network) return;
    try {
      await dnsRouting.ensureNetwork(`chrome${config.id}`);
    } catch (err) {
      console.warn(`[WARN] [dns-routing] Falha ao ligar chrome${config.id} à rede do resolvedor:`, err.message);
    }
  }
}

module.exports = new ChromeContainerService();
module.exports.CHROME_IMAGE = CHROME_IMAGE;
module.exports.BRAVE_IMAGE = BRAVE_IMAGE;
module.exports.FIREFOX_IMAGE = FIREFOX_IMAGE;
module.exports.EXTENSION_CONTAINER_PATH = EXTENSION_CONTAINER_PATH;
module.exports.SHM_SIZE = SHM_SIZE;
module.exports.imageFor = imageFor;
module.exports.cliVarFor = cliVarFor;
module.exports.normalizeBrowser = normalizeBrowser;
module.exports.internalPortFor = internalPortFor;
module.exports.BROWSERS = BROWSERS;
