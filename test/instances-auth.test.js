/**
 * A URL de conexão do CloakBrowser (bloco `cdp`) só pode sair da API para quem
 * tem sessão: é o que impede alguém sem login de pegar o endereço do navegador
 * antidetect e consumir a licença.
 *
 * O teste sobe o router de verdade numa porta efêmera e fala HTTP com ele —
 * nada de chamar a função direto, porque o que está em jogo é justamente a
 * camada que exige o token.
 */
const express = require('express');
const jwt = require('jsonwebtoken');

// O service é substituído: aqui interessa a autenticação, não o Docker.
jest.mock('../src/services/instance.service', () => ({
  getAll: jest.fn(),
  create: jest.fn(),
  remove: jest.fn(),
  start: jest.fn(),
  stop: jest.fn(),
  restart: jest.fn(),
  changeCountry: jest.fn(),
  getVPNInfo: jest.fn()
}));

const instanceService = require('../src/services/instance.service');
const instancesRouter = require('../src/routes/instances.router');

const CDP_PAYLOAD = {
  instances: [{
    id: 3,
    browser: 'cloakbrowser',
    subdomain: 'chrome3.rota.ath.cx',
    cdp: {
      port: 9222,
      endpointUrl: 'https://chrome3.rota.ath.cx',
      discoveryUrl: 'https://chrome3.rota.ath.cx/json/version',
      connectUrl: 'https://chrome3.rota.ath.cx?fingerprint=chrome3&geoip=true'
    }
  }],
  dockerConnected: true,
  lastUpdated: new Date().toISOString()
};

describe('autenticação da API de instâncias', () => {
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
    instanceService.getAll.mockResolvedValue(CDP_PAYLOAD);
  });

  it('o router começa pelo authMiddleware (nenhuma rota nasce aberta)', () => {
    const first = instancesRouter.stack[0];
    expect(first.handle.name).toBe('authMiddleware');
  });

  it('sem token não devolve instâncias — e portanto nem a URL do CDP', async () => {
    const res = await fetch(`${base}/api/instances`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.message).toContain('não fornecido');
    expect(JSON.stringify(body)).not.toContain('connectUrl');
    expect(instanceService.getAll).not.toHaveBeenCalled();
  });

  it('header em formato errado também é recusado', async () => {
    const res = await fetch(`${base}/api/instances`, {
      headers: { Authorization: 'Token abc123' }
    });
    expect(res.status).toBe(401);
    expect((await res.json()).message).toContain('Formato de token inválido');
  });

  it('token inválido ou expirado é recusado', async () => {
    const expirado = jwt.sign(
      { id: 1, username: 'admin' },
      process.env.JWT_SECRET || 'sakaru',
      { expiresIn: -10 }
    );

    for (const invalido of ['nao-e-jwt', expirado]) {
      const res = await fetch(`${base}/api/instances`, {
        headers: { Authorization: `Bearer ${invalido}` }
      });
      expect(res.status).toBe(401);
      expect((await res.json()).message).toContain('inválido');
    }
    expect(instanceService.getAll).not.toHaveBeenCalled();
  });

  it('com sessão válida devolve a instância CloakBrowser com o bloco cdp', async () => {
    const res = await fetch(`${base}/api/instances`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.instances[0].browser).toBe('cloakbrowser');
    expect(body.instances[0].cdp.connectUrl).toContain('fingerprint=chrome3');
    expect(instanceService.getAll).toHaveBeenCalledTimes(1);
  });

  it('criar instância também exige sessão', async () => {
    const res = await fetch(`${base}/api/instances`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'vpn', browser: 'cloakbrowser', country: 'Germany' })
    });
    expect(res.status).toBe(401);
    expect(instanceService.create).not.toHaveBeenCalled();
  });
});
