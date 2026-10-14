const fs = require('fs');
const path = require('path');
const tar = require('tar-stream');
const Docker = require('dockerode');
const localeProfile = require('./locale-profile.service');
const chromeVersion = require('./chrome-version.service');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const EXTENSION_DIR = path.join(__dirname, '..', 'fingerprint-extension');
// Subpasta dentro de /config onde a extensão é descompactada.
const EXT_SUBDIR = 'fp-extension';
const CONTAINER_EXT_PATH = `/config/${EXT_SUBDIR}`;
// O putArchive extrai no path de destino; /config sempre existe na imagem.
const INJECT_BASE_PATH = '/config';
// Trecho do template que o injetor substitui: `var FP = /*__FINGERPRINT__*/ null;`.
// O ` null` é o fallback que mantém a cópia do repositório carregável sem
// injeção — ele sai junto na substituição, senão o arquivo injetado fica
// `var FP = {...} null;` e o content script morre com SyntaxError (a extensão
// carrega e não aplica nada).
const FP_MARKER = '/*__FINGERPRINT__*/ null';

// Bancos de valores realistas para gerar identidades variadas por perfil.
// Idioma e fuso NÃO estão aqui: eles vêm da localização da VPN/proxy, para que
// o perfil nunca contradiga o IP de saída.
// Apenas desktops reais. Linux fica de fora de propósito: o navegador roda num
// container Linux headless, então uma persona Linux faria o perfil bater com o
// sistema real do host — e o whoer.net passaria a acusar "Linux", que é a cara
// de automação.
const PLATFORMS = [
  { ua: 'Windows NT 10.0; Win64; x64', platform: 'Win32', vendor: 'Google Inc.' },
  { ua: 'Macintosh; Intel Mac OS X 10_15_7', platform: 'MacIntel', vendor: 'Apple Computer, Inc.' }
];
// Resolução única: a de um notebook comum (1366x768), que é o que o usuário vê
// na tela — o X do container nasce nesse tamanho, igual ao que o perfil anuncia
// nas flags `--fingerprint-screen-*`. 1536x864 e 1280x720 ficaram de fora por
// serem a resolução padrão do Chrome headless (denunciavam o container);
// 1366x768 é monitor/tela real.
// De propósito NÃO é uma lista com sorteio: todo perfil usa o mesmo tamanho.
const SCREENS = [
  [1366, 768]
];
const GPUS = [
  { vendor: 'Intel Inc.', renderer: 'Intel Iris OpenGL Engine' },
  { vendor: 'Intel Inc.', renderer: 'Intel UHD Graphics 630' },
  { vendor: 'NVIDIA Corporation', renderer: 'NVIDIA GeForce GTX 1650/PCIe/SSE2' },
  { vendor: 'AMD', renderer: 'AMD Radeon Pro 5500M OpenGL Engine' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel UHD Graphics 630)' }
];

// Client Hints derivados da plataforma da UA (navigator.platform).
const CLIENT_HINT_PLATFORMS = {
  Win32: { platform: 'Windows', platformVersion: '10.0.0' },
  MacIntel: { platform: 'macOS', platformVersion: '15.0.0' }
};

/** Bloco de Client Hints coerente com a plataforma e a versão informadas. */
function clientHintsFor(platform, fullVersion) {
  const known = CLIENT_HINT_PLATFORMS[platform] || CLIENT_HINT_PLATFORMS.Win32;
  return {
    chromeMajor: parseInt(fullVersion, 10),
    fullVersion,
    platform: known.platform,
    platformVersion: known.platformVersion
  };
}

/** Aceita string (país), objeto de localização ou nada. */
function normalizeLocationArg(location) {
  if (!location) return {};
  if (typeof location === 'string') return { country: location };
  if (typeof location === 'object') return location;
  return {};
}

