/**
 * Card de fingerprint: mostra a localização usada no perfil e sinaliza quando
 * o fuso do fingerprint diverge do IP de saída.
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
  it('mostra identidade, localização, fuso e idioma', () => {
    const html = render(instanceWithFingerprint());

    expect(html).toContain('Windows · 1920x1080');
    expect(html).toContain('Germany · Frankfurt');
    expect(html).toContain('Europe/Berlin');
    expect(html).toContain('de-DE');
    expect(html).toContain('fp-info');
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

  it('país sem cidade mostra apenas o país', () => {
    const html = render(instanceWithFingerprint(
      { geo: { country: 'Singapore', countryCode: 'SG', timezone: 'Asia/Singapore', source: 'vpn' } }
    ));
    expect(html).toContain('Singapore');
    expect(html).not.toContain('Singapore ·');
  });

  it('neutraliza marcação vinda da geolocalização do IP', () => {
    const html = render(instanceWithFingerprint({
      geo: {
        country: 'Germany', countryCode: 'DE',
        city: '<img src=x onerror=alert(1)>',
        timezone: 'Europe/Berlin', source: 'vpn'
      }
    }));

    expect(html).not.toContain('<img');

    // O rótulo de localização não pode conter nada capaz de abrir tag ou
    // atributo: sem <, >, aspas ou =, o resto vira texto inerte.
    const label = html.match(/<span class="fp-loc">([\s\S]*?)<\/span>/);
    expect(label).not.toBeNull();
    expect(label[1]).not.toMatch(/[<>"'=]/);
  });

  it('fuso e idioma ausentes não quebram o card', () => {
    const html = render(instanceWithFingerprint({ timezone: null, language: null, languages: [] }));
    expect(html).toContain('N/A');
  });
});
