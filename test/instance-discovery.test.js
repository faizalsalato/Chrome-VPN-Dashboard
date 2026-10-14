/**
 * Descoberta das instâncias no Docker: quais containers contam, qual a porta
 * pública e qual o status derivado dos containers.
 */
const instanceDiscovery = require('../src/services/instance-discovery.service');

const VPN_CONTAINER = { State: 'running', Ports: [{ PrivatePort: 3000, PublicPort: 4005 }] };
const CHROME_CONTAINER = { State: 'running', Ports: [{ PrivatePort: 3000, PublicPort: 4005 }] };

describe('_resolveStatus', () => {
  it('VPN só está running com túnel e chrome de pé', () => {
    expect(instanceDiscovery._resolveStatus('vpn', VPN_CONTAINER, CHROME_CONTAINER)).toBe('running');
    expect(instanceDiscovery._resolveStatus('vpn', VPN_CONTAINER, { State: 'exited' })).toBe('error');
    expect(instanceDiscovery._resolveStatus('vpn', { State: 'exited' }, CHROME_CONTAINER)).toBe('error');
    expect(instanceDiscovery._resolveStatus('vpn', { State: 'exited' }, { State: 'exited' })).toBe('stopped');
    expect(instanceDiscovery._resolveStatus('vpn', null, null)).toBe('stopped');
  });

  it('proxy depende apenas do container do chrome', () => {
    expect(instanceDiscovery._resolveStatus('proxy', null, CHROME_CONTAINER)).toBe('running');
    expect(instanceDiscovery._resolveStatus('proxy', null, { State: 'exited' })).toBe('stopped');
    expect(instanceDiscovery._resolveStatus('proxy', null, null)).toBe('stopped');
  });
});

describe('_resolvePort', () => {
  it('no modo VPN a porta vem do container do túnel', () => {
    const gluetun = { Ports: [{ PrivatePort: 3000, PublicPort: 4001 }] };
    const chrome = { Ports: [{ PrivatePort: 3000, PublicPort: 9999 }] };
    expect(instanceDiscovery._resolvePort('vpn', gluetun, chrome, 1)).toBe(4001);
  });

  it('no modo proxy a porta vem do container do chrome', () => {
    const chrome = { Ports: [{ PrivatePort: 3000, PublicPort: 4007 }] };
    expect(instanceDiscovery._resolvePort('proxy', null, chrome, 7)).toBe(4007);
  });

  it('sem binding cai no BASE_PORT + id - 1', () => {
    const previous = process.env.BASE_PORT;
    process.env.BASE_PORT = '4001';
    expect(instanceDiscovery._resolvePort('vpn', { Ports: [] }, null, 3)).toBe(4003);
    expect(instanceDiscovery._resolvePort('proxy', null, null, 1)).toBe(4001);
    if (previous === undefined) delete process.env.BASE_PORT;
    else process.env.BASE_PORT = previous;
  });
});

describe('_createdAt', () => {
  it('converte o Created do Docker em ISO', () => {
    expect(instanceDiscovery._createdAt({ Created: 1700000000 }, null))
      .toBe(new Date(1700000000 * 1000).toISOString());
    expect(instanceDiscovery._createdAt(null, { Created: 1700000000 }))
      .toBe(new Date(1700000000 * 1000).toISOString());
  });

  it('sem informação devolve uma data válida', () => {
    const value = instanceDiscovery._createdAt(null, null);
    expect(Number.isNaN(Date.parse(value))).toBe(false);
  });
});
describe('_resolvePort no CloakBrowser (CDP na 9222)', () => {
  it('reconhece a porta 9222 do gluetun, e não só a 3000', () => {
    const gluetun = { Ports: [{ PrivatePort: 9222, PublicPort: 4001 }] };
    expect(instanceDiscovery._resolvePort('vpn', gluetun, null, 1)).toBe(4001);
  });

  it('no modo proxy a 9222 vem do próprio container do chrome', () => {
    const chrome = { Ports: [{ PrivatePort: 9222, PublicPort: 4009 }] };
    expect(instanceDiscovery._resolvePort('proxy', null, chrome, 9)).toBe(4009);
  });

  it('continua aceitando a 3000 do Chromium/Brave', () => {
    const gluetun = { Ports: [{ PrivatePort: 3000, PublicPort: 4002 }] };
    expect(instanceDiscovery._resolvePort('vpn', gluetun, null, 2)).toBe(4002);
  });

  it('ignora portas internas que não são do navegador', () => {
    const gluetun = { Ports: [{ PrivatePort: 8000, PublicPort: 4003 }] };
    expect(instanceDiscovery._resolvePort('vpn', gluetun, null, 3)).toBe(
      parseInt(process.env.BASE_PORT || '3001', 10) + 2
    );
  });
});
