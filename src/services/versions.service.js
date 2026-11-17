/**
 * VersionsService — o que está instalado e o que existe mais novo.
 *
 * Três perguntas, três fontes distintas, e nenhuma delas é chute:
 *
 *  1. INSTALADO — qual versão o binário da imagem realmente reporta. Vem do
 *     chrome-version.service, que roda `--version` dentro da imagem.
 *
 *  2. REGISTRY — a imagem local está atrasada? Compara o digest que o host tem
 *     (`RepoDigests`) com o digest que o registry publica agora
 *     (`docker manifest inspect`, que consulta sem baixar). Digest diferente =
 *     imagem nova publicada. É a resposta honesta para "tem atualização?".
 *
 *  3. UPSTREAM — qual é a versão stable do Chrome hoje, segundo o Google
 *     (versionhistory.googleapis.com). Serve de referência: o linuxserver
 *     costuma ficar atrás do stable oficial, e ver a distância evita achar que
 *     o binário está quebrado quando só está uma release atrás.
 *
 * Tudo é defensivo: sem Docker, sem rede ou sem CLI, o campo vira null com o
 * motivo em `error`. Nada aqui lança — a página admin não pode cair porque o
 * registry não respondeu.
 */
const { execFileSync } = require('child_process');
const https = require('https');
const chromeVersion = require('./chrome-version.service');
const cloakbrowser = require('./cloakbrowser.service');
const cloakLicenses = require('./cloak-licenses.service');

// O registry é consultado no máximo a cada 5 min: a página admin atualiza a
// cada 15s e não faz sentido bater no registry a cada poll.
const CACHE_TTL_MS = 5 * 60 * 1000;
const CLI_TIMEOUT_MS = 25000;
const HTTP_TIMEOUT_MS = 10000;

// Canal stable do Chrome para Linux, na API pública de histórico de versões.
const CHROME_STABLE_URL =
  'https://versionhistory.googleapis.com/v1/chrome/platforms/linux/channels/stable/versions?pageSize=1';

// O Firefox NAO esta na API de historico do Chrome: o stable dele vem do
// product-details da Mozilla, o mesmo arquivo que o proprio Firefox consulta
// para saber se ha atualizacao. Campo: LATEST_FIREFOX_VERSION.
const FIREFOX_STABLE_URL =
  'https://product-details.mozilla.org/1.0/firefox_versions.json';

const cache = new Map();

/** Executa um comando e devolve stdout; erro vira null (nunca lança). */
function run(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf-8',
      timeout: CLI_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch (err) {
    return null;
  }
}

/** GET simples com timeout; devolve o corpo em JSON ou null. */
function fetchJson(url) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };

    try {
      const target = new URL(url);
      const req = https.request(
        {
          host: target.hostname,
          port: target.port || 443,
          path: target.pathname + target.search,
          method: 'GET',
          headers: { Accept: 'application/json' },
          timeout: HTTP_TIMEOUT_MS
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            if (res.statusCode >= 400) return finish(null);
            try {
              finish(JSON.parse(data));
            } catch (err) {
              finish(null);
            }
          });
        }
      );
      req.on('timeout', () => { req.destroy(); finish(null); });
      req.on('error', () => finish(null));
      req.end();
    } catch (err) {
      finish(null);
    }
  });
}

/** Digest local da imagem (o que o host tem em disco), ou null. */
function localDigest(image) {
  const raw = run('docker', ['image', 'inspect', image, '--format', '{{json .RepoDigests}}']);
  if (!raw) return null;
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list) || !list.length) return null;
    // "repo@sha256:abc..." -> "sha256:abc..."
    const first = String(list[0]);
    const at = first.indexOf('@');
    return at === -1 ? first : first.slice(at + 1);
  } catch (err) {
    return null;
  }
}

/**
 * Digest que o registry publica AGORA, sem baixar nada.
 *
 * `docker manifest inspect` devolve uma lista de manifests (multi-arquitetura).
 * Interessa o linux/amd64, que é o que o host roda — comparar o digest da lista
 * inteira com o da imagem local daria "diferente" sempre.
 */
