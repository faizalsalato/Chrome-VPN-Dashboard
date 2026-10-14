/**
 * LocaleProfileService
 *
 * Converte "onde está a saída da conexão" (país/cidade/fuso de uma VPN ou de
 * um proxy) em um perfil de localização coerente com o navegador:
 * navigator.language/languages, timezone (Intl/Date) e Accept-Language.
 *
 * O fingerprint do perfil usa este serviço para nunca divergir do IP de saída
 * — um perfil alemão fala alemão e marca Europe/Berlin, um perfil no Brasil
 * fala pt-BR e marca America/Sao_Paulo.
 */
const { PROFILES, ALIASES, NEUTRAL } = require('./locale-profiles.data');

// Regex de formato BCP-47 (ex.: pt-BR, zh-Hans-CN).
const LOCALE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
// Regex de formato IANA (Area/Location, podendo ter subárea).
const IANA_RE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){1,2}$/;

// Índice nome (minúsculo) -> código ISO, montado uma única vez.
const NAME_INDEX = (() => {
  const index = {};
  for (const [code, profile] of Object.entries(PROFILES)) {
    index[profile.name.toLowerCase()] = code;
  }
  for (const [alias, code] of Object.entries(ALIASES)) {
    index[alias.toLowerCase()] = code;
  }
  return index;
})();

// Quem decide se um fuso existe é o ICU do runtime, e ele aceita também os
// apelidos históricos (Asia/Kolkata, Europe/Kyiv, America/Nuuk, Asia/Yangon...).
// `Intl.supportedValuesOf('timeZone')` NÃO serve para isso: no ICU antigo (Node
// 18) ele só devolve o nome canônico de cada zona, então esses apelidos seriam
// recusados e o perfil do país cairia em UTC — exatamente a contradição entre
// fingerprint e IP que este serviço existe para evitar.
const zoneSupportCache = new Map();

/** true quando o runtime reconhece o fuso (fuso inexistente lança ao instanciar). */
function _icuKnowsZone(timezone) {
  if (zoneSupportCache.has(timezone)) return zoneSupportCache.get(timezone);
  let known = true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
  } catch (_) {
    known = false;
  }
  zoneSupportCache.set(timezone, known);
  return known;
}

/** true quando o valor tem o formato de um fuso IANA (Area/Location). */
function isIanaFormat(value) {
  if (typeof value !== 'string') return false;
  const tz = value.trim();
  if (!tz) return false;
  if (tz === 'UTC' || tz === 'GMT' || tz === 'Etc/UTC' || tz === 'Etc/GMT') return true;
  return IANA_RE.test(tz);
}

/**
 * Valida um fuso e devolve a forma normalizada, ou null se inválido.
 * Usa a lista do ICU quando disponível; caso contrário valida pelo formato.
 */
function normalizeTimezone(value) {
  if (!isIanaFormat(value)) return null;
  const tz = String(value).trim();
  // Runtime sem ICU: valida apenas pelo formato (nenhum fuso é reconhecido).
  if (!_icuKnowsZone('UTC')) return tz;
  return _icuKnowsZone(tz) ? tz : null;
}

/** true quando o fuso é aceito (formato válido e conhecido pelo ICU). */
function isIana(value) {
  return normalizeTimezone(value) !== null;
}

/** Resolve código ISO alpha-2 a partir de código, nome em inglês ou apelido. */
function resolveCountryCode(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const upper = raw.toUpperCase();
  if (PROFILES[upper]) return upper;
  // Código ISO de 2 letras que não mapeamos (ex.: ZZ) => desconhecido.
  if (/^[A-Z]{2}$/.test(upper)) return null;

  return NAME_INDEX[raw.toLowerCase()] || null;
}

/** Perfil bruto do país (nome/idioma/fuso) ou null. */
function profileFor(value) {
  const code = resolveCountryCode(value);
  return code ? PROFILES[code] : null;
}

function _dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * Lista de idiomas do navegador para um idioma primário.
 * Ex.: 'de-DE' -> ['de-DE', 'de', 'en-US', 'en'] (alemão com inglês de apoio,
 * como em instalações reais).
 */
function languagesFor(primary) {
  if (!primary || !LOCALE_RE.test(primary)) return NEUTRAL.languages.slice();
  const list = [primary];
  const base = primary.split('-')[0];
  if (base !== primary) list.push(base);
  if (base !== 'en') list.push('en-US', 'en');
  return _dedupe(list);
}

/** Normaliza uma lista de idiomas vinda de um override explícito. */
function cleanLanguages(value) {
  if (!Array.isArray(value)) return null;
  const valid = value
    .filter((item) => typeof item === 'string' && LOCALE_RE.test(item.trim()))
    .map((item) => item.trim());
  return valid.length ? _dedupe(valid) : null;
}

/** Monta o cabeçalho Accept-Language a partir da lista de idiomas. */
function acceptLanguage(languages) {
  const list = Array.isArray(languages) && languages.length ? languages : NEUTRAL.languages;
  return list
    .map((lang, i) => (i === 0 ? lang : `${lang};q=${(1 - i * 0.1).toFixed(1)}`))
    .join(',');
}

/** Perfil neutro (sem localização conhecida). Sempre uma cópia nova. */
function neutral() {
  return Object.assign({}, NEUTRAL, { languages: NEUTRAL.languages.slice() });
}

/**
 * Normaliza uma localização de saída (VPN ou proxy) em um perfil coerente.
 *
 * @param {object} loc
 *   country/countryCode: país da saída (nome em inglês, apelido pt-BR ou ISO).
 *   city/region/ip: dados de geolocalização do IP de saída (opcionais).
 *   timezone: fuso informado pela geolocalização (vence o fuso padrão do país).
 *   source: 'vpn' | 'proxy' | 'geo' | 'override' (para diagnóstico/UI).
 *   languages: override explícito da lista de idiomas.
 *   locale: { languages, timezone } override explícito (maior precedência).
 * @returns {object} perfil normalizado (countryCode, country, languages, ...)
 */
function fromLocation(loc) {
  const input = loc && typeof loc === 'object' ? loc : {};
  const override = input.locale && typeof input.locale === 'object' ? input.locale : null;

  const code = resolveCountryCode(input.countryCode) || resolveCountryCode(input.country);
  const profile = code ? PROFILES[code] : null;

  const languages =
    cleanLanguages(override && override.languages) ||
    cleanLanguages(input.languages) ||
    languagesFor(profile ? profile.language : null);

  const timezone =
    normalizeTimezone(input.timezone) ||
    normalizeTimezone(override && override.timezone) ||
    (profile ? normalizeTimezone(profile.timezone) : null) ||
    NEUTRAL.timezone;

  const country = profile
    ? profile.name
    : (input.country ? String(input.country).trim() : NEUTRAL.country);

  return {
    countryCode: code,
    country,
    city: input.city ? String(input.city).trim() : null,
    region: input.region ? String(input.region).trim() : null,
    ip: input.ip ? String(input.ip).trim() : null,
    language: languages[0],
    languages,
    timezone,
    source: input.source || (code ? 'country' : 'fallback')
  };
}

module.exports = {
  fromLocation,
  neutral,
  resolveCountryCode,
  profileFor,
  languagesFor,
  cleanLanguages,
  acceptLanguage,
  normalizeTimezone,
  isIana,
  isIanaFormat,
  allProfiles: () => PROFILES
};
