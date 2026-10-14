/**
 * Troca de país da VPN.
 *
 * Dois pontos que já quebraram na prática:
 *  1. o volume do perfil (cookies/login) NÃO pode ser apagado — trocar de país
 *     refaz os containers, não a sessão do usuário (`removeContainers`, nunca
 *     `removeInstance`);
 *  2. a identidade é preservada: muda idioma, fuso e geo, não a persona
 *     (seed, plataforma, tela, GPU).
 */
const dockerService = require('../src/services/docker.service');
const fingerprintService = require('../src/services/fingerprint.service');
const locationResolver = require('../src/services/location-resolver.service');
const profileFingerprint = require('../src/services/profile-fingerprint.service');
const localeProfile = require('../src/services/locale-profile.service');
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
  removeContainers: jest.fn(),
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

const state = { row: null, runs: [] };

jest.mock('../src/database', () => ({
  getDb: () => ({
    prepare: () => ({
      get: () => state.row,
      all: () => (state.row ? [state.row] : []),
      run: (...args) => { state.runs.push(args); return {}; }
    })
  })
}));

// Saída atual do perfil (Canadá/Montreal) e a saída pedida (Alemanha).
const CANADA = localeProfile.fromLocation({
  country: 'Canada', countryCode: 'CA', city: 'Montreal', region: 'Quebec',
  timezone: 'America/Toronto', ip: '62.93.167.77', source: 'vpn'
});

const GERMANY = localeProfile.fromLocation({
  country: 'Germany', countryCode: 'DE', city: 'Frankfurt', region: 'Hesse',
  timezone: 'Europe/Berlin', ip: '45.150.174.97', source: 'vpn'
});

/** Linha da instância VPN (CloakBrowser) já com o perfil do Canadá. */
function vpnRow(fingerprint) {
  return {
    id: 1,
    port: 4001,
    subdomain: 'chrome1.brave.rota.ath.cx',
    type: 'vpn',
    proxy_host: null,
    proxy_port: null,
    proxy_user: null,
    proxy_pass: null,
    proxy_scheme: 'http',
    proxy_auth: 0,
    fingerprint: JSON.stringify(fingerprint),
    browser: 'cloakbrowser',
    vpn_provider: 'surfshark'
  };
}

const STORED = profileFingerprint.generate('p-abc123', CANADA);

beforeEach(() => {
  jest.clearAllMocks();
  state.runs = [];
  state.row = vpnRow(STORED);

  dockerService.isChromeRunning.mockResolvedValue(false);
  dockerService.ensureChromeContainer.mockResolvedValue({ recreated: false });
  dockerService.startInstance.mockResolvedValue(undefined);
  dockerService.removeContainers.mockResolvedValue(undefined);
  dockerService.removeInstance.mockResolvedValue(undefined);
  dockerService.createInstance.mockResolvedValue({ id: 1, status: 'running' });
  dockerService.startVpnContainer.mockResolvedValue(true);
  locationResolver.forVpn.mockResolvedValue(GERMANY);
  locationResolver.forVpnConnected.mockResolvedValue(GERMANY);
});

describe('instanceService.changeCountry', () => {
  it('preserva o volume do perfil (a sessão não pode morrer ao trocar de país)', async () => {
    await instanceService.changeCountry(1, 'Germany');

    expect(dockerService.removeContainers).toHaveBeenCalledWith(1);
    expect(dockerService.removeInstance).not.toHaveBeenCalled();
  });

  it('preserva a persona: a identidade do perfil continua a mesma', async () => {
    await instanceService.changeCountry(1, 'Germany');

    const config = dockerService.createInstance.mock.calls[0][0];
    // Identidade intacta (seed, plataforma, tela, GPU)...
    expect(config.fingerprint.seed).toBe(STORED.seed);
    expect(config.fingerprint.platform).toBe(STORED.platform);
    expect(config.fingerprint.screen).toEqual(STORED.screen);
    expect(config.fingerprint.webgl).toEqual(STORED.webgl);
    expect(config.fingerprint.userAgent).toBe(STORED.userAgent);
    // ...e só a localização seguiu o país novo.
    expect(config.fingerprint.geo.country).toBe('Germany');
    expect(config.fingerprint.geo.city).toBe('Frankfurt');
    expect(config.fingerprint.timezone).toBe('Europe/Berlin');
    expect(config.fingerprint.language).toBe('de-DE');
  });

  it('recria os containers no país novo, com o país pedido no túnel', async () => {
    await instanceService.changeCountry(1, 'Germany');

    const config = dockerService.createInstance.mock.calls[0][0];
    expect(config.serverCountries).toBe('Germany');
    expect(config.type).toBe('vpn');
    expect(config.port).toBe(4001);
    expect(config.browser).toBe('cloakbrowser');
    expect(dockerService.startInstance).toHaveBeenCalledWith(1);
  });

  it('grava o fingerprint novo na linha (o card não pode ficar com a saída antiga)', async () => {
    await instanceService.changeCountry(1, 'Germany');

    const update = state.runs.find((args) => typeof args[0] === 'string' && args[0].includes('"country":"Germany"'));
    expect(update).toBeTruthy();
    expect(update[1]).toBe(1);   // id da instância
    expect(JSON.parse(update[0]).geo.ip).toBe('45.150.174.97');
  });

  it('recusa instâncias que não são VPN', async () => {
    state.row = Object.assign(vpnRow(STORED), { type: 'proxy' });

    await expect(instanceService.changeCountry(1, 'Germany')).rejects.toMatchObject({ status: 400 });
    expect(dockerService.removeContainers).not.toHaveBeenCalled();
    expect(dockerService.createInstance).not.toHaveBeenCalled();
  });

  it('recusa instância inexistente', async () => {
    state.row = null;

    await expect(instanceService.changeCountry(9, 'Germany')).rejects.toMatchObject({ status: 404 });
    expect(dockerService.removeContainers).not.toHaveBeenCalled();
  });
});
