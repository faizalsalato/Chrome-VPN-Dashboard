/**
 * Troca de proxy de uma instância (o botão "País" das instâncias proxy).
 *
 * Diferente da VPN — onde o país é escolhido —, a localização de um proxy vem
 * de ONDE ELE SAI: trocar de proxy é trocar de saída. O que o teste protege é
 * a ordem das coisas: a linha do banco TEM de passar a apontar para o proxy
 * novo ANTES de o forwarder de autenticação subir, senão o container recriado
 * (e o forwarder) voltariam a usar o proxy antigo.
 */
const dockerService = require('../src/services/docker.service');
const fingerprintService = require('../src/services/fingerprint.service');
const locationResolver = require('../src/services/location-resolver.service');
const profileFingerprint = require('../src/services/profile-fingerprint.service');
const localeProfile = require('../src/services/locale-profile.service');
const proxiesService = require('../src/services/proxies.service');
const proxyInjector = require('../src/services/proxy-injector.service');
const instanceService = require('../src/services/instance.service');

// O fingerprint.service é real (o perfil precisa gerar/relocar de verdade);
// só a injeção no container é observada.
jest.mock('../src/services/fingerprint.service', () => {
  const real = jest.requireActual('../src/services/fingerprint.service');
  real.inject = jest.fn().mockResolvedValue(undefined);
  return real;
});

jest.mock('../src/services/docker.service', () => ({
  isChromeRunning: jest.fn(),
  ensureChromeContainer: jest.fn(),
  recreateChromeContainer: jest.fn(),
  startInstance: jest.fn(),
  startVpnContainer: jest.fn(),
  getVpnCountry: jest.fn(),
  removeInstance: jest.fn(),
  createInstance: jest.fn(),
  getContainerHealth: jest.fn()
}));

jest.mock('../src/services/nginx.service', () => ({
  addServerBlock: jest.fn(),
  removeServerBlock: jest.fn()
}));

jest.mock('../src/services/location-resolver.service', () => ({
  forVpn: jest.fn(),
  forVpnConnected: jest.fn(),
  forProxy: jest.fn()
}));

jest.mock('../src/services/proxy-injector.service', () => ({
  start: jest.fn(),
  stop: jest.fn(),
  isRunning: jest.fn().mockReturnValue(false),
  getPort: jest.fn()
}));

jest.mock('../src/services/proxies.service', () => ({
  getWithSecrets: jest.fn()
}));

const state = { row: null, runs: [] };

// O "banco" espelha as escritas na própria linha: é o que permite verificar
// que o forwarder sobe já com o proxy NOVO.
jest.mock('../src/database', () => ({
  getDb: () => ({
    prepare: (sql) => ({
      get: () => state.row,
      all: () => (state.row ? [state.row] : []),
      run: (...args) => {
        state.runs.push({ sql, args });
        if (state.row && /proxy_host\s*=/.test(sql)) {
          state.row.proxy_host = args[0];
          state.row.proxy_port = args[1];
          state.row.proxy_user = args[2];
          state.row.proxy_pass = args[3];
          state.row.proxy_scheme = args[4];
          state.row.proxy_auth = args[5];
          state.row.fingerprint = args[6];
        }
        return {};
      }
    })
  })
}));

const FRANKFURT = localeProfile.fromLocation({
  country: 'Germany',
  countryCode: 'DE',
  city: 'Frankfurt',
  timezone: 'Europe/Berlin',
  ip: '5.6.7.8',
  source: 'proxy'
});

const OLD_PROXY = { id: 3, name: 'antigo', host: '1.2.3.4', port: 8080, scheme: 'http', auth: false, user: '', pass: '' };
const NEW_PROXY = { id: 7, name: 'novo', host: '5.6.7.8', port: 3128, scheme: 'http', auth: true, user: 'u', pass: 'p' };

