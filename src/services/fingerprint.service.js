const fs = require('fs');
const path = require('path');
const tar = require('tar-stream');
const Docker = require('dockerode');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const EXTENSION_DIR = path.join(__dirname, '..', 'fingerprint-extension');
// Subpasta dentro de /config onde a extensão é descompactada.
const EXT_SUBDIR = 'fp-extension';
const CONTAINER_EXT_PATH = `/config/${EXT_SUBDIR}`;
// O putArchive extrai no path de destino; /config sempre existe na imagem.
const INJECT_BASE_PATH = '/config';

// Bancos de valores realistas para gerar fingerprints variados por perfil.
const PLATFORMS = [
  { ua: 'Windows NT 10.0; Win64; x64', platform: 'Win32', vendor: 'Google Inc.' },
  { ua: 'Macintosh; Intel Mac OS X 10_15_7', platform: 'MacIntel', vendor: 'Apple Computer, Inc.' },
  { ua: 'X11; Linux x86_64', platform: 'Linux x86_64', vendor: 'Google Inc.' }
];
const SCREENS = [
  [1920, 1080], [1366, 768], [1536, 864], [1440, 900], [1280, 720], [2560, 1440]
];
const TIMEZONES = [
  'America/Sao_Paulo', 'America/New_York', 'Europe/Lisbon', 'Europe/London',
  'Europe/Berlin', 'Europe/Madrid', 'America/Chicago', 'America/Denver'
];
const LOCALES = [
  ['pt-BR', 'pt'], ['en-US', 'en'], ['es-ES', 'es'], ['en-GB', 'en-GB'], ['de-DE', 'de']
];
const GPUS = [
  { vendor: 'Intel Inc.', renderer: 'Intel Iris OpenGL Engine' },
  { vendor: 'Intel Inc.', renderer: 'Intel UHD Graphics 630' },
  { vendor: 'NVIDIA Corporation', renderer: 'NVIDIA GeForce GTX 1650/PCIe/SSE2' },
  { vendor: 'AMD', renderer: 'AMD Radeon Pro 5500M OpenGL Engine' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel UHD Graphics 630)' }
];

class FingerprintService {
  /**
   * Gera um fingerprint determinístico a partir de um seed (id do perfil).
   * O mesmo seed sempre produz o mesmo fingerprint — igual ao GoLogin,
   * onde cada perfil tem uma identidade fixa e consistente entre sessões.
   * A estrutura de saída casa EXATAMENTE com o contrato do content.js.
   */
  generate(seed) {
    const rnd = this._mulberry32(this._hash(String(seed)));
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

    const platformInfo = pick(PLATFORMS);
    const [w, h] = pick(SCREENS);
    const gpu = pick(GPUS);
    const locale = pick(LOCALES);
    const chromeMajor = 130 + Math.floor(rnd() * 10);
    const dpr = pick([1, 2]);
    const isMobile = false;

    return {
      seed: String(seed),
      userAgent: `Mozilla/5.0 (${platformInfo.ua}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`,
      appVersion: `5.0 (${platformInfo.ua}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`,
      platform: platformInfo.platform,
      vendor: platformInfo.vendor,
      product: 'Gecko',
      hardwareConcurrency: pick([4, 8, 8, 12, 16]),
      deviceMemory: pick([4, 8, 8, 16]),
      maxTouchPoints: isMobile ? 5 : 0,
      language: locale[0],
      languages: locale,
      doNotTrack: rnd() > 0.5 ? '1' : null,
      pluginsCount: pick([3, 5, 5, 8]),
      timezone: pick(TIMEZONES),
      screen: {
        width: w,
        height: h,
        availWidth: w,
        availHeight: h - pick([40, 60, 80]),
        availLeft: 0,
        availTop: 0,
        colorDepth: pick([24, 30]),
        pixelDepth: pick([24, 30]),
        outerWidth: w,
        outerHeight: h - pick([80, 90, 100]),
        innerWidth: w - pick([0, 15]),
        innerHeight: h - pick([80, 120, 140]),
        devicePixelRatio: dpr
      },
      webgl: {
        vendor: gpu.vendor,
        renderer: gpu.renderer
      }
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
   * Substitui o marcador /*__FINGERPRINT__* / pelo JSON do fingerprint no content.js.
   */
  _buildContent(fingerprint) {
    const template = fs.readFileSync(path.join(EXTENSION_DIR, 'content.js'), 'utf-8');
    const json = JSON.stringify(fingerprint);
    return template.replace('/*__FINGERPRINT__*/', json);
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
// ExpÃµe o caminho onde a extensÃ£o fica dentro do container, para que o
// docker.service possa montar o --load-extension corretamente.
module.exports.CONTAINER_EXT_PATH = CONTAINER_EXT_PATH;
