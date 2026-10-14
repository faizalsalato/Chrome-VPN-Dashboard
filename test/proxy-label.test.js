/**
 * Rótulo de um proxy salvo: o que aparece nas listas de escolha é o PAÍS de
 * saída do proxy (vindo do último teste), nunca o endereço host:porta/usuário.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MODULE_PATH = path.join(__dirname, '..', 'public', 'js', 'proxy-label.js');

/** Carrega o módulo puro do frontend (sem DOM). */
function load() {
  const source = fs.readFileSync(MODULE_PATH, 'utf-8');
  const context = vm.createContext({});
  vm.runInContext(`${source}\n;globalThis.__label = ProxyLabel;`, context);
  return context.__label;
}

const ProxyLabel = load();

/** Proxy como a API devolve (sem senha), com o endereço que NÃO deve vazar. */
function proxyWithGeo(overrides) {
  return Object.assign({
    id: 4,
    name: 'brd-user@brd.superproxy.io:44445',
    host: 'brd.superproxy.io',
    port: 44445,
    scheme: 'http',
    auth: true,
    username: 'brd-user',
    country: 'Germany',
    countryCode: 'DE',
    city: 'Munich',
    timezone: 'Europe/Berlin',
    geoIp: '185.96.133.239',
    testedAt: '2026-10-13 06:20:00'
  }, overrides);
}

describe('ProxyLabel.countryLine', () => {
  it('mostra país e cidade quando os dois existem', () => {
    expect(ProxyLabel.countryLine(proxyWithGeo())).toBe('Germany · Munich');
  });

  it('mostra só o país quando não há cidade', () => {
    expect(ProxyLabel.countryLine(proxyWithGeo({ city: null }))).toBe('Germany');
    expect(ProxyLabel.countryLine(proxyWithGeo({ city: '   ' }))).toBe('Germany');
  });

  it('devolve null quando o país é desconhecido', () => {
    expect(ProxyLabel.countryLine(proxyWithGeo({ country: null }))).toBeNull();
    expect(ProxyLabel.countryLine(proxyWithGeo({ country: '  ' }))).toBeNull();
    expect(ProxyLabel.countryLine({})).toBeNull();
    expect(ProxyLabel.countryLine(null)).toBeNull();
  });

  it('apara espaços vindos da API', () => {
    expect(ProxyLabel.countryLine(proxyWithGeo({ country: ' Germany ', city: ' Munich ' })))
      .toBe('Germany · Munich');
  });
});

describe('ProxyLabel.forPick', () => {
  it('rotula a opção pelo país e por um índice, não pelo endereço', () => {
    const label = ProxyLabel.forPick(proxyWithGeo());

    expect(label).toBe('Germany · Munich (#4)');
    expect(label).not.toContain('brd.superproxy.io');
    expect(label).not.toContain('44445');
    expect(label).not.toContain('brd-user');
  });

  it('avisa que o país é desconhecido quando o proxy ainda não foi testado', () => {
    const label = ProxyLabel.forPick({
      id: 7, host: '10.0.0.9', port: 3128, username: 'joao'
    });

    expect(label).toBe('País não identificado — teste o proxy (#7)');
    expect(label).not.toContain('10.0.0.9');
    expect(label).not.toContain('3128');
    expect(label).not.toContain('joao');
  });

  it('distingue dois proxies do mesmo país pelo índice', () => {
    const a = ProxyLabel.forPick(proxyWithGeo({ id: 1 }));
    const b = ProxyLabel.forPick(proxyWithGeo({ id: 2 }));

    expect(a).not.toBe(b);
    expect(a.endsWith('(#1)')).toBe(true);
    expect(b.endsWith('(#2)')).toBe(true);
  });
});

describe('ProxyLabel.hasCountry', () => {
  it('indica quando o país já é conhecido', () => {
    expect(ProxyLabel.hasCountry(proxyWithGeo())).toBe(true);
    expect(ProxyLabel.hasCountry(proxyWithGeo({ country: null }))).toBe(false);
    expect(ProxyLabel.hasCountry({})).toBe(false);
    expect(ProxyLabel.hasCountry(null)).toBe(false);
  });
});
