/**
 * Geo do proxy salvo.
 *
 * O resultado do último teste fica guardado no próprio proxy — é o que permite
 * mostrar o PAÍS de um proxy (no cartão e na hora de criar a instância) sem
 * testá-lo de novo. A senha continua fora da listagem.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Banco em memória: o serviço roda o SQL de verdade, sem tocar no banco do app.
const mockDb = new Database(':memory:');
jest.mock('../src/database', () => ({ getDb: () => mockDb }));

const proxiesService = require('../src/services/proxies.service');

// Mesmo formato que a migração de src/database.js produz.
const PROXIES_SCHEMA = `
  CREATE TABLE proxies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    scheme TEXT DEFAULT 'http',
    auth INTEGER DEFAULT 0,
    username TEXT,
    password TEXT,
    country TEXT,
    country_code TEXT,
    city TEXT,
    timezone TEXT,
    geo_ip TEXT,
    isp TEXT,
    tested_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
`;

const LIVE_GEO = {
  live: true,
  ip: '185.96.133.239',
  country: 'Germany',
  countryCode: 'DE',
  city: 'Munich',
  timezone: 'Europe/Berlin',
  isp: 'WS Telecom Inc',
  latencyMs: 454
};

describe('proxies.service — geo do último teste', () => {
  beforeEach(() => {
    mockDb.exec('DROP TABLE IF EXISTS proxies');
    mockDb.exec(PROXIES_SCHEMA);
    proxiesService.save({
      name: 'Proxy de Munique',
      host: 'brd.superproxy.io',
      port: 44445,
      scheme: 'http',
      auth: true,
      username: 'brd-user',
      password: 'segredo'
    });
  });

  it('guarda país, cidade, fuso, IP e provedor do teste bem-sucedido', () => {
    const result = proxiesService.saveGeo(1, LIVE_GEO);
    expect(result).toEqual({ saved: true });

    const proxy = proxiesService.list()[0];
    expect(proxy.country).toBe('Germany');
    expect(proxy.countryCode).toBe('DE');
    expect(proxy.city).toBe('Munich');
    expect(proxy.timezone).toBe('Europe/Berlin');
    expect(proxy.geoIp).toBe('185.96.133.239');
    expect(proxy.isp).toBe('WS Telecom Inc');
    expect(proxy.testedAt).toBeTruthy();
  });

  it('não mexe na geo quando o teste falha ou não traz país', () => {
    expect(proxiesService.saveGeo(1, { live: false, error: 'Tempo esgotado' }))
      .toEqual({ saved: false });
    expect(proxiesService.saveGeo(1, { live: true, country: null }))
      .toEqual({ saved: false });
    expect(proxiesService.saveGeo(1, null)).toEqual({ saved: false });

    const proxy = proxiesService.list()[0];
    expect(proxy.country).toBeNull();
    expect(proxy.city).toBeNull();
    expect(proxy.testedAt).toBeNull();
  });

  it('sobrescreve a geo antiga quando o proxy muda de saída', () => {
    proxiesService.saveGeo(1, LIVE_GEO);
    proxiesService.saveGeo(1, {
      live: true, country: 'United States', countryCode: 'US',
      city: 'New York', timezone: 'America/New_York', ip: '37.19.199.242', isp: 'Datacamp'
    });

    const proxy = proxiesService.list()[0];
    expect(proxy.country).toBe('United States');
    expect(proxy.city).toBe('New York');
    expect(proxy.timezone).toBe('America/New_York');
    expect(proxy.geoIp).toBe('37.19.199.242');
  });

  it('continua sem expor a senha na listagem', () => {
    const proxy = proxiesService.list()[0];
    expect(proxy.hasPassword).toBe(true);
    expect(proxy).not.toHaveProperty('password');
    expect(JSON.stringify(proxy)).not.toContain('segredo');
  });
});

describe('database — migração das colunas de geo dos proxies', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'database.js'), 'utf-8');

  it.each(['country', 'country_code', 'city', 'timezone', 'geo_ip', 'isp', 'tested_at'])(
    'cria e migra a coluna %s',
    (column) => {
      expect(source).toContain(`ALTER TABLE proxies ADD COLUMN ${column} TEXT`);
      expect(source).toContain(`${column} TEXT`);
    }
  );
});