function registryDigest(image) {
  const raw = run('docker', ['manifest', 'inspect', image]);
  if (!raw) {
    return {
      digest: null,
      platformDigest: null,
      error: 'registry nao respondeu (docker manifest inspect falhou)'
    };
  }

  try {
    const data = JSON.parse(raw);

    if (Array.isArray(data.manifests)) {
      const amd64 = data.manifests.find((m) => {
        const p = m.platform || {};
        return p.os === 'linux' && p.architecture === 'amd64';
      });
      const platformDigest = amd64 && amd64.digest ? amd64.digest : null;

      // O digest do INDICE nao vem no corpo do manifest inspect: vem no
      // cabecalho Docker-Content-Digest. E o mesmo valor que o host guarda em
      // RepoDigests, entao e o unico que serve para comparar.
      const indexDigest = registryIndexDigest(image);

      return {
        digest: indexDigest || platformDigest,
        platformDigest,
        error: indexDigest
          ? null
          : 'digest do indice indisponivel; usando o da plataforma (pode dar falso positivo)'
      };
    }

    if (data.config && data.config.digest) {
      return { digest: data.config.digest, platformDigest: data.config.digest, error: null };
    }
    return { digest: null, platformDigest: null, error: 'formato de manifest inesperado' };
  } catch (err) {
    return { digest: null, platformDigest: null, error: 'manifest ilegivel' };
  }
}

/**
 * Digest do indice publicado no registry.
 *
 * ARMADILHA medida no servidor: RepoDigests guarda o digest do INDICE
 * multi-arquitetura, nao o da plataforma. Prova:
 *   RepoDigests           -> sha256:ff6c82ba...  (indice)
 *   manifest amd64        -> sha256:5f4b2b5d...  (plataforma)
 *   Docker-Content-Digest -> sha256:ff6c82ba...  (indice, confirmado na API)
 * Comparar indice com plataforma daria atualizacao para sempre.
 */
function registryIndexDigest(image) {
  // Via 1: a API do registry. E a unica que funciona neste host — `docker
  // buildx` nao existe na instalacao (medido: "unknown command: docker
  // buildx"), e `docker manifest inspect` devolve so os digests das
  // plataformas, nunca o do indice.
  const viaRegistry = registryDigestFromApi(image);
  if (viaRegistry) return viaRegistry;

  // Via 2: buildx, quando existir (noutros hosts).
  const raw = run('docker', ['buildx', 'imagetools', 'inspect', image, '--format', '{{json .Manifest}}']);
  if (raw) {
    try {
      const data = JSON.parse(raw);
      if (data && data.digest) return data.digest;
    } catch (err) {
      // segue
    }
  }

  return null;
}

/**
 * Digest do indice lido da API do registry (cabecalho Docker-Content-Digest).
 *
 * Fluxo do protocolo OCI:
 *   1. HEAD /v2/<repo>/manifests/<tag> sem token -> 401 com www-authenticate
 *   2. pede token ao realm indicado, com o scope do repositorio
 *   3. repete o HEAD com Bearer -> 200 e Docker-Content-Digest
 *
 * Devolve null em qualquer falha: quem chama decide o que fazer com a falta.
 */
