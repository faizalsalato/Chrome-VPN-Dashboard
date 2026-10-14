/**
 * Biblioteca de chaves do CloakBrowser.
 *
 * No modo grátis o binário aceita UMA sessão em paralelo; cada chave Pro
 * acrescenta sessões. Com várias instâncias é preciso mais do que uma chave, e
 * é este serviço que as guarda, distribui pelas instâncias (a menos carregada
 * primeiro) e nunca devolve a chave por inteiro na listagem.
 */
const Database = require('better-sqlite3');

// Banco em memória: o serviço roda o SQL de verdade, sem tocar no banco do app.
const mockDb = new Database(':memory:');
jest.mock('../src/database', () => ({ getDb: () => mockDb }));

const cloakLicenses = require('../src/services/cloak-licenses.service');

// Mesmo formato que a migração de src/database.js produz.
const SCHEMA = `
  CREATE TABLE cloak_licenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    license_key TEXT UNIQUE NOT NULL,
    label TEXT,
    plan TEXT,
    expires TEXT,
    seats_active INTEGER,
    seats_limit INTEGER,
    checked_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE instances (
    id INTEGER PRIMARY KEY,
    cloak_edition TEXT DEFAULT 'free',
    cloak_license_id INTEGER
  );
`;

describe('cloak-licenses.service — biblioteca de chaves', () => {
  beforeEach(() => {
    mockDb.exec('DROP TABLE IF EXISTS cloak_licenses');
    mockDb.exec('DROP TABLE IF EXISTS instances');
    mockDb.exec(SCHEMA);
  });

  it('adiciona várias chaves de uma vez e ignora as repetidas', () => {
    const result = cloakLicenses.addMany('chave-aaaa-1111\nchave-bbbb-2222\nchave-aaaa-1111');

    expect(result.added).toBe(2);
    expect(result.total).toBe(3);
    expect(cloakLicenses.count()).toBe(2);
  });

  it('recusa lista vazia e ignora chaves curtas demais', () => {
    expect(() => cloakLicenses.addMany('   ')).toThrow(/pelo menos uma chave/i);

    const result = cloakLicenses.addMany('abc\nchave-bbbb-2222');
    expect(result.added).toBe(1);
    expect(result.invalid).toBe(1);
  });

  it('lista sem nunca devolver a chave inteira', () => {
    cloakLicenses.addMany('cb_live_abcdefghijklmnop');

    const [item] = cloakLicenses.list();
    expect(item.masked).toBe('cb_l…mnop');
    expect(JSON.stringify(item)).not.toContain('abcdefghijklmnop');
    expect(item.instances).toBe(0);
  });

  it('distribui as instâncias pela chave menos carregada (e não muda sozinho)', () => {
    cloakLicenses.addMany('chave-aaaa-1111\nchave-bbbb-2222');
    const [first, second] = cloakLicenses.list();

    mockDb.prepare('INSERT INTO instances (id) VALUES (1)').run();
    expect(cloakLicenses.ensureAssigned(1)).toBe(first.id);

    mockDb.prepare('INSERT INTO instances (id) VALUES (2)').run();
    expect(cloakLicenses.ensureAssigned(2)).toBe(second.id);

    // Estável: pedir outra vez devolve a MESMA chave.
    expect(cloakLicenses.ensureAssigned(1)).toBe(first.id);
    expect(cloakLicenses.list().find(item => item.id === first.id).instances).toBe(1);
  });

  it('solta as instâncias quando a chave é removida', () => {
    cloakLicenses.addMany('chave-aaaa-1111');
    mockDb.prepare('INSERT INTO instances (id) VALUES (1)').run();
    const id = cloakLicenses.ensureAssigned(1);

    expect(cloakLicenses.keyFor(id)).toBe('chave-aaaa-1111');

    const result = cloakLicenses.remove(id);
    expect(result.instancesFreed).toBe(1);
    expect(mockDb.prepare('SELECT cloak_license_id FROM instances WHERE id = 1').get().cloak_license_id).toBeNull();
    expect(cloakLicenses.count()).toBe(0);
  });

  it('sem chaves na biblioteca não atribui nada', () => {
    expect(cloakLicenses.assignFor(1)).toBeNull();
    expect(cloakLicenses.ensureAssigned(1)).toBeNull();
  });

  it('guarda o plano e as sessões de uma verificação', () => {
    cloakLicenses.addMany('chave-aaaa-1111');
    const [item] = cloakLicenses.list();

    cloakLicenses.saveCheck(item.id, { plan: 'pro', expires: '2027-01-01', seatsActive: 2, seatsLimit: 10 });

    const [checked] = cloakLicenses.list();
    expect(checked.plan).toBe('pro');
    expect(checked.expires).toBe('2027-01-01');
    expect(checked.seatsActive).toBe(2);
    expect(checked.seatsLimit).toBe(10);
    expect(checked.checkedAt).toBeTruthy();
  });
});
