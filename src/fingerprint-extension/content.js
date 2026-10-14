/*
 * Fingerprint injector (runs in the page MAIN world at document_start).
 * The dashboard replaces the __FINGERPRINT__ marker below with a JSON object
 * describing this profile's fingerprint. When absent, this is a no-op so the
 * repository copy stays safe to load unchanged.
 *
 * Timezone and language are always taken from the connection's exit location
 * (VPN country / proxy geo), so the browser never contradicts its own IP.
 */
(function () {
  'use strict';

  var FP = /*__FINGERPRINT__*/ null;
  if (!FP) return;

  function define(obj, prop, getter) {
    if (!obj) return;
    try {
      Object.defineProperty(obj, prop, { get: getter, configurable: true });
    } catch (e) { /* ignore */ }
  }

  function setValue(obj, prop, value) {
    if (!obj) return;
    try {
      Object.defineProperty(obj, prop, { value: value, configurable: true, writable: true });
    } catch (e) { /* ignore */ }
  }

  var nav = navigator;

  // --- navigator.* ---
  if (FP.userAgent != null) setValue(nav, 'userAgent', FP.userAgent);
  if (FP.appVersion != null) setValue(nav, 'appVersion', FP.appVersion);
  if (FP.platform != null) setValue(nav, 'platform', FP.platform);
  if (FP.vendor != null) setValue(nav, 'vendor', FP.vendor);
  if (FP.product != null) setValue(nav, 'product', FP.product);
  if (FP.hardwareConcurrency != null) setValue(nav, 'hardwareConcurrency', FP.hardwareConcurrency);
  if (FP.deviceMemory != null) setValue(nav, 'deviceMemory', FP.deviceMemory);
  if (FP.maxTouchPoints != null) setValue(nav, 'maxTouchPoints', FP.maxTouchPoints);
  // Automation flag should read false for a "clean" browser.
  define(nav, 'webdriver', function () { return false; });

  if (Array.isArray(FP.languages)) {
    try {
      Object.defineProperty(nav, 'languages', {
        get: function () { return Object.freeze(FP.languages.slice()); },
        configurable: true
      });
    } catch (e) { /* ignore */ }
  }
  if (FP.language != null) setValue(nav, 'language', FP.language);

  if (FP.doNotTrack != null) setValue(nav, 'doNotTrack', FP.doNotTrack);

  // navigator.plugins / mimeTypes length (anti-headless heuristic)
  if (FP.pluginsCount != null) {
    try {
      Object.defineProperty(nav, 'plugins', {
        get: function () {
          var arr = [];
          for (var i = 0; i < FP.pluginsCount; i++) arr.push({ name: 'Plugin ' + i });
          arr.length = FP.pluginsCount;
          return arr;
        },
        configurable: true
      });
    } catch (e) { /* ignore */ }
  }

  // --- User-Agent Client Hints (navigator.userAgentData) ---
  // O Chrome anuncia aqui a plataforma REAL do sistema e o build REAL do
  // binario, e nao na UA string. Sem esta camada o perfil dizia "MacIntel" na
  // UA e "Linux" nos Client Hints — era o "OS: Linux" que o whoer.net acusava.
  var CH_PLATFORM_NAMES = { Win32: 'Windows', MacIntel: 'macOS', Linux: 'Linux' };
  var CH_PLATFORM_VERSIONS = { Windows: '10.0.0', macOS: '15.0.0' };
  var CH_GREASE_BRAND = 'Not/A)Brand';
  var CH_GREASE_VERSION = '24';

  var hints = FP.clientHints && typeof FP.clientHints === 'object' ? FP.clientHints : {};
  var uaText = String(FP.userAgent || '');
  var uaMajorMatch = /Chrome\/(\d+)/.exec(uaText);
  var chMajor = hints.chromeMajor != null
    ? String(hints.chromeMajor)
    : (uaMajorMatch ? uaMajorMatch[1] : '0');
  // A UA do Chrome e reduzida ("Chrome/154.0.0.0"), mas os Client Hints expoem
  // o build completo ("154.0.8037.92"): as duas formas precisam existir e nao
  // podem discordar entre si.
  var uaFullMatch = /Chrome\/([\d.]+)/.exec(uaText);
  var chFullVersion = hints.fullVersion || (uaFullMatch ? uaFullMatch[1] : chMajor + '.0.0.0');
  var chPlatform = hints.platform || CH_PLATFORM_NAMES[FP.platform] || 'Windows';
  var chPlatformVersion = hints.platformVersion || CH_PLATFORM_VERSIONS[chPlatform] || '10.0.0';

  function brandList(version) {
    return [
      { brand: 'Chromium', version: version },
      { brand: 'Google Chrome', version: version },
      { brand: CH_GREASE_BRAND, version: CH_GREASE_VERSION }
    ];
  }

  function buildHints() {
    return { brands: brandList(chMajor), mobile: false, platform: chPlatform };
  }

  var uaData = {
    brands: brandList(chMajor),
    mobile: false,
    platform: chPlatform,
    toJSON: buildHints,
    getHighEntropyValues: function () {
      // Devolve o conjunto completo: campos a mais sao inofensivos e faltar um
      // campo pedido seria um sinal tao claro quanto o valor errado.
      return Promise.resolve({
        architecture: 'x86',
        bitness: '64',
        brands: brandList(chMajor),
        fullVersionList: brandList(chFullVersion),
        mobile: false,
        model: '',
        platform: chPlatform,
        platformVersion: chPlatformVersion,
        uaFullVersion: chFullVersion,
        wow64: false
      });
    }
  };

  // Mantem o prototipo real para `navigator.userAgentData instanceof
  // NavigatorUAData` continuar verdadeiro; nossas propriedades proprias
  // (definidas acima) tem prioridade sobre os acessores nativos.
  var originalUaData = nav.userAgentData;
  if (originalUaData && Object.getPrototypeOf) {
    try {
      Object.setPrototypeOf(uaData, Object.getPrototypeOf(originalUaData));
    } catch (e) { /* ignore */ }
  }
  define(nav, 'userAgentData', function () { return uaData; });

  // --- screen.* ---
  var scr = screen;
  if (scr && FP.screen) {
    var s = FP.screen;
    if (s.width != null) setValue(scr, 'width', s.width);
    if (s.height != null) setValue(scr, 'height', s.height);
    if (s.availWidth != null) setValue(scr, 'availWidth', s.availWidth);
    if (s.availHeight != null) setValue(scr, 'availHeight', s.availHeight);
    if (s.colorDepth != null) setValue(scr, 'colorDepth', s.colorDepth);
    if (s.pixelDepth != null) setValue(scr, 'pixelDepth', s.pixelDepth);
    if (s.availLeft != null) setValue(scr, 'availLeft', s.availLeft);
    if (s.availTop != null) setValue(scr, 'availTop', s.availTop);
  }

  // window.screen (some checks read window.screen.*)
  if (FP.screen && window.screen) {
    var w = FP.screen;
    if (w.outerWidth != null) setValue(window, 'outerWidth', w.outerWidth);
    if (w.outerHeight != null) setValue(window, 'outerHeight', w.outerHeight);
    if (w.innerWidth != null) setValue(window, 'innerWidth', w.innerWidth);
    if (w.innerHeight != null) setValue(window, 'innerHeight', w.innerHeight);
    if (w.devicePixelRatio != null) setValue(window, 'devicePixelRatio', w.devicePixelRatio);
  }

  // --- WebGL vendor/renderer ---
  if (FP.webgl && (FP.webgl.vendor || FP.webgl.renderer)) {
    var vendor = FP.webgl.vendor;
    var renderer = FP.webgl.renderer;
    var UNMASKED_VENDOR = 0x9245;
    var UNMASKED_RENDERER = 0x9246;

    function patchWebGL(ContextCtor) {
      if (!ContextCtor || !ContextCtor.prototype || !ContextCtor.prototype.getParameter) return;
      var origGetParameter = ContextCtor.prototype.getParameter;
      ContextCtor.prototype.getParameter = function (parameter) {
        if (parameter === UNMASKED_VENDOR && vendor) return vendor;
        if (parameter === UNMASKED_RENDERER && renderer) return renderer;
        return origGetParameter.call(this, parameter);
      };
    }

    patchWebGL(typeof WebGLRenderingContext !== 'undefined' ? WebGLRenderingContext : null);
    patchWebGL(typeof WebGL2RenderingContext !== 'undefined' ? WebGL2RenderingContext : null);
  }

  // --- Timezone + locale (Intl / Date) ---
  // Both must be consistent with the exit location: a profile in Germany has
  // to answer Europe/Berlin and de-DE, never UTC/POSIX.
  var timeZone = typeof FP.timezone === 'string' ? FP.timezone : null;
  var language = typeof FP.language === 'string' ? FP.language : null;
  var languages = Array.isArray(FP.languages) && FP.languages.length ? FP.languages : null;
  var OrigDateTimeFormat = Intl.DateTimeFormat;
  var OrigNumberFormat = Intl.NumberFormat;
  var OrigCollator = Intl.Collator;

  // Só segue com o spoof de fuso quando o ICU conhece a zona (senão o próprio
  // Intl lançaria erro e a página quebraria).
  var zoneOk = false;
  if (timeZone) {
    try {
      new OrigDateTimeFormat('en-US', { timeZone: timeZone });
      zoneOk = true;
    } catch (e) {
      zoneOk = false;
    }
  }

  function pad2(value) {
    return value < 10 ? '0' + value : String(value);
  }

  // Formata um instante no fuso alvo e devolve as partes (usando o ICU real).
  var partsCache = {};
  function partsIn(instant, options) {
    var key = JSON.stringify(options);
    var formatter = partsCache[key];
    if (!formatter) {
      formatter = new OrigDateTimeFormat('en-US', options);
      partsCache[key] = formatter;
    }
    var out = {};
    var parts = formatter.formatToParts(instant);
    for (var i = 0; i < parts.length; i++) out[parts[i].type] = parts[i].value;
    return out;
  }

  var WALL_OPTS = {
    timeZone: timeZone, era: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  };
  var NAME_OPTS = { timeZone: timeZone, timeZoneName: 'long' };

  /** Minutos a oeste de UTC no fuso alvo (mesma convenção de getTimezoneOffset). */
  function offsetMinutes(instant) {
    var p = partsIn(instant, WALL_OPTS);
    var hour = parseInt(p.hour, 10);
    // Alguns locales devolvem 24 em vez de 00 para meia-noite (hourCycle h24).
    if (hour === 24) hour = 0;
    var asUtc = Date.UTC(
      parseInt(p.year, 10), parseInt(p.month, 10) - 1, parseInt(p.day, 10),
      hour, parseInt(p.minute, 10), parseInt(p.second, 10)
    );
    return (instant.getTime() - asUtc) / 60000;
  }

  /**
   * "GMT-0300" para o fuso alvo. O offset precisa ser arredondado para minutos
   * inteiros ANTES de ser decomposto: o instante carrega milissegundos, então
   * um offset de -120min vira -119.983 e a decomposição crua produziria
   * "GMT+0160" (1 hora e 60 minutos).
   */
  function gmtLabel(instant) {
    var offset = Math.round(offsetMinutes(instant));
    var sign = offset <= 0 ? '+' : '-';
    var abs = Math.abs(offset);
    return 'GMT' + sign + pad2(Math.floor(abs / 60)) + pad2(abs % 60);
  }

  function zoneLongName(instant) {
    var p = partsIn(instant, NAME_OPTS);
    return p.timeZoneName || timeZone;
  }

  function wallParts(instant) {
    var p = partsIn(instant, WALL_OPTS);
    var hour = parseInt(p.hour, 10);
    if (hour === 24) hour = 0;
    return {
      day: parseInt(p.day, 10),
      month: parseInt(p.month, 10),
      year: parseInt(p.year, 10),
      hour: hour,
      minute: parseInt(p.minute, 10),
      second: parseInt(p.second, 10)
    };
  }

  var DATE_OPTS = {
    timeZone: timeZone, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZoneName: 'long'
  };

  function toStringIn(instant) {
    var p = partsIn(instant, DATE_OPTS);
    var hour = parseInt(p.hour, 10);
    if (hour === 24) hour = 0;
    return p.weekday + ' ' + p.month + ' ' + parseInt(p.day, 10) + ' ' + p.year + ' ' +
      pad2(hour) + ':' + pad2(parseInt(p.minute, 10)) + ':' + pad2(parseInt(p.second, 10)) +
      ' ' + gmtLabel(instant) + ' (' + (p.timeZoneName || zoneLongName(instant)) + ')';
  }

  function toTimeStringIn(instant) {
    var wall = wallParts(instant);
    return pad2(wall.hour) + ':' + pad2(wall.minute) + ':' + pad2(wall.second) +
      ' ' + gmtLabel(instant) + ' (' + zoneLongName(instant) + ')';
  }

  function toDateStringIn(instant) {
    var p = partsIn(instant, DATE_OPTS);
    return p.weekday + ' ' + p.month + ' ' + parseInt(p.day, 10) + ' ' + p.year;
  }

  /** Injeta fuso/idioma padrão nas opções de um Intl existente. */
  function withDefaults(locales, options, defaultTimeZone) {
    var opts = {};
    if (options) {
      for (var k in options) {
        if (Object.prototype.hasOwnProperty.call(options, k)) opts[k] = options[k];
      }
    }
    if (defaultTimeZone && opts.timeZone === undefined) opts.timeZone = defaultTimeZone;
    var loc = locales === undefined || locales === null ? (language || undefined) : locales;
    return [loc, opts];
  }

  function wrapIntl(Original, defaultTimeZone) {
    function Patched(locales, options) {
      var args = withDefaults(locales, options, defaultTimeZone);
      return new Original(args[0], args[1]);
    }
    try {
      Object.setPrototypeOf(Patched, Original);
      Patched.prototype = Original.prototype;
      if (Original.supportedLocalesOf) {
        Patched.supportedLocalesOf = function (locales, options) {
          return Original.supportedLocalesOf(locales, options);
        };
      }
    } catch (e) { /* ignore */ }
    return Patched;
  }

  try {
    // Construtores Intl passam a herdar idioma e fuso do perfil.
    Intl.DateTimeFormat = wrapIntl(OrigDateTimeFormat, zoneOk ? timeZone : null);
    Intl.NumberFormat = wrapIntl(OrigNumberFormat, null);
    Intl.Collator = wrapIntl(OrigCollator, null);
  } catch (e) { /* ignore */ }

  if (zoneOk) {
    try {
      var OrigGetTimezoneOffset = Date.prototype.getTimezoneOffset;
      Date.prototype.getTimezoneOffset = function () {
        if (isNaN(this.getTime())) return OrigGetTimezoneOffset.call(this);
        return Math.round(offsetMinutes(this));
      };

      var OrigToString = Date.prototype.toString;
      Date.prototype.toString = function () {
        if (isNaN(this.getTime())) return OrigToString.call(this);
        return toStringIn(this);
      };

      var OrigToTimeString = Date.prototype.toTimeString;
      Date.prototype.toTimeString = function () {
        if (isNaN(this.getTime())) return OrigToTimeString.call(this);
        return toTimeStringIn(this);
      };

      var OrigToDateString = Date.prototype.toDateString;
      Date.prototype.toDateString = function () {
        if (isNaN(this.getTime())) return OrigToDateString.call(this);
        return toDateStringIn(this);
      };

      // Variantes toLocale*: injeta idioma e fuso padrão, preservando os
      // argumentos explícitos do chamador.
      ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'].forEach(function (name) {
        var orig = Date.prototype[name];
        if (typeof orig !== 'function') return;
        Date.prototype[name] = function (locales, options) {
          var args = withDefaults(locales, options, timeZone);
          return orig.call(this, args[0], args[1]);
        };
      });
    } catch (e) { /* ignore */ }
  }
})();