function registryDigestFromApi(image) {
  const parsed = parseImageRef(image);
  if (!parsed) return null;

  const accept = [
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.oci.image.manifest.v1+json'
  ].join(',');

  const manifestUrl = `https://${parsed.registry}/v2/${parsed.repo}/manifests/${parsed.tag}`;

  // 1. sem token: o registry responde 401 com o desafio de auth no cabecalho.
  const first = curlHeaders(['-sI', manifestUrl]);
  if (!first) return null;
  if (first.digest) return first.digest;
  if (first.status !== 401) return null;

  // 2. token no realm indicado, com o scope do repositorio.
  const challenge = parseChallenge(first.authenticate);
  if (!challenge || !challenge.realm) return null;
  const scope = challenge.scope || `repository:${parsed.repo}:pull`;
  let tokenUrl = `${challenge.realm}?scope=${encodeURIComponent(scope)}`;
  if (challenge.service) tokenUrl += `&service=${encodeURIComponent(challenge.service)}`;

  const body = run('curl', ['-s', tokenUrl]);
  if (!body) return null;
  let token = null;
  try {
    const data = JSON.parse(body);
    token = data.token || data.access_token || null;
  } catch (err) {
    return null;
  }
  if (!token) return null;

  // 3. HEAD com Bearer: o cabecalho Docker-Content-Digest e o digest do INDICE.
  const second = curlHeaders(['-sI', '-H', `Authorization: Bearer ${token}`, '-H', `Accept: ${accept}`, manifestUrl]);
  return second && second.digest ? second.digest : null;
}

/**
 * Corre `curl` e devolve os cabecalhos que interessam.
 *
 * Sincrono de proposito: quem chama (registryDigest) e sincrono, e tornar a
 * cadeia toda assincrona so para ler um cabecalho espalharia promessas por
 * tres funcoes. O curl existe no host e nao precisa de biblioteca.
 */
