/*
 * Fingerprint injector (runs in the page MAIN world at document_start).
 * The dashboard replaces the __FINGERPRINT__ marker below with a JSON object
 * describing this profile's fingerprint. When absent, this is a no-op so the
 * repository copy stays safe to load unchanged.
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
    var origGetParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (parameter) {
      // UNMASKED_VENDOR_WEBGL = 0x9245, UNMASKED_RENDERER_WEBGL = 0x9246
      if (parameter === 0x9245 && vendor) return vendor;
      if (parameter === 0x9246 && renderer) return renderer;
      return origGetParameter.call(this, parameter);
    };
    if (typeof WebGL2RenderingContext !== 'undefined') {
      var origGetParameter2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function (parameter) {
        if (parameter === 0x9245 && vendor) return vendor;
        if (parameter === 0x9246 && renderer) return renderer;
        return origGetParameter2.call(this, parameter);
      };
    }
  }

  // --- Timezone (best-effort via Intl.DateTimeFormat) ---
  if (FP.timezone) {
    var tz = FP.timezone;
    try {
      var origResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
      Intl.DateTimeFormat.prototype.resolvedOptions = function () {
        var opts = origResolvedOptions.call(this);
        opts.timeZone = tz;
        return opts;
      };
    } catch (e) { /* ignore */ }
    var origDTF = Intl.DateTimeFormat;
    // Best-effort: many sites call new Intl.DateTimeFormat().resolvedOptions()
    // which is already patched above; also patch the constructor default.
  }
})();
