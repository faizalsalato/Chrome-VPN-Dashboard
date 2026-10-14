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

/**
 * Verificação no site do vendor (cloakbrowser.dev).
 *
 * É a única forma de saber se a chave ainda vale e até quando: `validate` diz o
 * plano e o prazo, `session/count` diz os lugares em uso. O módulo `https` é
 * injetado, por isso estes testes não tocam na rede.
 */
describe('cloak-licenses.service — verificação no vendor', () => {
  beforeEach(() => {
    mockDb.exec('DROP TABLE IF EXISTS cloak_licenses');
    mockDb.exec('DROP TABLE IF EXISTS instances');
    mockDb.exec(SCHEMA);
    cloakLicenses.addMany('chave-aaaa-1111');
  });

  /** Duplo do `https`: responde por caminho do pedido. */
  function fakeHttps(answers) {
    return {
      request(options, callback) {
        const answer = answers[options.path] || { status: 500, body: '{}' };
        const req = {
          on() { return req; },
          write() {},
          end() {
            const res = {
              statusCode: answer.status,
              on(event, handler) {
                if (event === 'data') handler(answer.body);
                if (event === 'end') handler();
                return res;
              }
            };
            callback(res);
          }
        };
        return req;
      }
    };
  }

  it('lê plano, prazo e lugares e grava na linha da chave', async () => {
    const [item] = cloakLicenses.list();
    const client = fakeHttps({
      '/api/license/validate': {
        status: 200,
        body: '{"valid":true,"plan":"trial","expires":"2026-10-17T12:56:09+00:00"}'
      },
      '/api/license/session/count': { status: 200, body: '{"valid":true,"active":0,"limit":5}' }
    });

    const result = await cloakLicenses.check(item.id, { client });

    expect(result.checked).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.plan).toBe('trial');
    expect(result.expires).toBe('2026-10-17T12:56:09+00:00');
    expect(result.seatsActive).toBe(0);
    expect(result.seatsLimit).toBe(5);

    const [checked] = cloakLicenses.list();
    expect(checked.plan).toBe('trial');
    expect(checked.expires).toBe('2026-10-17T12:56:09+00:00');
    expect(checked.seatsLimit).toBe(5);
    expect(checked.checkedAt).toBeTruthy();
  });

  it('marca o motivo quando o vendor recusa a chave, sem apagar o que já sabia', async () => {
    const [item] = cloakLicenses.list();
    cloakLicenses.saveCheck(item.id, { plan: 'trial', expires: '2026-10-17', seatsActive: 0, seatsLimit: 5 });

    const client = fakeHttps({ '/api/license/validate': { status: 403, body: '{"error":"invalid_key"}' } });
    const result = await cloakLicenses.check(item.id, { client });

    expect(result.checked).toBe(false);
    expect(result.error).toBe('invalid_key');

    const [kept] = cloakLicenses.list();
    expect(kept.plan).toBe('trial');
    expect(kept.expires).toBe('2026-10-17');
  });

  it('uma falha de rede não invalida a chave', async () => {
    const [item] = cloakLicenses.list();
    const client = {
      request() {
        const req = {
          on(event, handler) {
            if (event === 'error') {
              setTimeout(() => handler(new Error('getaddrinfo ENOTFOUND cloakbrowser.dev')), 0);
            }
            return req;
          },
          write() {},
          end() {}
        };
        return req;
      }
    };

    const result = await cloakLicenses.check(item.id, { client });

    expect(result.checked).toBe(false);
    expect(result.error).toMatch(/ENOTFOUND/);
    expect(cloakLicenses.list()[0].plan).toBeNull();
  });

  it('verifica todas as chaves da biblioteca de uma vez', async () => {
    cloakLicenses.addMany('chave-bbbb-2222');
    const client = fakeHttps({
      '/api/license/validate': { status: 200, body: '{"valid":true,"plan":"pro"}' },
      '/api/license/session/count': { status: 200, body: '{"active":1,"limit":10}' }
    });

    const results = await cloakLicenses.checkAll({ client });

    expect(results).toHaveLength(2);
    expect(cloakLicenses.list().every(item => item.plan === 'pro')).toBe(true);
    expect(cloakLicenses.list().every(item => item.seatsLimit === 10)).toBe(true);
  });

  it('chave que não está na biblioteca dá 404', async () => {
    await expect(cloakLicenses.check(999)).rejects.toMatchObject({ status: 404 });
  });
});
