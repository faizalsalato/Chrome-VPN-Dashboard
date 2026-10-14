/**
 * ChromeVersionService
 *
 * Descobre a versão MAJOR do navegador que a imagem do container realmente
 * instala.
 *
 * Por que isso importa: o Chrome anuncia a própria versão nos Client Hints
 * (`navigator.userAgentData`), e o whoer.net lê justamente dali. Um UA gerado
 * com "Chrome/135" num binário 154 aparece como duas versões diferentes na
 * mesma página — contradição que denuncia o perfil.
 *
 * A detecção roda no máximo uma vez por imagem e fica em cache. Sem Docker
 * (testes, CI, host sem socket) cai no valor de referência.
 */
const { execFileSync } = require('child_process');
const cloakbrowser = require('./cloakbrowser.service');

const CHROME_IMAGE = 'lscr.io/linuxserver/chromium:latest';
const BRAVE_IMAGE = 'lscr.io/linuxserver/brave:latest';
// Valor de referência, usado só quando não dá para perguntar ao Docker.
const FALLBACK_CHROME_MAJOR = 154;
const FALLBACK_BRAVE_MAJOR = 154;
// Formato completo que os Client Hints anunciam (uaFullVersion).
const FALLBACK_SUFFIX = '.0.0.0';
// Versão de navegador plausível: abaixo disso é lixo de saída de comando.
const MIN_PLAUSIBLE_MAJOR = 50;
const DETECT_TIMEOUT_MS = 20000;
const VERSION_PROBE =
  'chromium --version 2>/dev/null || brave --version 2>/dev/null || brave-browser --version 2>/dev/null';

const cache = new Map();

function imageFor(browser) {
  if (browser === 'brave') return BRAVE_IMAGE;
  if (cloakbrowser.isCloakBrowser(browser)) return cloakbrowser.image();
  return CHROME_IMAGE;
}

function fallbackFor(browser) {
  return browser === 'brave' ? FALLBACK_BRAVE_MAJOR : FALLBACK_CHROME_MAJOR;
}

/** Versão completa de referência quando o Docker não responde. */
function fallbackVersionFor(browser) {
  if (cloakbrowser.isCloakBrowser(browser)) return cloakbrowser.FALLBACK_VERSION;
  return String(fallbackFor(browser)) + FALLBACK_SUFFIX;
}

/** Comando que revela a versão dentro da imagem do navegador. */
function probeFor(browser) {
  return cloakbrowser.isCloakBrowser(browser) ? cloakbrowser.versionProbe() : VERSION_PROBE;
}

/** Extrai a versão da saída do comando de cada imagem. */
function parseFor(browser, output) {
  return cloakbrowser.isCloakBrowser(browser)
    ? cloakbrowser.versionOf(output)
    : versionOf(output);
}

/** Extrai "154.0.8037.92" de "Chromium 154.0.8037.92 built on Debian ...". */
function versionOf(output) {
  const match = String(output).match(/(\d+\.\d+\.\d+(?:\.\d+)?)/);
  if (!match) return null;
  const major = parseInt(match[1], 10);
  if (!Number.isFinite(major) || major < MIN_PLAUSIBLE_MAJOR) return null;
  return match[1];
}

/** Extrai o major de uma versão detectada. */
function majorOf(output) {
  const version = versionOf(output);
  return version ? parseInt(version, 10) : null;
}

/**
 * Pergunta a versão à imagem. O Chromium/Brave respondem a `--version`; o
 * CloakBrowser responde ao próprio comando de diagnóstico (`cloakbrowser info`).
 */
function detect(browser) {
  const output = execFileSync(
    'docker',
    ['run', '--rm', '--entrypoint', 'sh', imageFor(browser), '-c', probeFor(browser)],
    { encoding: 'utf-8', timeout: DETECT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] }
  );
  return parseFor(browser, output);
}

/**
 * Versão completa do navegador desta imagem (ex.: "154.0.8037.92"); nunca lança.
 *
 * A UA do Chrome é reduzida para "Chrome/<major>.0.0.0", mas os Client Hints
 * (uaFullVersion/fullVersionList) expõem o build completo — por isso as duas
 * formas são necessárias para o perfil não contradizer o próprio navegador.
 */
function versionFor(browser = 'chromium') {
  const override = parseInt(process.env.CHROME_MAJOR || '', 10);
  if (Number.isFinite(override) && override >= MIN_PLAUSIBLE_MAJOR) {
    return String(override) + FALLBACK_SUFFIX;
  }

  if (cache.has(browser)) return cache.get(browser);

  let detected = null;
  try {
    detected = detect(browser);
  } catch (err) {
    detected = null;
  }

  const resolved = detected || fallbackVersionFor(browser);
  cache.set(browser, resolved);
  return resolved;
}

/** Major do navegador desta imagem. */
function majorFor(browser = 'chromium') {
  return parseInt(versionFor(browser), 10);
}

module.exports = {
  versionFor,
  majorFor,
  versionOf,
  majorOf,
  imageFor,
  fallbackVersionFor,
  CHROME_IMAGE,
  BRAVE_IMAGE,
  FALLBACK_CHROME_MAJOR,
  FALLBACK_BRAVE_MAJOR,
  _clearCache() {
    cache.clear();
  }
};
