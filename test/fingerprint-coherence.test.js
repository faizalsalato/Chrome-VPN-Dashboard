/**
 * Regressoes do fingerprint que faziam o Chromium falhar o Turnstile da
 * Cloudflare (o Firefox passava no mesmo IP porque nao leva extensao).
 *
 * 1. colorDepth e pixelDepth nunca podem divergir.
 * 2. A GPU tem de estar no formato ANGLE que o Chromium emite no Linux.
 * 3. A extensao tem de mascarar Function.prototype.toString, senao o
 *    monkey-patch e legivel e o detector ve que o browser foi alterado.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const contentJs = fs.readFileSync(path.join(root, 'src/fingerprint-extension/content.js'), 'utf8');

describe('fingerprint.service — coerencia do perfil', () => {
  let fingerprint;
  beforeAll(() => {
    fingerprint = require('../src/services/fingerprint.service');
  });

  it('colorDepth e pixelDepth sao sempre iguais', () => {
    // Sorteava-os em separado e produzia "24 / 30", combinacao impossivel.
    for (let i = 0; i < 40; i++) {
      const fp = fingerprint.generate('seed-' + i, 'Japan');
      expect(fp.screen.pixelDepth).toBe(fp.screen.colorDepth);
    }
  });

  it('a GPU e anunciada no formato ANGLE do Chromium', () => {
    for (let i = 0; i < 40; i++) {
      const fp = fingerprint.generate('gpu-' + i, 'Japan');
      expect(fp.webgl.renderer).toMatch(/^ANGLE \(/);
      expect(fp.webgl.vendor).toMatch(/^Google Inc\. \(/);
    }
  });

  it('nenhuma GPU de macOS vaza para um perfil Linux', () => {
    // "AMD Radeon Pro 5500M OpenGL Engine" e renderer nativo de MacBook Pro.
    for (let i = 0; i < 40; i++) {
      const fp = fingerprint.generate('plat-' + i, 'Japan');
      expect(fp.platform).toBe('Linux x86_64');
      expect(fp.webgl.renderer).not.toMatch(/OpenGL Engine/);
      expect(fp.webgl.renderer).not.toMatch(/Radeon Pro/);
    }
  });
});

describe('extensao — mascaramento de toString', () => {
  it('NAO cria plugins com nomes sinteticos (sinal de bot)', () => {
    // Evidencia CDP: o Turnstile via plugins = ["Plugin 0", "Plugin 1", ...].
    // Nenhum browser real produz esses nomes; o Chromium real devolve
    // "PDF Viewer", "Chrome PDF Viewer", etc. A extensao nao deve tocar em
    // navigator.plugins — deixa os nativos.
    expect(contentJs).not.toMatch(/'Plugin '\s*\+/);
    expect(contentJs).not.toMatch(/"Plugin "\s*\+/);
    expect(contentJs).toContain('NAO falsificar');
  });

  it('marca as funcoes reescritas como nativas', () => {
    expect(contentJs).toContain('Function.prototype');
    expect(contentJs).toContain("'toString'");
    expect(contentJs).toContain('[native code]');
    expect(contentJs).toContain('markNative');
  });

  it('marca as sondas que o Turnstile le', () => {
    // Cada uma destas e chamada por detectores de bot com .toString().
    expect(contentJs).toMatch(/markNative\(function getTimezoneOffset/);
    expect(contentJs).toMatch(/markNative\(function getParameter/);
    expect(contentJs).toMatch(/markNative\(function webdriver/);
    expect(contentJs).toMatch(/markNative\(function getHighEntropyValues/);
  });
});
