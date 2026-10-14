/**
 * Alinhamento do perfil à saída real.
 *
 * O ponto crítico: quando o túnel sobe num IP de outra cidade, o perfil TEM de
 * seguir esse fuso — inclusive se o navegador já estiver aberto (aí a extensão
 * é re-injetada, que é o que a página enxerga).
 */
const dockerService = require('../src/services/docker.service');
const fingerprintService = require('../src/services/fingerprint.service');
const locationResolver = require('../src/services/location-resolver.service');
const profileFingerprint = require('../src/services/profile-fingerprint.service');
const localeProfile = require('../src/services/locale-profile.service');
const instanceService = require('../src/services/instance.service');

// O fingerprint.service é real (o perfil precisa gerar/relocar de verdade);
// só a injeção no container é observada. A troca acontece no próprio objeto
// exportado: os métodos vivem no protótipo e um Object.assign os perderia.
jest.mock('../src/services/fingerprint.service', () => {
  const real = jest.requireActual('../src/services/fingerprint.service');
  real.inject = jest.fn().mockResolvedValue(undefined);
  return real;
});

jest.mock('../src/services/docker.service', () => ({
  isChromeRunning: jest.fn(),
  ensureChromeContainer: jest.fn(),
  recreateChromeContainer: jest.fn(),
  ensureVncViewer: jest.fn(),
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

// A linha do banco é trocada por teste.
const state = { row: null, persisted: [] };

jest.mock('../src/database', () => ({
  getDb: () => ({
    prepare: () => ({
      get: () => state.row,
      all: () => (state.row ? [state.row] : []),
      run: (...args) => { state.persisted.push(args); return {}; }
    })
  })
}));

const TORONTO = localeProfile.fromLocation({
  country: 'Canada',
  countryCode: 'CA',
  city: null,
  timezone: 'America/Toronto',
  source: 'vpn-country'
});

const VANCOUVER = localeProfile.fromLocation({
  country: 'Canada',
  countryCode: 'CA',
  city: 'Vancouver',
  region: 'British Columbia',
  timezone: 'America/Vancouver',
  ip: '84.20.25.99',
  source: 'vpn'
});

/** Linha da tabela com o perfil (país) já persistido. */
function rowWith(fingerprint, overrides) {
  return Object.assign({
    id: 2,
    port: 4002,
    subdomain: 'chrome2.brave.rota.ath.cx',
    type: 'vpn',
    proxy_host: null,
    proxy_port: null,
    proxy_user: null,
    proxy_pass: null,
    proxy_scheme: 'http',
    proxy_auth: 0,
    fingerprint: JSON.stringify(fingerprint),
    browser: 'chromium',
    vpn_provider: 'surfshark'
  }, overrides);
}

beforeEach(() => {
  jest.clearAllMocks();
  state.row = null;
  state.persisted = [];

  dockerService.isChromeRunning.mockResolvedValue(false);
  dockerService.ensureChromeContainer.mockResolvedValue({ exists: true, created: false, recreated: false });
  dockerService.recreateChromeContainer.mockResolvedValue({ exists: true, created: true, recreated: true });
  // Só o CloakBrowser tem viewer VNC; nos outros navegadores o serviço devolve null.
  dockerService.ensureVncViewer.mockResolvedValue(null);
  dockerService.startInstance.mockResolvedValue(undefined);
  dockerService.startVpnContainer.mockResolvedValue(true);
  dockerService.getVpnCountry.mockResolvedValue('Canada');
  locationResolver.forVpnConnected.mockResolvedValue(VANCOUVER);
});

describe('_alignToExit — do fuso do país para o fuso da cidade', () => {
  it('refina o perfil e re-injeta a extensão quando o IP real está noutra cidade', async () => {
    const pais = profileFingerprint.generate('chrome2', TORONTO);
    state.row = rowWith(pais);
    dockerService.isChromeRunning.mockResolvedValue(true);

    const aligned = await instanceService._alignToExit(2, false);

    expect(aligned.timezone).toBe('America/Vancouver');
    expect(aligned.geo.city).toBe('Vancouver');
    expect(aligned.geo.ip).toBe('84.20.25.99');
    expect(aligned.language).toBe('en-CA');

    // A identidade do perfil (seed/userAgent/tela) não muda ao relocar.
    expect(aligned.seed).toBe(pais.seed);
    expect(aligned.userAgent).toBe(pais.userAgent);
    expect(aligned.hardwareConcurrency).toBe(pais.hardwareConcurrency);

    expect(fingerprintService.inject).toHaveBeenCalledTimes(1);
    expect(fingerprintService.inject.mock.calls[0][0]).toBe('chrome2');
    expect(fingerprintService.inject.mock.calls[0][1].timezone).toBe('America/Vancouver');

    // Sessão preservada: nada de recriar o navegador sem pedido explícito.
    expect(dockerService.recreateChromeContainer).not.toHaveBeenCalled();
    expect(state.persisted.length).toBe(1);
  });

  it('com recreateIfRunning recria o browser para o TZ/--lang ficarem exatos', async () => {
    const pais = profileFingerprint.generate('chrome2', TORONTO);
    state.row = rowWith(pais);
    dockerService.isChromeRunning.mockResolvedValue(true);

    await instanceService._alignToExit(2, true);

    expect(dockerService.recreateChromeContainer).toHaveBeenCalledTimes(1);
    const config = dockerService.recreateChromeContainer.mock.calls[0][0];
    expect(config.id).toBe(2);
    expect(config.browser).toBe('chromium');
    expect(config.fingerprint.timezone).toBe('America/Vancouver');
    expect(config.fingerprint.geo.city).toBe('Vancouver');

    expect(dockerService.startInstance).toHaveBeenCalledWith(2);
    expect(fingerprintService.inject).toHaveBeenCalledTimes(1);
  });

  it('CloakBrowser: alinhamento sem recriar explícito ainda aplica as flags (só recriando)', async () => {
    const pais = profileFingerprint.generate('p-fixa', TORONTO);
    state.row = rowWith(pais, { browser: 'cloakbrowser' });
    dockerService.isChromeRunning.mockResolvedValue(true);
    dockerService.ensureChromeContainer.mockResolvedValue({ exists: true, created: true, recreated: true });

    const aligned = await instanceService._alignToExit(2, false);

    expect(aligned.timezone).toBe('America/Vancouver');
    // A impressão digital do CloakBrowser vai nas FLAGS do comando: sem recriar,
    // o fuso e o --fingerprint-webrtc-ip ficariam apontando para a saída ANTIGA.
    expect(dockerService.ensureChromeContainer).toHaveBeenCalledTimes(1);
    expect(dockerService.ensureChromeContainer.mock.calls[0][0].fingerprint.geo.ip).toBe('84.20.25.99');
    expect(dockerService.startInstance).toHaveBeenCalledWith(2);
    // No CloakBrowser não há extensão para injetar.
    expect(fingerprintService.inject).not.toHaveBeenCalled();
  });

  it('Chromium: alinhamento sem recriar explícito não toca no container (a extensão cobre)', async () => {
    state.row = rowWith(profileFingerprint.generate('chrome2', TORONTO));
    dockerService.isChromeRunning.mockResolvedValue(true);

    await instanceService._alignToExit(2, false);

    expect(dockerService.ensureChromeContainer).not.toHaveBeenCalled();
    expect(dockerService.recreateChromeContainer).not.toHaveBeenCalled();
    expect(fingerprintService.inject).toHaveBeenCalledTimes(1);
  });

  it('CloakBrowser: IP novo na MESMA cidade também recria (o WebRTC vai nas flags)', async () => {
    // Mesma cidade/fuso, IP de saída diferente: o perfil já está "alinhado",
    // mas o `--fingerprint-webrtc-ip` apontaria para o IP antigo.
    const antigo = localeProfile.fromLocation({
      country: 'Canada', countryCode: 'CA', city: 'Vancouver',
      region: 'British Columbia', timezone: 'America/Vancouver', ip: '1.1.1.1', source: 'vpn'
    });
    state.row = rowWith(profileFingerprint.generate('p-fixa', antigo), { browser: 'cloakbrowser' });
    dockerService.isChromeRunning.mockResolvedValue(true);
    dockerService.ensureChromeContainer.mockResolvedValue({ exists: true, created: true, recreated: true });

    await instanceService._alignToExit(2, false);

    expect(dockerService.ensureChromeContainer).toHaveBeenCalledTimes(1);
    expect(dockerService.ensureChromeContainer.mock.calls[0][0].fingerprint.geo.ip).toBe('84.20.25.99');
    expect(dockerService.startInstance).toHaveBeenCalledWith(2);
  });

  it('Chromium: IP novo na mesma cidade não reinicia o browser (a extensão cobre)', async () => {
    const antigo = localeProfile.fromLocation({
      country: 'Canada', countryCode: 'CA', city: 'Vancouver',
      region: 'British Columbia', timezone: 'America/Vancouver', ip: '1.1.1.1', source: 'vpn'
    });
    state.row = rowWith(profileFingerprint.generate('chrome2', antigo));
    dockerService.isChromeRunning.mockResolvedValue(true);

    await instanceService._alignToExit(2, false);

    expect(dockerService.ensureChromeContainer).not.toHaveBeenCalled();
    expect(dockerService.recreateChromeContainer).not.toHaveBeenCalled();
  });

  it('perfil que já bate com a saída não é mexido', async () => {
    state.row = rowWith(profileFingerprint.generate('chrome2', VANCOUVER));
    dockerService.isChromeRunning.mockResolvedValue(true);
    state.persisted = [];

    const same = await instanceService._alignToExit(2, true);

    expect(same.timezone).toBe('America/Vancouver');
    expect(fingerprintService.inject).not.toHaveBeenCalled();
    expect(dockerService.recreateChromeContainer).not.toHaveBeenCalled();
    expect(state.persisted.length).toBe(0);
  });

  it('container parado é preparado (ensure + injeta) em vez de recriado', async () => {
    state.row = rowWith(profileFingerprint.generate('chrome2', TORONTO));
    dockerService.isChromeRunning.mockResolvedValue(false);

    await instanceService._alignToExit(2, true);

    expect(dockerService.ensureChromeContainer).toHaveBeenCalledTimes(1);
    expect(dockerService.recreateChromeContainer).not.toHaveBeenCalled();
    expect(fingerprintService.inject).toHaveBeenCalledTimes(1);
  });
});

describe('_prepareInstance — navegador já aberto', () => {
  it('re-injeta a extensão quando o perfil mudou, sem derrubar a sessão', async () => {
    state.row = rowWith(profileFingerprint.generate('chrome2', TORONTO));
    dockerService.isChromeRunning.mockResolvedValue(true);

    const fingerprint = await instanceService._prepareInstance(2);

    expect(fingerprint.timezone).toBe('America/Vancouver');
    expect(fingerprintService.inject).toHaveBeenCalledTimes(1);
    expect(dockerService.ensureChromeContainer).not.toHaveBeenCalled();
    expect(dockerService.recreateChromeContainer).not.toHaveBeenCalled();
  });

  it('perfil inalterado com o navegador rodando não re-injeta', async () => {
    state.row = rowWith(profileFingerprint.generate('chrome2', VANCOUVER));
    dockerService.isChromeRunning.mockResolvedValue(true);

    await instanceService._prepareInstance(2);

    expect(fingerprintService.inject).not.toHaveBeenCalled();
  });

  it('com o container parado garante a spec e injeta antes de subir', async () => {
    state.row = rowWith(profileFingerprint.generate('chrome2', VANCOUVER));
    dockerService.isChromeRunning.mockResolvedValue(false);

    await instanceService._prepareInstance(2);

    expect(dockerService.startVpnContainer).toHaveBeenCalledWith(2);
    expect(dockerService.ensureChromeContainer).toHaveBeenCalledTimes(1);
    expect(fingerprintService.inject).toHaveBeenCalledTimes(1);
  });

  it('instância inexistente devolve null sem tocar em nada', async () => {
    state.row = null;

    expect(await instanceService._prepareInstance(9)).toBeNull();
    expect(await instanceService._alignToExit(9)).toBeNull();
    expect(dockerService.ensureChromeContainer).not.toHaveBeenCalled();
  });
});
describe('_resolveExitWhenReady — espera o túnel revelar o IP real', () => {
  it('insiste até vir uma localização com IP, em vez de aceitar o país', async () => {
    state.row = rowWith(profileFingerprint.generate('chrome2', TORONTO));
    locationResolver.forVpnConnected
      .mockResolvedValueOnce(TORONTO) // ainda sem IP de saída
      .mockResolvedValueOnce(TORONTO)
      .mockResolvedValueOnce(VANCOUVER); // túnel conectou

    const location = await instanceService._resolveExitWhenReady(state.row, null, 5, 1);

    expect(location.ip).toBe('84.20.25.99');
    expect(location.city).toBe('Vancouver');
    expect(locationResolver.forVpnConnected).toHaveBeenCalledTimes(3);
  });

  it('aceita a localização do país quando o IP não chega a tempo', async () => {
    state.row = rowWith(profileFingerprint.generate('chrome2', TORONTO));
    locationResolver.forVpnConnected.mockResolvedValue(TORONTO);

    const location = await instanceService._resolveExitWhenReady(state.row, null, 3, 1);

    expect(location.ip).toBeNull();
    expect(location.source).toBe('vpn-country');
    // Desistiu depois das tentativas previstas, sem laço infinito.
    expect(locationResolver.forVpnConnected).toHaveBeenCalledTimes(3);
  });

  it('não espera nada quando o IP real já está disponível', async () => {
    state.row = rowWith(profileFingerprint.generate('chrome2', TORONTO));

    const location = await instanceService._resolveExitWhenReady(state.row, null, 5, 1);

    expect(location.ip).toBe('84.20.25.99');
    expect(locationResolver.forVpnConnected).toHaveBeenCalledTimes(1);
  });

  it('o alinhamento usa a localização já esperada pela saída real', async () => {
    const pais = profileFingerprint.generate('chrome2', TORONTO);
    state.row = rowWith(pais);
    dockerService.isChromeRunning.mockResolvedValue(true);
    // A espera em si é coberta acima com waitMs curto; aqui só interessa que o
    // alinhamento a use (e não a resolução crua, que aceitaria o país).
    const espera = jest.spyOn(instanceService, '_resolveExitWhenReady').mockResolvedValue(VANCOUVER);

    const aligned = await instanceService._alignToExit(2, false);

    expect(espera).toHaveBeenCalledWith(state.row);
    expect(aligned.geo.city).toBe('Vancouver');
    expect(aligned.geo.ip).toBe('84.20.25.99');
    expect(aligned.timezone).toBe('America/Vancouver');

    espera.mockRestore();
  });
});

describe('_scheduleExitAlignment — VPN que conecta depois do create', () => {
  afterEach(() => jest.useRealTimers());

  it('agenda re-alinhamentos tardios sem recriar o navegador', async () => {
    jest.useFakeTimers();
    const align = jest.spyOn(instanceService, '_alignToExit').mockResolvedValue(null);

    instanceService._scheduleExitAlignment(2, [1000, 2000]);

    expect(align).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1000);
    expect(align).toHaveBeenCalledWith(2, false);

    jest.advanceTimersByTime(1000);
    expect(align).toHaveBeenCalledTimes(2);

    align.mockRestore();
  });
});

describe('_isResolvedExit', () => {
  it('só considera resolvido quando veio um IP de saída', () => {
    expect(instanceService._isResolvedExit(VANCOUVER)).toBe(true);
    expect(instanceService._isResolvedExit(TORONTO)).toBe(false);
    expect(instanceService._isResolvedExit(null)).toBe(false);
  });
});
describe('vigilância da saída — a VPN troca de cidade sozinha', () => {
  it('re-alinha à nova cidade sem recriar o navegador e numa única consulta', async () => {
    state.row = rowWith(profileFingerprint.generate('chrome2', TORONTO));
    dockerService.isChromeRunning.mockResolvedValue(true);

    await instanceService._checkExits();

    const persistido = JSON.parse(state.persisted[0][0]);
    expect(persistido.geo.city).toBe('Vancouver');
    expect(persistido.timezone).toBe('America/Vancouver');
    expect(fingerprintService.inject).toHaveBeenCalledTimes(1);
    // A localização resolvida pela verificação é reaproveitada pelo alinhamento.
    expect(locationResolver.forVpnConnected).toHaveBeenCalledTimes(1);
    expect(dockerService.recreateChromeContainer).not.toHaveBeenCalled();
  });

  it('não mexe em instância parada', async () => {
    state.row = rowWith(profileFingerprint.generate('chrome2', TORONTO));
    dockerService.isChromeRunning.mockResolvedValue(false);

    await instanceService._checkExits();

    expect(dockerService.getVpnCountry).not.toHaveBeenCalled();
    expect(state.persisted.length).toBe(0);
  });

  it('não degrada o perfil quando a saída ainda está sem IP real', async () => {
    state.row = rowWith(profileFingerprint.generate('chrome2', VANCOUVER));
    dockerService.isChromeRunning.mockResolvedValue(true);
    locationResolver.forVpnConnected.mockResolvedValue(TORONTO); // só o país

    await instanceService._checkExits();

    expect(state.persisted.length).toBe(0);
    expect(fingerprintService.inject).not.toHaveBeenCalled();
  });

  it('pula a instância que já está sendo verificada noutro ciclo', async () => {
    state.row = rowWith(profileFingerprint.generate('chrome2', TORONTO));
    dockerService.isChromeRunning.mockResolvedValue(true);
    instanceService._aligning.add(2);

    await instanceService._checkExits();

    expect(dockerService.isChromeRunning).not.toHaveBeenCalled();
    instanceService._aligning.delete(2);
  });

  it('startExitWatcher agenda a verificação, é idempotente e stop desliga', () => {
    jest.useFakeTimers();
    const check = jest.spyOn(instanceService, '_checkExits').mockResolvedValue(undefined);

    const primeiro = instanceService.startExitWatcher(1000);
    const segundo = instanceService.startExitWatcher(1000);
    expect(segundo).toBe(primeiro);

    jest.advanceTimersByTime(3000);
    expect(check).toHaveBeenCalledTimes(3);

    instanceService.stopExitWatcher();
    jest.advanceTimersByTime(3000);
    expect(check).toHaveBeenCalledTimes(3);

    check.mockRestore();
    jest.useRealTimers();
  });
});

describe('_alignToExit com localização já resolvida', () => {
  it('não repete a consulta de geo quando recebe a localização pronta', async () => {
    state.row = rowWith(profileFingerprint.generate('chrome2', TORONTO));
    dockerService.isChromeRunning.mockResolvedValue(true);

    const aligned = await instanceService._alignToExit(2, false, VANCOUVER);

    expect(aligned.timezone).toBe('America/Vancouver');
    expect(locationResolver.forVpnConnected).not.toHaveBeenCalled();
    expect(state.persisted.length).toBe(1);
  });
});
/**
 * CloakBrowser: o prepare também cuida da TELA.
 *
 * O perfil antidetect roda com janela dentro do container e quem entrega essa
 * tela ao usuário é o viewer noVNC (`vnc<id>`), ligado ao navegador pelo socket
 * X. A cada prepare garantimos os dois: o viewer (que publica a tela) e o vhost
 * (que separa o CDP da tela no mesmo subdomínio). Nos outros navegadores a tela
 * já vem do próprio container e o vhost é escrito uma única vez na criação.
 */
describe('_prepareInstance — tela do CloakBrowser', () => {
  const nginxService = require('../src/services/nginx.service');

  function cloakRow() {
    return rowWith(profileFingerprint.generate('chrome2', VANCOUVER), { browser: 'cloakbrowser' });
  }

  it('garante o viewer VNC com a config do container', async () => {
    state.row = cloakRow();
    dockerService.isChromeRunning.mockResolvedValue(true);

    await instanceService._prepareInstance(2);

    expect(dockerService.ensureVncViewer).toHaveBeenCalledTimes(1);
    const config = dockerService.ensureVncViewer.mock.calls[0][0];
    expect(config.id).toBe(2);
    expect(config.port).toBe(4002);
    expect(config.browser).toBe('cloakbrowser');
    expect(config.fingerprint.timezone).toBe('America/Vancouver');
  });

  it('garante o vhost (separação CDP/tela) a cada prepare', async () => {
    state.row = cloakRow();
    dockerService.isChromeRunning.mockResolvedValue(true);

    await instanceService._prepareInstance(2);

    // O vhost do CloakBrowser separa o CDP (WebSocket) da tela no mesmo
    // subdomínio; garanti-lo aqui conserta a instância cujo arquivo foi escrito
    // por uma versão anterior. O serviço de nginx é idempotente: se o arquivo
    // já estiver igual, nada é reescrito nem recarregado.
    expect(nginxService.addServerBlock).toHaveBeenCalledTimes(1);
    expect(nginxService.addServerBlock.mock.calls[0][0]).toMatchObject({
      id: 2,
      port: 4002,
      browser: 'cloakbrowser'
    });
  });

  it('falha ao garantir o vhost não impede o preparo do perfil', async () => {
    state.row = cloakRow();
    dockerService.isChromeRunning.mockResolvedValue(true);
    nginxService.addServerBlock.mockRejectedValueOnce(new Error('nginx fora do ar'));

    await expect(instanceService._prepareInstance(2)).resolves.not.toBeNull();
  });

  it('Chromium/Brave não montam viewer nem têm vhost a garantir', async () => {
    state.row = rowWith(profileFingerprint.generate('chrome2', VANCOUVER));
    dockerService.isChromeRunning.mockResolvedValue(true);

    await instanceService._prepareInstance(2);

    expect(dockerService.ensureVncViewer).toHaveBeenCalledTimes(1);
    expect(dockerService.ensureVncViewer.mock.calls[0][0].browser).toBe('chromium');
    // Nos outros navegadores o vhost é escrito uma vez na criação.
    expect(nginxService.addServerBlock).not.toHaveBeenCalled();
  });

  it('viewer indisponível não impede o preparo do perfil', async () => {
    state.row = cloakRow();
    dockerService.isChromeRunning.mockResolvedValue(true);
    // Em produção o docker.service engole a falha e devolve null.
    dockerService.ensureVncViewer.mockResolvedValueOnce(null);

    await expect(instanceService._prepareInstance(2)).resolves.not.toBeNull();
  });
});
