/**
 * HttpHeadersService
 *
 * Reescreve, no fio, os cabeçalhos que identificam o navegador: `User-Agent` e
 * os User-Agent Client Hints (`Sec-CH-UA*`).
 *
 * Por que existe: a extensão de fingerprint (content.js) sobrescreve o que o
 * JavaScript enxerga, mas os cabeçalhos HTTP saem do binário — o servidor via
 * `X11; Linux x86_64` enquanto a página via macOS. Este módulo fecha essa
 * lacuna, e é usado pelo proxy MITM (mitm-proxy.service).
 *
 * Regra de ouro: os valores daqui têm de ser EXATAMENTE os mesmos que o
 * content.js publica em `navigator.userAgentData`, senão a página passa a ter
 * duas versões diferentes de si mesma — que é o defeito que estamos consertando.
 * As constantes abaixo espelham content.js (CH_GREASE_BRAND / CH_GREASE_VERSION)
 * e fingerprint.service (brandList / clientHintsFor).
 */

// Marcador "GREASE" que o Chrome real envia. Precisa bater com o content.js.
const CH_GREASE_BRAND = 'Not/A)Brand';
const CH_GREASE_VERSION = '24';

// Cabeçalhos de Client Hints que descrevem o navegador. `Sec-CH-UA-Platform` e
// `Sec-CH-UA-Platform-Version` NÃO entram: são controlados pela política de
// fingerprint do Chromium e mexer neles aqui só criaria divergência.
const REWRITTEN_HINTS = [
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-full-version',
  'sec-ch-ua-full-version-list',
  'sec-ch-ua-arch',
  'sec-ch-ua-bitness',
  'sec-ch-ua-model',
  'sec-ch-ua-wow64'
];

/** Nome de cabeçalho em minúsculas, para comparação. */
function lower(name) {
  return String(name || '').toLowerCase();
}

/** Valor da UA reduzida: `Chrome/154.0.0.0` sai da UA completa do perfil. */
function reducedUa(userAgent) {
  return String(userAgent || '');
}

/**
 * Lista de marcas no formato do cabeçalho `Sec-CH-UA`.
 * @param {string} major versão maior ("154")
 */
function brandList(major) {
  return [
    { brand: 'Chromium', version: String(major) },
    { brand: 'Google Chrome', version: String(major) },
    { brand: CH_GREASE_BRAND, version: CH_GREASE_VERSION }
  ];
}

/** Serializa marcas no formato do cabeçalho: `"Chromium";v="154", ...`. */
function serializeBrands(brands) {
  return brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
}

/**
 * Cabeçalhos de identidade derivados de um fingerprint.
 *
 * @param {object} fingerprint fingerprint do perfil (contrato do content.js)
 * @returns {object|null} mapa nome->valor, ou null se não há UA no perfil
 */
function headersFor(fingerprint) {
  const fp = fingerprint && typeof fingerprint === 'object' ? fingerprint : null;
  const userAgent = fp && fp.userAgent ? String(fp.userAgent) : '';
  if (!userAgent) return null;

  const hints = fp.clientHints && typeof fp.clientHints === 'object' ? fp.clientHints : {};
  const uaMatch = /Chrome\/(\d+)/.exec(userAgent);
  const major = hints.chromeMajor != null
    ? String(hints.chromeMajor)
    : (uaMatch ? uaMatch[1] : '0');
  // A UA é reduzida (Chrome/154.0.0.0) mas os hints expõem o build completo
  // (154.0.8037.92). As duas formas coexistem no Chrome real.
  const fullVersion = hints.fullVersion || (uaMatch ? uaMatch[1] + '.0.0.0' : major + '.0.0.0');

  const brands = brandList(major);
  const fullBrands = brands.map((b) => ({
    brand: b.brand,
    // O GREASE mantém a versão fixa também na lista completa.
    version: b.brand === CH_GREASE_BRAND ? CH_GREASE_VERSION : fullVersion
  }));

  return {
    'user-agent': reducedUa(userAgent),
    'sec-ch-ua': serializeBrands(brands),
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-full-version': `"${fullVersion}"`,
    'sec-ch-ua-full-version-list': serializeBrands(fullBrands),
    // Arquitetura coerente com a plataforma do perfil: macOS é arm64, Windows
    // é x86. Sem isto o servidor vê "x86" numa UA de Mac.
    'sec-ch-ua-arch': `"${hints.platform === 'macOS' ? 'arm' : 'x86'}"`,
    'sec-ch-ua-bitness': '"64"',
    'sec-ch-ua-model': '""',
    'sec-ch-ua-wow64': '?0'
  };
}

/**
 * Reescreve um bloco de cabeçalhos (sem a linha de requisição).
 *
 * Preserva a ordem original e o resto dos cabeçalhos byte a byte; só substitui
 * (ou acrescenta) os de identidade. Cabeçalhos de identidade que o cliente não
 * mandou NÃO são inventados — um Chrome que não pediu `Sec-CH-UA-Arch` não deve
 * passar a pedir.
 *
 * @param {string} block cabeçalhos separados por CRLF, sem a linha de requisição
 * @param {object} headers mapa nome->valor vindo de headersFor()
 * @returns {string} bloco reescrito
 */
function rewriteBlock(block, headers) {
  if (!headers) return block;
  const lines = String(block).split('\r\n');
  const seen = new Set();
  const out = [];

  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx === -1) {
      out.push(line);
      continue;
    }
    const name = lower(line.slice(0, idx).trim());
    if (Object.prototype.hasOwnProperty.call(headers, name)) {
      seen.add(name);
      out.push(`${line.slice(0, idx)}: ${headers[name]}`);
      continue;
    }
    out.push(line);
  }

  // Nada de acrescentar hints que o cliente não pediu: um Chrome que não enviou
  // `Sec-CH-UA-Arch` não deve passar a enviar só porque sabemos o valor. `seen`
  // existe para deixar essa intenção explícita e para o teste poder cobri-la.
  void seen;

  return out.join('\r\n');
}

/**
 * Reescreve uma requisição HTTP inteira (linha de requisição + cabeçalhos).
 * @param {string} head cabeçalho completo, terminando em CRLFCRLF
 * @param {object} headers mapa nome->valor
 */
function rewriteRequestHead(head, headers) {
  if (!headers) return head;
  const sep = head.indexOf('\r\n\r\n');
  const block = sep === -1 ? head : head.slice(0, sep);
  const tail = sep === -1 ? '' : head.slice(sep);
  const nl = block.indexOf('\r\n');
  if (nl === -1) return head;
  const requestLine = block.slice(0, nl);
  const rest = block.slice(nl + 2);
  return requestLine + '\r\n' + rewriteBlock(rest, headers) + tail;
}

module.exports = {
  CH_GREASE_BRAND,
  CH_GREASE_VERSION,
  REWRITTEN_HINTS,
  brandList,
  serializeBrands,
  headersFor,
  rewriteBlock,
  rewriteRequestHead
};
