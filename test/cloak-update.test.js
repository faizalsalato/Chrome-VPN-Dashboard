/**
 * Atualização do binário Pro do CloakBrowser.
 *
 * O wrapper tem um comando próprio para isto (`cloakbrowser update`): pergunta
 * ao vendor qual é a versão resolvida e só baixa quando é diferente da que está
 * em cache — "Already up to date." quando não há nada novo. O dashboard corre-o
 * num container descartável, com o mesmo volume de cache das instâncias, e só
 * recria as instâncias Pro que estão a correr quando houve mesmo download.
 */
const state = {
  licenseRow: { id: 3 },
  proRows: [],
  running: {},
  output: ''
};

jest.mock('../src/database', () => ({
  getDb: () => ({
    prepare: () => ({
      get: () => state.licenseRow,
      all: () => state.proRows,
      run: () => ({ changes: 1 })
    })
  })
}));

jest.mock('../src/services/cloak-licenses.service', () => ({
  keyFor: jest.fn(() => 'cb_chave_de_teste'),
  list: jest.fn(() => [{ id: 3 }])
}));

jest.mock('../src/services/docker.service', () => ({
  isChromeRunning: jest.fn(),
  ensureBrowserImage: jest.fn(),
  updateCloakBinary: jest.fn(),
  removeContainers: jest.fn(),
  createInstance: jest.fn(),
  startInstance: jest.fn(),
  getVpnCountry: jest.fn()
}));

jest.mock('../src/services/nginx.service', () => ({
  addServerBlock: jest.fn(),
  removeServerBlock: jest.fn()
}));

jest.mock('../src/services/proxy-injector.service', () => ({
  start: jest.fn(),
  stop: jest.fn(),
  isRunning: jest.fn().mockReturnValue(false),
  getPort: jest.fn()
}));

const dockerService = require('../src/services/docker.service');
const cloakLicenses = require('../src/services/cloak-licenses.service');
const instanceService = require('../src/services/instance.service');
const cloakbrowser = require('../src/services/cloakbrowser.service');

// Saídas reais do wrapper (a v154 é a que o vendor serve hoje).
const UP_TO_DATE = [
  'Checking for updates...',
  'Already up to date.',
  'CLOAKBROWSER_BINARY=/opt/cloak-cache/chromium-154.0.8037.57.2-pro/chrome'
].join('\n');

const UPDATED = [
  'Checking for updates...',
  'Download progress: 99% (225/227 MB)',
  'Updated to Pro Chromium 155.0.8100.1',
  'CLOAKBROWSER_BINARY=/opt/cloak-cache/chromium-155.0.8100.1-pro/chrome'
].join('\n');

describe('cloakbrowser.service — comando e leitura do update', () => {
  it('corre o update do wrapper com o cache no volume partilhado', () => {
    const command = cloakbrowser.updateCommand();

    expect(command).toContain(`CLOAKBROWSER_CACHE_DIR=${cloakbrowser.CACHE_DIR} cloakbrowser update`);
    expect(command).toContain('CLOAKBROWSER_BINARY=$CLOAK_BIN');
  });

  it('lê "Already up to date." e a versão que ficou em cache', () => {
    expect(cloakbrowser.parseUpdateOutput(UP_TO_DATE)).toEqual({
      updated: false,
      downloadedVersion: null,
      version: '154.0.8037.57.2',
      upToDate: true,
      failed: false
    });
  });

  it('lê a versão nova quando o vendor publica outra', () => {
    const info = cloakbrowser.parseUpdateOutput(UPDATED);

    expect(info.updated).toBe(true);
    expect(info.downloadedVersion).toBe('155.0.8100.1');
    expect(info.version).toBe('155.0.8100.1');
  });

  it('marca a falha do wrapper sem inventar versão', () => {
    const info = cloakbrowser.parseUpdateOutput('[WARN] update do binario Pro falhou\nCLOAKBROWSER_BINARY=');

    expect(info.failed).toBe(true);
    expect(info.updated).toBe(false);
    expect(info.version).toBeNull();
  });
});

