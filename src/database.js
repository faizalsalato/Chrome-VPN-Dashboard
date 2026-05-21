const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.NODE_ENV === 'production'
  ? '/app/data/dashboard.db'
  : path.join(__dirname, '..', 'data', 'dashboard.db');

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
  `);

  // Create indexes
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_login_attempts_origin ON login_attempts(origin, attempted_at);
    CREATE INDEX IF NOT EXISTS idx_instances_port ON instances(port);
  `);

  // Seed default admin user
  const adminUser = process.env.ADMIN_USER || 'admin';
  const adminPass = process.env.ADMIN_PASS || 'admin123';

  const existing = database.prepare('SELECT id FROM users WHERE username = ?').get(adminUser);
  if (!existing) {
    const hash = bcrypt.hashSync(adminPass, 10);
    database.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(adminUser, hash);
    console.log(`[${new Date().toISOString()}] [INFO] [database] Usuário admin criado`);
  }

  console.log(`[${new Date().toISOString()}] [INFO] [database] Banco inicializado em ${DB_PATH}`);
}

module.exports = { getDb, initDatabase };
