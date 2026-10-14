/**
 * Portas do host.
 *
 * O dashboard só conhece as portas das instâncias que ele mesmo criou. Se
 * outro container (de outro app) já publica uma porta da faixa, o Docker falha
 * ao subir o túnel com "address already in use" e a instância fica pela metade —
 * aconteceu de verdade na 3001. Por isso a lista de portas publicadas entra na
 * escolha da próxima porta.
 */
const dockerService = require('../src/services/docker.service');

function clientReturning(containers) {
  return { listContainers: jest.fn().mockResolvedValue(containers) };
}

describe('listPublishedPorts', () => {
  it('junta as portas públicas de todos os containers', async () => {
    const client = clientReturning([
      { Ports: [{ PrivatePort: 3000, PublicPort: 4001 }, { PrivatePort: 9222, PublicPort: 4002 }] },
      { Ports: [{ PrivatePort: 1080, PublicPort: 51080 }] },
      { Ports: [] },
      {}
    ]);

    const ports = await dockerService.listPublishedPorts(client);
    expect([...ports].sort((a, b) => a - b)).toEqual([4001, 4002, 51080]);
  });

  it('ignora mapeamentos sem porta pública (container parado)', async () => {
    const client = clientReturning([{ Ports: [{ PrivatePort: 9222 }] }]);
    expect((await dockerService.listPublishedPorts(client)).size).toBe(0);
  });

  it('sem Docker devolve conjunto vazio em vez de lançar', async () => {
    const client = { listContainers: jest.fn().mockRejectedValue(new Error('sem socket')) };
    const ports = await dockerService.listPublishedPorts(client);
    expect(ports.size).toBe(0);
  });
});