describe('docker.service — update num container descartável', () => {
  // O módulo é o verdadeiro: nos testes da instância acima ele está mockado, mas
  // aqui quer-se a construção do container.
  const realDockerService = jest.requireActual('../src/services/docker.service');

  function fakeDocker(output, status = 0) {
    const container = {
      start: jest.fn().mockResolvedValue(undefined),
      wait: jest.fn().mockResolvedValue({ StatusCode: status }),
      logs: jest.fn().mockResolvedValue(Buffer.from(output)),
      remove: jest.fn().mockResolvedValue(undefined)
    };
    return { createContainer: jest.fn().mockResolvedValue(container), container };
  }

  it('usa a chave e o volume do cache e remove o container no fim', async () => {
    const client = fakeDocker(UPDATED);

    const result = await realDockerService.updateCloakBinary({
      image: 'chrome-vpn-dashboard-browser:latest',
      licenseKey: 'cb_chave_de_teste',
      client
    });

    const options = client.createContainer.mock.calls[0][0];
    expect(options.Image).toBe('chrome-vpn-dashboard-browser:latest');
    expect(options.Env).toContain('CLOAKBROWSER_LICENSE_KEY=cb_chave_de_teste');
    expect(options.Env).toContain(`CLOAKBROWSER_CACHE_DIR=${cloakbrowser.CACHE_DIR}`);
    expect(options.HostConfig.Binds).toEqual([cloakbrowser.cacheBind()]);
    expect(options.Cmd.join(' ')).toContain('cloakbrowser update');

    expect(result.output).toContain('Updated to Pro Chromium 155.0.8100.1');
    expect(client.container.remove).toHaveBeenCalled();
  });
});

describe('instanceService.updateCloakBrowser', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    // Histórico limpo entre testes: sem isto as chamadas acumulam e as
    // asserções de "não foi chamado" mentem.
    jest.clearAllMocks();
    state.licenseRow = { id: 3 };
    state.proRows = [];

    dockerService.ensureBrowserImage.mockResolvedValue('chrome-vpn-dashboard-browser:latest');
    dockerService.isChromeRunning.mockResolvedValue(false);
    cloakLicenses.keyFor.mockReturnValue('cb_chave_de_teste');
    cloakLicenses.list.mockReturnValue([{ id: 3 }]);
  });

  it('sem versão nova não recria nenhuma instância', async () => {
    dockerService.updateCloakBinary.mockResolvedValue({ status: 0, output: UP_TO_DATE });
    const recreate = jest.spyOn(instanceService, 'changeCloakEdition');

    const result = await instanceService.updateCloakBrowser();

    expect(result.updated).toBe(false);
    expect(result.upToDate).toBe(true);
    expect(result.version).toBe('154.0.8037.57.2');
    expect(result.recreated).toEqual([]);
    expect(recreate).not.toHaveBeenCalled();
  });

  it('com versão nova recria só as instâncias Pro que estão a correr', async () => {
    state.proRows = [{ id: 1 }, { id: 2 }];
    dockerService.isChromeRunning.mockImplementation(async (id) => id === 1);
    dockerService.updateCloakBinary.mockResolvedValue({ status: 0, output: UPDATED });
    const recreate = jest.spyOn(instanceService, 'changeCloakEdition').mockResolvedValue(undefined);

    const result = await instanceService.updateCloakBrowser();

    expect(result.updated).toBe(true);
    expect(result.downloadedVersion).toBe('155.0.8100.1');
    expect(result.recreated).toEqual([1]);
    expect(recreate).toHaveBeenCalledTimes(1);
    expect(recreate).toHaveBeenCalledWith(1, 'pro');
  });

  it('usa a chave que uma instância já tem (a licença é da instância)', async () => {
    state.licenseRow = { id: 9 };
    dockerService.updateCloakBinary.mockResolvedValue({ status: 0, output: UP_TO_DATE });

    await instanceService.updateCloakBrowser();

    expect(cloakLicenses.keyFor).toHaveBeenCalledWith(9);
    expect(dockerService.updateCloakBinary).toHaveBeenCalledWith(
      expect.objectContaining({ licenseKey: 'cb_chave_de_teste' })
    );
  });

  it('sem chaves na biblioteca recusa com 400', async () => {
    state.licenseRow = null;
    cloakLicenses.list.mockReturnValue([]);

    await expect(instanceService.updateCloakBrowser()).rejects.toMatchObject({ status: 400 });
    expect(dockerService.updateCloakBinary).not.toHaveBeenCalled();
  });
});
