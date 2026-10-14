/**
 * Leitura do IP de saída do túnel e da geolocalização: é a fonte da verdade
 * usada para alinhar o fingerprint à conexão.
 */
const vpnService = require('../src/services/vpn.service');

const STREAM_HEADER = Buffer.from([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

function frame(text) {
  return Buffer.concat([STREAM_HEADER, Buffer.from(text, 'utf-8')]);
}

describe('_isValidIP', () => {
  it('aceita IPv4 bem formado', () => {
    expect(vpnService._isValidIP('1.2.3.4')).toBe(true);
    expect(vpnService._isValidIP('255.255.255.255')).toBe(true);
    expect(vpnService._isValidIP('0.0.0.0')).toBe(true);
  });

  it('rejeita vazio, lixo e formato inválido', () => {
    expect(vpnService._isValidIP('')).toBe(false);
    expect(vpnService._isValidIP(null)).toBe(false);
    expect(vpnService._isValidIP('1.2.3')).toBe(false);
    expect(vpnService._isValidIP('999.1.1.1')).toBe(false);
    expect(vpnService._isValidIP('01.2.3.4')).toBe(false);
    expect(vpnService._isValidIP('abc.def.ghi.jkl')).toBe(false);
    expect(vpnService._isValidIP('2001:db8::1')).toBe(false);
  });
});

describe('_parseChunks', () => {
  it('remove o cabeçalho de 8 bytes do stream de exec', () => {
    expect(vpnService._parseChunks([frame('73.2.4.5\n')])).toBe('73.2.4.5');
  });

  it('junta vários pedaços e ignora pedaços curtos', () => {
    expect(vpnService._parseChunks([frame('73.2.'), frame('4.5')])).toBe('73.2.4.5');
    expect(vpnService._parseChunks([Buffer.from('ok')])).toBe('ok');
  });

  it('devolve string vazia sem dados', () => {
    expect(vpnService._parseChunks([])).toBe('');
  });
});

describe('cache de status', () => {
  it('clearCache não quebra com ou sem nome', () => {
    expect(() => vpnService.clearCache('gluetun9')).not.toThrow();
    expect(() => vpnService.clearCache()).not.toThrow();
  });

  it('clearCache de um container não afeta os outros', () => {
    vpnService._cache.set('gluetunA', { data: { connected: true }, timestamp: Date.now() });
    vpnService._cache.set('gluetunB', { data: { connected: true }, timestamp: Date.now() });

    vpnService.clearCache('gluetunA');

    expect(vpnService._cache.has('gluetunA')).toBe(false);
    expect(vpnService._cache.has('gluetunB')).toBe(true);
    vpnService.clearCache();
  });
});