class FingerprintService {
  /**
   * Gera um fingerprint determinístico a partir de um seed (id do perfil) e
   * alinhado a uma localização (VPN/proxy): idioma, lista de idiomas e fuso
   * horário saem sempre da localização, o resto da identidade do seed.
   *
   * @param {string} seed
   * @param {object|string} [location] país/localização de saída.
   * @returns {object} fingerprint no contrato consumido pelo content.js.
   */
  generate(seed, location) {
    const rnd = this._mulberry32(this._hash(String(seed)));
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

    const platformInfo = pick(PLATFORMS);
    const [width, height] = pick(SCREENS);
    const gpu = pick(GPUS);
    // Versão REAL do binário instalado: o Chrome anuncia a própria versão nos
    // Client Hints, então um número inventado vira duas versões na mesma
    // página (UA x userAgentData) — exatamente o que o whoer.net pegou.
    const chromeFullVersion = chromeVersion.versionFor();
    const chromeMajor = parseInt(chromeFullVersion, 10);
    const devicePixelRatio = pick([1, 2]);
    const profile = localeProfile.fromLocation(normalizeLocationArg(location));

    return Object.assign(
      {
        seed: String(seed),
        userAgent: `Mozilla/5.0 (${platformInfo.ua}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`,
        appVersion: `5.0 (${platformInfo.ua}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`,
        platform: platformInfo.platform,
        vendor: platformInfo.vendor,
        product: 'Gecko',
        hardwareConcurrency: pick([4, 8, 8, 12, 16]),
        deviceMemory: pick([4, 8, 8, 16]),
        maxTouchPoints: 0,
        doNotTrack: rnd() > 0.5 ? '1' : null,
        pluginsCount: pick([3, 5, 5, 8]),
        screen: {
          width,
          height,
          availWidth: width,
          availHeight: height - pick([40, 60, 80]),
          availLeft: 0,
          availTop: 0,
          colorDepth: pick([24, 30]),
          pixelDepth: pick([24, 30]),
          outerWidth: width,
          outerHeight: height - pick([80, 90, 100]),
          innerWidth: width - pick([0, 15]),
          innerHeight: height - pick([80, 120, 140]),
          devicePixelRatio
        },
        webgl: {
          vendor: gpu.vendor,
          renderer: gpu.renderer
        },
        // Dados dos User-Agent Client Hints. A UA do Chrome é reduzida
        // (Chrome/<major>.0.0.0), mas fullVersionList/uaFullVersion expõem o
        // build completo — o content.js replica essa mesma distinção.
        clientHints: clientHintsFor(platformInfo.platform, chromeFullVersion)
      },
      this._localeFields(profile)
    );
  }

  /**
   * Reescreve apenas idioma/fuso/geo de um fingerprint existente, preservando
   * a identidade (userAgent, tela, GPU, hardware). Usado quando a localização
   * real da saída muda (VPN reconecta em outra cidade, proxy troca de IP).
   */
  relocate(fingerprint, location) {
    const current = fingerprint && typeof fingerprint === 'object' ? fingerprint : {};
    const profile = localeProfile.fromLocation(normalizeLocationArg(location));
    return Object.assign({}, current, this._localeFields(profile));
  }

  /** Campos derivados da localização, no contrato do content.js. */
  _localeFields(profile) {
    return {
      language: profile.language,
      languages: profile.languages.slice(),
      timezone: profile.timezone,
      geo: {
        country: profile.country,
        countryCode: profile.countryCode,
        city: profile.city,
        region: profile.region,
        ip: profile.ip,
        timezone: profile.timezone,
        source: profile.source
      }
    };
  }

