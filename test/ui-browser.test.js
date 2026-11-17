const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const instancesJs = fs.readFileSync(path.join(root, 'public/js/instances.js'), 'utf8');

describe('UI - selecao de navegador', () => {
  it('whitelist de criacao inclui firefox (nao cria Chromium no lugar)', () => {
    // O bug: ['brave','cloakbrowser'] sem firefox -> selecionar Firefox
    // no formulario criava silenciosamente uma instancia Chromium.
    const m = appJs.match(/\['brave',[^\]]*\]/);
    expect(m).not.toBeNull();
    expect(m[0]).toContain("'firefox'");
    expect(m[0]).toContain("'chromium'");
  });

  it('badge do cartao distingue Firefox de Chromium', () => {
    expect(instancesJs).toContain("browser === 'firefox'");
    expect(instancesJs).toMatch(/type-badge firefox/);
    expect(instancesJs).toContain('>Fire<');
  });
});
