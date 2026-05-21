const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { getDb } = require('../database');

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-change-me';
const SESSION_EXPIRY = parseInt(process.env.SESSION_EXPIRY || '86400', 10);
const RATE_LIMIT_WINDOW = 5 * 60; // 5 minutes in seconds
const RATE_LIMIT_MAX_ATTEMPTS = 5;

class AuthService {
  login(username, password) {
    const db = getDb();
    const user = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username);

    if (!user) {
      return null;
    }

    const valid = bcrypt.compareSync(password, user.password_hash);
    if (!valid) {
      return null;
    }

    const token = jwt.sign(
      { id: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: SESSION_EXPIRY }
    );

    return token;
  }

  verifyToken(token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      return decoded;
    } catch (err) {
      return null;
    }
  }

  isRateLimited(origin) {
    const db = getDb();
    const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW * 1000).toISOString();

    const attempts = db.prepare(`
      SELECT COUNT(*) as count FROM login_attempts
      WHERE origin = ? AND attempted_at > ? AND success = 0
    `).get(origin, windowStart);

    return attempts.count >= RATE_LIMIT_MAX_ATTEMPTS;
  }

  getRateLimitRemainingTime(origin) {
    const db = getDb();
    const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW * 1000).toISOString();

    const lastAttempt = db.prepare(`
      SELECT attempted_at FROM login_attempts
      WHERE origin = ? AND attempted_at > ? AND success = 0
      ORDER BY attempted_at ASC
      LIMIT 1
    `).get(origin, windowStart);

    if (!lastAttempt) return 0;

    const firstAttemptTime = new Date(lastAttempt.attempted_at + 'Z').getTime();
    const unlockTime = firstAttemptTime + RATE_LIMIT_WINDOW * 1000;
    const remaining = Math.ceil((unlockTime - Date.now()) / 1000);
    return Math.max(0, remaining);
  }

  recordFailedAttempt(origin) {
    const db = getDb();
    db.prepare('INSERT INTO login_attempts (origin, success) VALUES (?, 0)').run(origin);
  }

  clearFailedAttempts(origin) {
    const db = getDb();
    db.prepare('DELETE FROM login_attempts WHERE origin = ?').run(origin);
  }
}

module.exports = new AuthService();
