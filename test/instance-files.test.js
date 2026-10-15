/**
 * Envio de ficheiro para o perfil: o corpo tem de chegar INTEIRO ao serviço.
 *
 * Já falhou na prática: 24 MB davam erro — o ficheiro ia em base64 dentro de um
 * JSON de 25 MB (33% mais pesado) e o nginx cortava em 1 MB. Agora o ficheiro
 * vai CRU no corpo, o dashboard escreve-o num temporário no disco e só depois o
 * entrega ao docker (que o lê em blocos, sem passar pela memória).
 */
const fs = require('fs');
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
  saveFile: jest.fn()
}));

const instanceService = require('../src/services/instance.service');
const instancesRouter = require('../src/routes/instances.router');

describe('envio de ficheiro para o perfil', () => {
  let server;
  let base;
  let token;
  let enviado;        // conteúdo que o teste atual manda
  let visto;          // o que o serviço recebeu

  beforeAll(async () => {
    const app = express();
    // Mesmo limite do dashboard real: o corpo cru não passa por aqui.
    app.use(express.json({ limit: '25mb' }));
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
    // O `fetch` deixa as conexões em keep-alive: sem as destruir, o `close` fica
    // à espera delas e o Jest estoura o tempo do hook.
    const fechado = new Promise((resolve) => server.close(resolve));
    if (server.closeAllConnections) server.closeAllConnections();
    await fechado;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    visto = null;

    // O serviço lê o temporário no momento da chamada: é a prova de que o
    // conteúdo chegou ao disco inteiro (e não pela memória do dashboard).
    instanceService.saveFile.mockImplementation(async (id, name, source) => {
      if (Buffer.isBuffer(source)) {
        visto = { id, name, bytes: source.length, noDisco: null, igual: null };
        return { path: '/profile/Downloads/x', name: name || 'ficheiro', bytes: source.length };
      }
      visto = {
        id,
        name,
        bytes: source.bytes,
        noDisco: fs.statSync(source.path).size,
        igual: fs.readFileSync(source.path).equals(enviado)
      };
      return { path: '/profile/Downloads/x', name: name || 'ficheiro', bytes: source.bytes };
    });
  });

  async function upload(body, headers = {}) {
    const res = await fetch(`${base}/api/instances/1/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, ...headers },
      body
    });
    return { status: res.status, body: await res.json() };
  }

  it('24 MB cru no corpo chegam inteiros ao disco e o temporário é apagado', async () => {
    enviado = Buffer.alloc(24 * 1024 * 1024, 7);

    const res = await upload(enviado, {
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent('vídeo da praia.mp4')
    });

    expect(res.status).toBe(201);
    expect(visto.name).toBe('vídeo da praia.mp4');
    expect(visto.bytes).toBe(enviado.length);
    expect(visto.noDisco).toBe(enviado.length);
    expect(visto.igual).toBe(true);
    // O temporário não fica para trás.
    expect(fs.existsSync(instanceService.saveFile.mock.calls[0][2].path)).toBe(false);
  });

  it('o nome viaja codificado (acentos e emojis sobrevivem)', async () => {
    enviado = Buffer.from('conteudo');

    await upload(enviado, {
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent('foto de São João 📸.jpg')
    });

    expect(visto.name).toBe('foto de São João 📸.jpg');
  });

  it('corpo vazio é recusado sem guardar nada', async () => {
    enviado = Buffer.alloc(0);

    const res = await upload(enviado, { 'Content-Type': 'application/octet-stream' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/vazio/i);
    expect(instanceService.saveFile).not.toHaveBeenCalled();
  });

  it('com MAX_UPLOAD_BYTES definido, o que passa do teto é recusado', async () => {
    const anterior = process.env.MAX_UPLOAD_BYTES;
    process.env.MAX_UPLOAD_BYTES = String(1024 * 1024);
    enviado = Buffer.alloc(2 * 1024 * 1024, 1);

    try {
      const res = await upload(enviado, { 'Content-Type': 'application/octet-stream' });

      expect(res.status).toBe(413);
      expect(res.body.message).toMatch(/maior que 1 MB/i);
      expect(instanceService.saveFile).not.toHaveBeenCalled();
    } finally {
      if (anterior === undefined) delete process.env.MAX_UPLOAD_BYTES;
      else process.env.MAX_UPLOAD_BYTES = anterior;
    }
  });

  it('o contrato antigo (base64 no JSON) continua a funcionar', async () => {
    enviado = Buffer.from('foto pequena');

    const res = await upload(JSON.stringify({
      name: 'pequena.png',
      data: enviado.toString('base64')
    }), { 'Content-Type': 'application/json' });

    expect(res.status).toBe(201);
    expect(visto.name).toBe('pequena.png');
    expect(visto.bytes).toBe(enviado.length);
  });
});
