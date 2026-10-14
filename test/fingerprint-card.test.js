/**
 * Card de fingerprint: mostra a identidade do perfil (SO/tela, fuso e idioma) e
 * sinaliza quando o fuso do fingerprint diverge do IP de saída. A geo da conexão
 * NÃO se repete aqui — o cartão já a mostra no bloco de cima.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MODULE_PATH = path.join(__dirname, '..', 'public', 'js', 'fingerprint-card.js');

/** Carrega o módulo do frontend e devolve a função render. */
function loadRenderer() {
  const source = fs.readFileSync(MODULE_PATH, 'utf-8');
  const context = vm.createContext({});
  // Expõe o objeto (e não o método solto): render usa `this._helper()`.
  vm.runInContext(`${source}\n;globalThis.__card = FingerprintCard;`, context);
  return (instance) => context.__card.render(instance);
}

const render = loadRenderer();

function instanceWithFingerprint(overrides, extra) {
  return Object.assign({
    id: 3,
    vpnInfo: null,
    fingerprint: Object.assign({
      seed: 'chrome3',
      language: 'de-DE',
      languages: ['de-DE', 'de', 'en-US', 'en'],
      timezone: 'Europe/Berlin',
      platform: 'Win32',
      screen: { width: 1920, height: 1080 },
      geo: {
        country: 'Germany', countryCode: 'DE', city: 'Frankfurt',
        timezone: 'Europe/Berlin', ip: '5.6.7.8', source: 'vpn'
      }
    }, overrides)
  }, extra);
}

describe('FingerprintCard.render', () => {
  it('mostra identidade, fuso e idioma', () => {
    const html = render(instanceWithFingerprint());

    expect(html).toContain('Windows · 1920x1080');
    expect(html).toContain('Europe/Berlin');
    expect(html).toContain('de-DE');
    expect(html).toContain('fp-info');
  });

  it('não repete a geo da conexão (o cartão já a mostra no bloco de cima)', () => {
    const html = render(instanceWithFingerprint());

    expect(html).not.toContain('Localização');
    expect(html).not.toContain('Germany · Frankfurt');
    expect(html).not.toContain('fp-loc');
  });

  it('sem fingerprint não renderiza nada', () => {
    expect(render({ id: 1, fingerprint: null })).toBe('');
    expect(render({ id: 1 })).toBe('');
  });

  it('marca o perfil verificado quando o fuso veio do IP da VPN', () => {
    const html = render(instanceWithFingerprint({}, { vpnInfo: { timezone: 'Europe/Berlin' } }));
    expect(html).toContain('IP verificado');
    expect(html).toContain('fp-sync-ok');
    expect(html).not.toContain('divergente');
  });

  it('avisa quando o fuso do perfil difere do IP de saída', () => {
    const html = render(instanceWithFingerprint({}, { vpnInfo: { timezone: 'America/Sao_Paulo' } }));
    expect(html).toContain('divergente');
    expect(html).toContain('fp-sync-warn');
  });

  it('perfil vindo do país escolhido é rotulado como "por país"', () => {
    const html = render(instanceWithFingerprint(
      { geo: { country: 'Germany', countryCode: 'DE', timezone: 'Europe/Berlin', source: 'vpn-country' } }
    ));
    expect(html).toContain('por país');
    expect(html).toContain('fp-sync-neutral');
  });

  it('neutraliza marcação vinda do IP de saída (título do selo)', () => {
    const html = render(instanceWithFingerprint({}, {
      vpnInfo: { timezone: '<img src=x onerror=alert(1)>' }
    }));

    expect(html).not.toContain('<img');

    // O fuso do IP entra no title do selo: sem <, >, aspas ou =, o resto vira
    // texto inerte e não consegue abrir tag nem atributo.
    const title = html.match(/<span class="fp-sync fp-sync-warn" title="([^"]*)"/);
    expect(title).not.toBeNull();
    expect(title[1]).not.toMatch(/[<>"'=]/);
  });

  it('fuso e idioma ausentes não quebram o card', () => {
    const html = render(instanceWithFingerprint({ timezone: null, language: null, languages: [] }));
    expect(html).toContain('N/A');
  });
});
