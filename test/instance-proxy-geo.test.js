/**
 * Ligação instância → proxy da biblioteca (`instances.proxy_id`).
 *
 * É esta ligação que permite ao cartão mostrar ONDE o proxy sai — IP, cidade,
 * país, fuso e ISP do último teste guardado na biblioteca — em vez do endereço
 * do proxy. As instâncias criadas antes da coluna são religadas no arranque do
 * banco, pelo host/porta/usuário.
 *
 * O banco é um arquivo temporário: o SQL corre a sério, sem tocar no banco do
 * serviço.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvpn-proxy-link-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'dashboard.db');

jest.resetModules();
const database = require('../src/database');
const proxiesService = require('../src/services/proxies.service');

// Geo real de um proxy residencial no Canadá (o exemplo que o cartão mostra).
const CANADA_GEO = {
  live: true,
  ip: '176.113.40.157',
  country: 'Canada',
  countryCode: 'CA',
  city: 'Québec',
  timezone: 'America/Toronto',
  isp: 'WS Telecom Inc',
  latencyMs: 312
};

let db;

function saveProxy(overrides = {}) {
  return proxiesService.save({
    name: overrides.name || 'Proxy do Canadá',
    host: overrides.host || 'brd.superproxy.io',
    port: overrides.port || 44445,
    scheme: 'http',
    auth: true,
    username: overrides.username || 'brd-user',
    password: 'segredo'
  }).id;
}

/** Instância como fica gravada: sem proxy_id (o caso das instâncias antigas). */
function insertInstance({ id, port, host, proxyPort, user }) {
  db.prepare(
    `INSERT INTO instances (id, port, subdomain, type, proxy_host, proxy_port, proxy_user)
     VALUES (?, ?, ?, 'proxy', ?, ?, ?)`
  ).run(id, port, `chrome${id}.sakr.ath.cx`, host, proxyPort, user);
}

function proxyIdOf(id) {
  return db.prepare('SELECT proxy_id FROM instances WHERE id = ?').get(id).proxy_id;
}

describe('instância → proxy da biblioteca (geo do cartão)', () => {
  beforeAll(() => {
    database.initDatabase();
    db = database.getDb();
  });

  afterAll(() => {
    try { db.close(); } catch (err) { /* já fechado */ }
    delete process.env.DATABASE_PATH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    db.exec('DELETE FROM instances');
    db.exec('DELETE FROM proxies');
  });

  it('cria a coluna proxy_id na tabela de instâncias', () => {
    const columns = db.prepare('PRAGMA table_info(instances)').all().map((c) => c.name);
    expect(columns).toContain('proxy_id');
  });

  it('religa pelo host/porta/usuário as instâncias criadas antes da coluna', () => {
    const proxyId = saveProxy();
    insertInstance({ id: 1, port: 4001, host: 'brd.superproxy.io', proxyPort: 44445, user: 'brd-user' });

    database.initDatabase(); // idempotente: a religação corre outra vez

    expect(proxyIdOf(1)).toBe(proxyId);
  });

  it('não liga instâncias de proxies diferentes', () => {
    saveProxy({ name: 'Outro proxy', username: 'outro-user' });
    insertInstance({ id: 2, port: 4002, host: 'brd.superproxy.io', proxyPort: 44445, user: 'brd-user' });

    database.initDatabase();

    expect(proxyIdOf(2)).toBeNull();
  });

  it('não mexe nas instâncias VPN (sem proxy)', () => {
    db.prepare(
      `INSERT INTO instances (id, port, subdomain, type, vpn_provider)
       VALUES (3, 4003, 'chrome3.sakr.ath.cx', 'vpn', 'surfshark')`
    ).run();

    database.initDatabase();

    expect(proxyIdOf(3)).toBeNull();
  });

  it('entrega IP, local, fuso e ISP do proxy pelo id', () => {
    const proxyId = saveProxy();
    proxiesService.saveGeo(proxyId, CANADA_GEO);

    expect(proxiesService.geoFor(proxyId)).toEqual({
      country: 'Canada',
      countryCode: 'CA',
      city: 'Québec',
      timezone: 'America/Toronto',
      ip: '176.113.40.157',
      isp: 'WS Telecom Inc',
      testedAt: expect.any(String)
    });
  });

  it('devolve o mapa completo numa consulta só (todas as instâncias)', () => {
    const canada = saveProxy({ name: 'Canadá', username: 'user-ca' });
    const semTeste = saveProxy({ name: 'Sem teste', username: 'user-st' });
    proxiesService.saveGeo(canada, CANADA_GEO);

    const map = proxiesService.geoMap();
    expect(map.size).toBe(2);
    expect(map.get(canada).ip).toBe('176.113.40.157');
    expect(map.get(semTeste).ip).toBeNull();
  });

  it('devolve null para um proxy que não está na biblioteca', () => {
    expect(proxiesService.geoFor(999)).toBeNull();
  });
});
