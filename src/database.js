const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

// DATABASE_PATH permite apontar outro arquivo — é o que os testes usam para
// NÃO tocar no banco do serviço em produção. Sem ele, vale o caminho do ambiente.
const DB_PATH = process.env.DATABASE_PATH
  || (process.env.NODE_ENV === 'production'
    ? '/app/data/dashboard.db'
    : path.join(__dirname, '..', 'data', 'dashboard.db'));

let db;

function getDb() {
  if (!db) {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function initDatabase() {
  const database = getDb();

  // Create tables
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS login_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      origin TEXT NOT NULL,
      attempted_at TEXT DEFAULT (datetime('now')),
      success INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS instances (
      id INTEGER PRIMARY KEY,
      port INTEGER UNIQUE NOT NULL,
      subdomain TEXT UNIQUE NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS vpn_credentials (
      provider TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS proxies (
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

    CREATE TABLE IF NOT EXISTS cloak_licenses (
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
  `);

  // Migration: adiciona colunas de proxy em instâncias já existentes
  const instanceCols = database.prepare('PRAGMA table_info(instances)').all().map(c => c.name);
  const migrations = [
    ['type', "ALTER TABLE instances ADD COLUMN type TEXT DEFAULT 'vpn'"],
    ['proxy_host', 'ALTER TABLE instances ADD COLUMN proxy_host TEXT'],
    ['proxy_port', 'ALTER TABLE instances ADD COLUMN proxy_port INTEGER'],
    ['proxy_user', 'ALTER TABLE instances ADD COLUMN proxy_user TEXT'],
    ['proxy_pass', 'ALTER TABLE instances ADD COLUMN proxy_pass TEXT'],
    ['proxy_scheme', "ALTER TABLE instances ADD COLUMN proxy_scheme TEXT DEFAULT 'http'"],
    ['proxy_auth', 'ALTER TABLE instances ADD COLUMN proxy_auth INTEGER DEFAULT 0'],
    ['name', 'ALTER TABLE instances ADD COLUMN name TEXT'],
    ['fingerprint', 'ALTER TABLE instances ADD COLUMN fingerprint TEXT'],
    ['browser', "ALTER TABLE instances ADD COLUMN browser TEXT DEFAULT 'chromium'"],
    ['vpn_provider', "ALTER TABLE instances ADD COLUMN vpn_provider TEXT DEFAULT 'surfshark'"],
    // Edição do CloakBrowser: 'free' = binário antigo, sem chave; 'pro' = binário
    // novo com a chave da biblioteca (é o que permite mais de uma sessão em
    // paralelo — no modo grátis o binário só aceita uma).
    ['cloak_edition', "ALTER TABLE instances ADD COLUMN cloak_edition TEXT DEFAULT 'free'"],
    ['cloak_license_id', 'ALTER TABLE instances ADD COLUMN cloak_license_id INTEGER'],
    // Ligação à biblioteca de proxies: é o que permite mostrar a GEO do proxy
    // (IP de saída, cidade, fuso, ISP) no cartão, e não só o endereço.
    ['proxy_id', 'ALTER TABLE instances ADD COLUMN proxy_id INTEGER']
  ];
  for (const [col, sql] of migrations) {
    if (!instanceCols.includes(col)) {
      database.exec(sql);
    }
  }

  // Migration: guarda o resultado de geo do último teste de cada proxy salvo.
  // É o que permite mostrar o PAÍS de um proxy na hora de criar a instância
  // (e no próprio cartão) sem precisar testá-lo de novo a cada abertura.
  const proxyCols = database.prepare('PRAGMA table_info(proxies)').all().map(c => c.name);
  const proxyMigrations = [
    ['country', 'ALTER TABLE proxies ADD COLUMN country TEXT'],
    ['country_code', 'ALTER TABLE proxies ADD COLUMN country_code TEXT'],
    ['city', 'ALTER TABLE proxies ADD COLUMN city TEXT'],
    ['timezone', 'ALTER TABLE proxies ADD COLUMN timezone TEXT'],
    ['geo_ip', 'ALTER TABLE proxies ADD COLUMN geo_ip TEXT'],
    ['isp', 'ALTER TABLE proxies ADD COLUMN isp TEXT'],
    ['tested_at', 'ALTER TABLE proxies ADD COLUMN tested_at TEXT']
  ];
  for (const [col, sql] of proxyMigrations) {
    if (!proxyCols.includes(col)) {
      database.exec(sql);
    }
  }

  // Create indexes
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_login_attempts_origin ON login_attempts(origin, attempted_at);
    CREATE INDEX IF NOT EXISTS idx_instances_port ON instances(port);
  `);

  // Liga as instâncias antigas ao proxy da biblioteca que lhes deu origem
  // (mesmo host/porta/usuário). É o que faz o cartão mostrar a geo do proxy nas
  // instâncias criadas antes da coluna `proxy_id`. Idempotente.
  database.exec(`
    UPDATE instances
       SET proxy_id = (
             SELECT p.id FROM proxies p
              WHERE p.host = instances.proxy_host
                AND p.port = instances.proxy_port
                AND COALESCE(p.username, '') = COALESCE(instances.proxy_user, '')
              LIMIT 1
           )
     WHERE proxy_id IS NULL AND proxy_host IS NOT NULL
  `);

  // Seed default admin user
  const adminUser = process.env.ADMIN_USER || 'sakaru';
  const adminPass = process.env.ADMIN_PASS || 'sakaru';

  const existing = database.prepare('SELECT id FROM users WHERE username = ?').get(adminUser);
  if (!existing) {
    const hash = bcrypt.hashSync(adminPass, 10);
    database.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(adminUser, hash);
    console.log(`[${new Date().toISOString()}] [INFO] [database] Usuário admin criado`);
  }

  console.log(`[${new Date().toISOString()}] [INFO] [database] Banco inicializado em ${DB_PATH}`);
}

module.exports = { getDb, initDatabase };
