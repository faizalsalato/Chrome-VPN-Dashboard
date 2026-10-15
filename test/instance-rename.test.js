/**
 * Nome da instância (no serviço).
 *
 * O nome vai para o título do cartão, que é uma linha só: antes de gravar ele é
 * saneado — caracteres de controlo fora, espaços repetidos viram um só, sobra
 * cortada. Vazio significa "sem rótulo" (null), nunca uma string vazia.
 */
const instanceService = require('../src/services/instance.service');

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
  getContainerHealth: jest.fn(),
  saveProfileFile: jest.fn()
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

describe('instance.service — nome da instância', () => {
  beforeEach(() => {
    state.row = { id: 2, name: null, type: 'vpn', browser: 'cloakbrowser' };
    state.runs = [];
  });

  it('sanea o nome antes de gravar', () => {
    expect(instanceService.cleanName('  conta   da  loja ')).toBe('conta da loja');
    expect(instanceService.cleanName('linha\ncom\tcontrolo')).toBe('linha com controlo');
    expect(instanceService.cleanName('')).toBeNull();
    expect(instanceService.cleanName('   ')).toBeNull();
    expect(instanceService.cleanName(null)).toBeNull();
    expect(instanceService.cleanName(undefined)).toBeNull();
    expect(instanceService.cleanName('a'.repeat(200)).length).toBe(60);
  });

  it('renomear grava o nome limpo e devolve-o', async () => {
    const resultado = await instanceService.rename(2, '  conta  da loja ');

    expect(resultado).toEqual({ id: 2, name: 'conta da loja' });
    expect(state.runs[0]).toEqual(['conta da loja', 2]);
  });

  it('nome só com espaços tira o rótulo', async () => {
    const resultado = await instanceService.rename(2, '   ');

    expect(resultado).toEqual({ id: 2, name: null });
    expect(state.runs[0]).toEqual([null, 2]);
  });

  it('instância que não existe dá 404 (nada é gravado)', async () => {
    state.row = null;

    await expect(instanceService.rename(9, 'x')).rejects.toMatchObject({ status: 404 });
    expect(state.runs).toHaveLength(0);
  });
});
