/**
 * Editar / renomear instância.
 *
 * O nome é só o RÓTULO do cartão: renomear não pode tocar no container (a sessão
 * do usuário continua a mesma). A rota é o único caminho que o dashboard usa
 * (`PATCH /api/instances/:id`), e ela também aceita o nome já na criação.
 */
const express = require('express');
const jwt = require('jsonwebtoken');

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
  updateCloakBrowser: jest.fn(),
  rename: jest.fn()
}));

const instanceService = require('../src/services/instance.service');
const instancesRouter = require('../src/routes/instances.router');

describe('PATCH /api/instances/:id — editar a instância', () => {
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
    const fechado = new Promise((resolve) => server.close(resolve));
    if (server.closeAllConnections) server.closeAllConnections();
    await fechado;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    instanceService.rename.mockImplementation(async (id, name) => ({
      id,
      name: name ? String(name).trim() : null
    }));
  });

  async function patch(id, body) {
    const res = await fetch(`${base}/api/instances/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body)
    });
    return { status: res.status, body: await res.json() };
  }

  it('renomeia e devolve o nome final', async () => {
    const res = await patch(2, { name: 'conta da loja' });

    expect(res.status).toBe(200);
    expect(instanceService.rename).toHaveBeenCalledWith(2, 'conta da loja');
    expect(res.body.name).toBe('conta da loja');
    expect(res.body.message).toMatch(/conta da loja/);
  });

  it('nome vazio tira o rótulo (a instância volta a ser só o número)', async () => {
    const res = await patch(2, { name: '' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBeNull();
    expect(res.body.message).toMatch(/número/i);
  });

  it('sem "name" no corpo não há nada para alterar', async () => {
    const res = await patch(2, { country: 'Germany' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/nada para alterar/i);
    expect(instanceService.rename).not.toHaveBeenCalled();
  });

  it('id inválido é recusado', async () => {
    const res = await patch('abc', { name: 'x' });

    expect(res.status).toBe(400);
    expect(instanceService.rename).not.toHaveBeenCalled();
  });

  it('instância que não existe devolve 404', async () => {
    instanceService.rename.mockRejectedValue(
      Object.assign(new Error('Instância 9 não encontrada'), { status: 404 })
    );

    const res = await patch(9, { name: 'x' });

    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/não encontrada/i);
  });

  it('a criação já aceita nome e ele chega ao serviço', async () => {
    instanceService.create.mockResolvedValue({ id: 3, status: 'running', name: 'cliente X' });

    const res = await fetch(`${base}/api/instances`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ type: 'vpn', browser: 'cloakbrowser', name: 'cliente X' })
    });

    expect(res.status).toBe(201);
    expect(instanceService.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'cliente X' }));
  });
});
