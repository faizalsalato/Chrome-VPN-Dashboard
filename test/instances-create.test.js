/**
 * Criação de instância: o corpo do pedido tem de chegar INTEIRO ao serviço.
 *
 * Já falhou na prática: a rota montava o objeto de criação à mão e deixava cair
 * o `cloakEdition` — a instância nascia "sem licença" mesmo escolhendo a versão
 * com chave, sem aviso nenhum — e o `proxyId` (o cartão ficava sem a geo do
 * proxy). Estes testes existem para que a lista de campos não volte a encolher.
 */
const express = require('express');
const jwt = require('jsonwebtoken');

// O service é substituído: aqui interessa o que a rota lhe entrega.
jest.mock('../src/services/instance.service', () => ({
  getAll: jest.fn(),
  create: jest.fn(),
  remove: jest.fn(),
  start: jest.fn(),
  stop: jest.fn(),
  restart: jest.fn(),
  changeCountry: jest.fn(),
  getVPNInfo: jest.fn(),
  changeCloakEdition: jest.fn(),
  changeProxy: jest.fn(),
  updateCloakBrowser: jest.fn()
}));

const instanceService = require('../src/services/instance.service');
const instancesRouter = require('../src/routes/instances.router');

describe('criação de instância — o payload chega ao serviço', () => {
  let server;
  let base;
  let token;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/instances', instancesRouter);
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    token = jwt.sign(
      { id: 1, username: 'admin' },
      process.env.JWT_SECRET || 'sakaru',
      { expiresIn: 60 }
    );
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    instanceService.create.mockResolvedValue({ id: 1, status: 'running' });
  });

  async function post(body) {
    const res = await fetch(`${base}/api/instances`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body)
    });
    return { status: res.status, body: await res.json() };
  }

  it('leva a versão do CloakBrowser escolhida até ao serviço', async () => {
    const res = await post({
      type: 'vpn', browser: 'cloakbrowser', cloakEdition: 'pro', country: 'Germany'
    });

    expect(res.status).toBe(201);
    expect(instanceService.create).toHaveBeenCalledWith(expect.objectContaining({
      type: 'vpn',
      browser: 'cloakbrowser',
      cloakEdition: 'pro',
      country: 'Germany'
    }));
  });

  it('leva o id do proxy da biblioteca (geo do cartão)', async () => {
    const res = await post({
      type: 'proxy',
      browser: 'cloakbrowser',
      cloakEdition: 'pro',
      proxyId: 7,
      proxy: { host: 'brd.superproxy.io', port: 44445, user: 'u', pass: 'p', auth: true }
    });

    expect(res.status).toBe(201);
    const options = instanceService.create.mock.calls[0][0];
    expect(options.proxyId).toBe(7);
    expect(options.proxy).toMatchObject({
      host: 'brd.superproxy.io', port: 44445, user: 'u', pass: 'p', auth: true
    });
  });

  it('recusa uma versão desconhecida em vez de a ignorar em silêncio', async () => {
    const res = await post({ type: 'vpn', browser: 'cloakbrowser', cloakEdition: 'premium' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Versão do CloakBrowser/);
    expect(instanceService.create).not.toHaveBeenCalled();
  });

  it('recusa o Brave (saiu das opções; ficam Chromium e CloakBrowser)', async () => {
    const res = await post({ type: 'vpn', browser: 'brave' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Navegador inválido/);
    expect(instanceService.create).not.toHaveBeenCalled();
  });

  it('sem versão no corpo continua a criar (o serviço aplica o padrão)', async () => {
    const res = await post({ type: 'vpn', browser: 'cloakbrowser' });

    expect(res.status).toBe(201);
    expect(instanceService.create).toHaveBeenCalledWith(
      expect.objectContaining({ cloakEdition: undefined })
    );
  });
});