  /**
   * Alinha um fingerprint existente à versão REAL do navegador da imagem.
   *
   * Perfis criados antes deste ajuste carregam uma versão inventada (a UA dizia
   * "Chrome/135" num binário 154) e não têm Client Hints. O Chrome anuncia a
   * versão real em `navigator.userAgentData`, então as duas formas discordavam
   * entre si na mesma página. A identidade do perfil (seed, tela, GPU,
   * plataforma) é preservada — só a versão é corrigida.
   *
   * @returns {{fingerprint: object|null, changed: boolean}}
   */
  alignBrowserVersion(fingerprint) {
    const current = fingerprint && typeof fingerprint === 'object' ? fingerprint : null;
    if (!current || !current.userAgent) return { fingerprint: current, changed: false };

    const fullVersion = chromeVersion.versionFor();
    const major = parseInt(fullVersion, 10);
    const expectedHints = clientHintsFor(current.platform, fullVersion);
    const ua = String(current.userAgent);
    const uaHasRealMajor = new RegExp(`Chrome/${major}\\.`).test(ua);
    const hints = current.clientHints || {};
    const hintsMatch = hints.chromeMajor === major &&
      hints.fullVersion === fullVersion &&
      hints.platform === expectedHints.platform;

    if (uaHasRealMajor && hintsMatch) return { fingerprint: current, changed: false };

    const reduced = `Chrome/${major}.0.0.0`;
    return {
      fingerprint: Object.assign({}, current, {
        userAgent: uaHasRealMajor ? ua : ua.replace(/Chrome\/[\d.]+/, reduced),
        appVersion: String(current.appVersion || '').replace(/Chrome\/[\d.]+/, reduced),
        clientHints: expectedHints
      }),
      changed: true
    };
  }

  /**
   * Injeta a extensão de fingerprint (com o fingerprint embutido no content.js)
   * dentro do container chrome via docker putArchive. Funciona com container parado.
   *
   * @param {string} containerName
   * @param {object} fingerprint  objeto gerado por generate() (ou customizado)
   * @returns {Promise<string>} caminho da extensão no container
   */
  async inject(containerName, fingerprint) {
    const manifest = fs.readFileSync(path.join(EXTENSION_DIR, 'manifest.json'), 'utf-8');
    const content = this._buildContent(fingerprint);

    const files = {
      [`${EXT_SUBDIR}/manifest.json`]: manifest,
      [`${EXT_SUBDIR}/content.js`]: content
    };
    // Nota: os cabeçalhos HTTP (User-Agent e Sec-CH-UA-*) continuam sendo os do
    // binário Linux. Reescrevê-los exigiria um proxy com MITM para HTTPS —
    // `declarativeNetRequest` no manifest faz o Chrome recusar a extensão
    // carregada por --load-extension, e sem a extensão o JS também não é
    // mascarado. Ver README (limitação conhecida).

    const pack = tar.pack();
    for (const [name, data] of Object.entries(files)) {
      const buffer = Buffer.from(data, 'utf-8');
      pack.entry({ name, size: buffer.length }, buffer);
    }
    pack.finalize();

    const container = docker.getContainer(containerName);
    await container.putArchive(pack, { path: INJECT_BASE_PATH });
    return CONTAINER_EXT_PATH;
  }

  /**
   * Substitui o marcador (com o fallback) pelo JSON do fingerprint no content.js.
   * Lança se o template não tiver o marcador: falhar aqui é melhor do que
   * publicar um content script quebrado dentro do container.
   */
  _buildContent(fingerprint) {
    const template = fs.readFileSync(path.join(EXTENSION_DIR, 'content.js'), 'utf-8');
    if (!template.includes(FP_MARKER)) {
      throw new Error(`Marcador de fingerprint ausente em content.js (${FP_MARKER})`);
    }
    return template.replace(FP_MARKER, JSON.stringify(fingerprint));
  }

  _hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  // PRNG determinístico (mulberry32) — mesma seed, mesma sequência.
  _mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
}

module.exports = new FingerprintService();
// Expõe o caminho onde a extensão fica dentro do container, para que o
// docker.service possa montar o --load-extension corretamente.
module.exports.CONTAINER_EXT_PATH = CONTAINER_EXT_PATH;
// Marcador esperado no template (usado pelo teste que valida o build injetado).
module.exports.FP_MARKER = FP_MARKER;
// Caminho da extensão no repositório (o teste valida o template real).
module.exports.EXTENSION_DIR = EXTENSION_DIR;