function curlHeaders(args) {
  const out = run('curl', args);
  if (!out) return null;

  const lines = String(out).split(/\r?\n/);
  const statusLine = lines.find((l) => /^HTTP\//.test(l)) || '';
  const status = parseInt(statusLine.split(' ')[1], 10);

  const header = (name) => {
    const prefix = name.toLowerCase() + ':';
    const line = lines.find((l) => l.toLowerCase().startsWith(prefix));
    return line ? line.slice(prefix.length).trim() : null;
  };

  return {
    status: Number.isFinite(status) ? status : 0,
    digest: header('docker-content-digest'),
    authenticate: header('www-authenticate')
  };
}

/** Separa registry, repositorio e tag de uma referencia de imagem. */
function parseImageRef(image) {
  const ref = String(image || '').trim();
  if (!ref) return null;

  const slash = ref.indexOf('/');
  if (slash === -1) return null;
  const registry = ref.slice(0, slash);
  const rest = ref.slice(slash + 1);

  const colon = rest.lastIndexOf(':');
  const repo = colon === -1 ? rest : rest.slice(0, colon);
  const tag = colon === -1 ? 'latest' : rest.slice(colon + 1);
  if (!registry || !repo) return null;
  return { registry, repo, tag };
}

/** Le "Bearer realm=\"...\",service=\"...\",scope=\"...\"". */
function parseChallenge(header) {
  const text = String(header || '');
  if (!text) return null;
  const pick = (key) => {
    const m = text.match(new RegExp(key + '="([^"]*)"'));
    return m ? m[1] : null;
  };
  return { realm: pick('realm'), service: pick('service'), scope: pick('scope') };
}

/** Versão stable do Chrome no canal oficial do Google. */
async function upstreamFirefox() {
  const data = await fetchJson(FIREFOX_STABLE_URL);
  const version = data && data.LATEST_FIREFOX_VERSION;
  if (!version) {
    return { version: null, channel: 'release', error: 'product-details da Mozilla nao respondeu' };
  }
  return { version: String(version), channel: 'release', error: null };
}

/** Versao stable do Chrome no canal oficial do Google. */
async function upstreamChrome() {
  const data = await fetchJson(CHROME_STABLE_URL);
  const first = data && Array.isArray(data.versions) ? data.versions[0] : null;
  if (!first || !first.version) {
    return { version: null, channel: 'stable', error: 'API de versões do Google não respondeu' };
  }
  return { version: first.version, channel: 'stable', error: null };
}

/**
 * Estado do Chromium/Brave: instalado, registry e upstream.
 * @param {string} browser 'chromium' | 'brave'
 */
async function chromeState(browser = 'chromium') {
  const image = chromeVersion.imageFor(browser);
  const installedVersion = chromeVersion.versionFor(browser);
  const local = localDigest(image);
  const remote = registryDigest(image);

  // Só afirma "tem atualização" quando os dois digests existem e diferem. Sem
  // um dos lados, o estado é desconhecido — não "atualizado".
  let updateAvailable = null;
  if (local && remote.digest) updateAvailable = local !== remote.digest;

  const upstream = browser === 'firefox' ? await upstreamFirefox() : await upstreamChrome();

  return {
    browser,
    image,
    installed: {
      version: installedVersion,
      major: parseInt(installedVersion, 10) || null
    },
    registry: {
      localDigest: local,
      remoteDigest: remote.digest,
      platformDigest: remote.platformDigest,
      updateAvailable,
      error: local
        ? remote.error || null
        : 'imagem não está no host' + (remote.error ? ' (' + remote.error + ')' : '')
    },
    upstream: {
      version: upstream.version,
      channel: upstream.channel,
      // Rotulo da FONTE: o Firefox nao esta no historico do Google, e dizer
      // "stable do Google" para ele seria mentira na tela.
      label: browser === 'firefox' ? 'Mozilla (release)' : 'Google (stable)',
      // Quantas majors o binário está atrás do stable oficial (null quando não
      // dá para comparar).
      majorsBehind:
        upstream.version && installedVersion
          ? Math.max(0, parseInt(upstream.version, 10) - parseInt(installedVersion, 10))
          : null,
      error: upstream.error
    },
    checkedAt: new Date().toISOString()
  };
}

/** Estado do CloakBrowser: as duas edições, versão do binário e licenças. */
function cloakState() {
  const free = {
    edition: 'free',
    image: cloakbrowser.image('free'),
    baseImage: cloakbrowser.baseImage('free'),
    version: chromeVersion.versionFor('cloakbrowser')
  };

  // A edição Pro usa a MESMA imagem base por padrão; o que muda é o binário
  // baixado para o cache (com a chave). A versão do binário Pro em cache é
  // lida do volume, não da imagem.
  const proImage = cloakbrowser.image('pro');
  const cachedBinary = run('sh', [
    '-c',
    'ls -d /var/lib/docker/volumes/cloakbrowser-bin/_data/chromium-*/chrome 2>/dev/null | sort -V | tail -1'
  ]);

  let licenses = [];
  let licenseError = null;
  try {
    licenses = cloakLicenses.list();
  } catch (err) {
    licenseError = err.message;
  }

  return {
    free,
    pro: {
      edition: 'pro',
      image: proImage,
      baseImage: cloakbrowser.baseImage('pro'),
      // Sem binário em cache, a edição Pro ainda não baixou nada: usa o da
      // imagem. Dizer isso é mais útil do que fingir uma versão.
      cachedBinary: cachedBinary || null,
      version: cachedBinary ? null : chromeVersion.versionFor('cloakbrowser')
    },
    licenses,
    licenseCount: licenses.length,
    licenseError,
    checkedAt: new Date().toISOString()
  };
}

/**
 * Tudo que a página admin mostra sobre versões.
 * @param {{force?: boolean}} options force ignora o cache do registry
 */
async function snapshot({ force = false } = {}) {
  const key = 'snapshot';
  const now = Date.now();
  const hit = cache.get(key);

  if (!force && hit && now - hit.at < CACHE_TTL_MS) {
    return { ...hit.value, cached: true };
  }

  const [chromium, brave, firefox] = await Promise.all([
    chromeState('chromium'),
    chromeState('brave'),
    chromeState('firefox')
  ]);
  const value = {
    chromium,
    brave,
    firefox,
    cloak: cloakState(),
    cached: false
  };

  cache.set(key, { at: now, value });
  return value;
}

module.exports = {
  snapshot,
  chromeState,
  upstreamFirefox,
  cloakState,
  localDigest,
  registryDigest,
  CACHE_TTL_MS,
  _clearCache() {
    cache.clear();
  }
};