/** Linha da instância proxy, já com o perfil do proxy antigo. */
function proxyRow() {
  return {
    id: 2,
    port: 4002,
    subdomain: 'chrome2.brave.rota.ath.cx',
    type: 'proxy',
    proxy_host: OLD_PROXY.host,
    proxy_port: OLD_PROXY.port,
    proxy_user: '',
    proxy_pass: '',
    proxy_scheme: 'http',
    proxy_auth: 0,
    fingerprint: JSON.stringify(profileFingerprint.generate('chrome2', FRANKFURT)),
    browser: 'chromium',
    vpn_provider: null
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  state.row = proxyRow();
  state.runs = [];

  dockerService.isChromeRunning.mockResolvedValue(false);
  dockerService.ensureChromeContainer.mockResolvedValue({ recreated: false });
  dockerService.recreateChromeContainer.mockResolvedValue(undefined);
  dockerService.startInstance.mockResolvedValue(undefined);
  dockerService.removeInstance.mockResolvedValue(undefined);
  dockerService.createInstance.mockResolvedValue({ id: 2, status: 'running' });
  proxiesService.getWithSecrets.mockReturnValue(NEW_PROXY);
  locationResolver.forProxy.mockResolvedValue({ test: {}, error: null, location: FRANKFURT });
});

describe('instanceService.changeProxy', () => {
  it('recria os containers com o proxy escolhido e grava a troca na linha', async () => {
    await instanceService.changeProxy(2, 7);

    expect(proxiesService.getWithSecrets).toHaveBeenCalledWith(7);
    expect(dockerService.removeInstance).toHaveBeenCalledWith(2);

    const config = dockerService.createInstance.mock.calls[0][0];
    expect(config.type).toBe('proxy');
    expect(config.port).toBe(4002);
    expect(config.proxy).toEqual({
      host: '5.6.7.8', port: 3128, user: 'u', pass: 'p', scheme: 'http', auth: true
    });

    // A linha passa a apontar para o proxy novo...
    const update = state.runs.find(r => /proxy_host\s*=/.test(r.sql));
    expect(update).toBeTruthy();
    expect(update.args[0]).toBe('5.6.7.8');
    expect(update.args[1]).toBe(3128);
    expect(update.args[5]).toBe(1);   // proxy_auth
    expect(update.args[7]).toBe(2);   // id
    // ...e o perfil é regerado para a geo do proxy novo.
    expect(JSON.parse(update.args[6]).geo.country).toBe('Germany');

    // O forwarder de autenticação sobe com o proxy NOVO (a ordem importa).
    expect(proxyInjector.start).toHaveBeenCalledWith(2, {
      host: '5.6.7.8', port: 3128, user: 'u', pass: 'p', scheme: 'http', auth: true
    });

    expect(dockerService.startInstance).toHaveBeenCalledWith(2);
  });

  it('derruba o forwarder antigo antes de recriar os containers', async () => {
    proxyInjector.isRunning.mockReturnValue(true);

    await instanceService.changeProxy(2, 7);

    expect(proxyInjector.stop).toHaveBeenCalledWith(2);
  });

  it('recusa instâncias que não são proxy', async () => {
    state.row = Object.assign(proxyRow(), { type: 'vpn' });

    await expect(instanceService.changeProxy(2, 7)).rejects.toMatchObject({ status: 400 });
    expect(dockerService.removeInstance).not.toHaveBeenCalled();
    expect(dockerService.createInstance).not.toHaveBeenCalled();
    expect(fingerprintService.inject).not.toHaveBeenCalled();
  });

  it('recusa instância inexistente', async () => {
    state.row = null;

    await expect(instanceService.changeProxy(9, 7)).rejects.toMatchObject({ status: 404 });
    expect(dockerService.removeInstance).not.toHaveBeenCalled();
  });

  it('propaga o 404 quando o proxy escolhido não existe', async () => {
    proxiesService.getWithSecrets.mockImplementation(() => {
      throw Object.assign(new Error('Proxy não encontrado'), { status: 404 });
    });

    await expect(instanceService.changeProxy(2, 999)).rejects.toMatchObject({ status: 404 });
    expect(dockerService.removeInstance).not.toHaveBeenCalled();
  });
});
