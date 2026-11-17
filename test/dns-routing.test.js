const fs = require('fs');
/**
 * docker.service.chromeConfig deve escolher o resolvedor do pais mesmo quando
 * o config de ENTRADA nao traz dnsLocal (ele e calculado dentro da funcao).
 * Regressao real: o codigo testava config.dnsLocal (undefined) e o DNS do
 * pais nunca era aplicado apos recriar a instancia.
 */
jest.mock('../src/services/dns-routing.service', () => ({
  prepare: jest.fn(async () => ({ name: 'br-01', ip: '172.17.0.3', country: 'BR' })),
  configFor: jest.fn(() => ({ dns: ['172.17.0.3'], network: 'rotaproxy_default',
    resolver: { name: 'br-01', ip: '172.17.0.3', country: 'BR' } }))
}));

const dockerService = require('../src/services/docker.service');

describe('chromeConfig - DNS do pais', () => {
  it('instancia 6: pais em fingerprint.geo.countryCode gera dnsResolver', async () => {
    const cc = await dockerService.chromeConfig({
      id: 6, port: 4006, type: 'proxy', browser: 'firefox',
      proxy: { host: '65.111.20.169', port: 3129, scheme: 'http', auth: true, user: 'u', pass: 'p' },
      fingerprint: { geo: { countryCode: 'BR' }, language: 'pt-BR' }
    });
    expect(cc.dnsLocal).toBe(true);
    expect(cc.dnsResolver).toEqual({ name: 'br-01', ip: '172.17.0.3', country: 'BR' });
  });

  it('proxy HTTP de chromium nao ativa DNS local', async () => {
    const cc = await dockerService.chromeConfig({
      id: 7, port: 4007, type: 'proxy', browser: 'chromium',
      proxy: { host: 'x', port: 80, scheme: 'http', auth: false },
      fingerprint: { geo: { countryCode: 'BR' } }
    });
    expect(cc.dnsLocal).toBe(false);
    expect(cc.dnsResolver).toBeUndefined();
  });
// Regressao critica: chromeConfig passou a ser async. Se um chamador nao
// usar await, o Docker recebe uma Promise e falha com 'invalid port: undefined'.
it('todos os chamadores de chromeConfig usam await', () => {
  const src = fs.readFileSync(require.resolve('../src/services/docker.service'), 'utf8');
  const chamadas = src.match(/(?:await )?this\.chromeConfig\(config\)/g) || [];
  expect(chamadas.length).toBeGreaterThan(0);
  for (const c of chamadas) {
    expect(c.startsWith('await')).toBe(true);
  }
});

});
