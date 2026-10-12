const { getDb } = require('../database');

const PROVIDERS = ['surfshark', 'expressvpn'];

// Credenciais legadas (mantidas como fallback enquanto o usuário não salvar
// as dele no menu "Credenciais VPN" — preserva comportamento anterior).
const LEGACY_DEFAULTS = {
  surfshark: { user: 'G9t9Fr7L67MT9Qg7AuV6P6PH', pass: 'aemT8ba6Tm3DqKta8B9qtuVK' },
  expressvpn: { user: '', pass: '' }
};

class VpnCredentialsService {
  isValidProvider(p) {
    return PROVIDERS.includes(p);
  }

  /**
   * Lista os providers com status (mascarado — nunca expõe a senha).
   */
  list() {
    const db = getDb();
    const rows = db.prepare('SELECT provider, updated_at FROM vpn_credentials').all();
    const saved = new Map(rows.map(r => [r.provider, r.updated_at]));
    return PROVIDERS.map(provider => ({
      provider,
      configured: saved.has(provider),
      updatedAt: saved.get(provider) || null
    }));
  }

  /**
   * Salva (push) as credenciais de um provider.
   */
  save(provider, username, password) {
    if (!this.isValidProvider(provider)) {
      throw Object.assign(new Error("Provedor inválido. Use 'surfshark' ou 'expressvpn'"), { status: 400 });
    }
    if (!username || !password) {
      throw Object.assign(new Error('Usuário e senha são obrigatórios'), { status: 400 });
    }
    const db = getDb();
    db.prepare(`INSERT INTO vpn_credentials (provider, username, password, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(provider) DO UPDATE SET
        username = excluded.username,
        password = excluded.password,
        updated_at = excluded.updated_at`).run(provider, username, password);
    return { provider, configured: true };
  }

  /**
   * Retorna as credenciais efetivas de um provider: tabela primeiro,
   * fallback para os defaults legados (surfshark) ou env.
   */
  getEffective(provider) {
    const p = this.isValidProvider(provider) ? provider : 'surfshark';
    try {
      const db = getDb();
      const row = db.prepare('SELECT username, password FROM vpn_credentials WHERE provider = ?').get(p);
      if (row) return { user: row.username, pass: row.password };
    } catch (err) {
      // Banco não inicializado ainda — segue para o fallback
    }
    const legacy = LEGACY_DEFAULTS[p] || { user: '', pass: '' };
    return {
      user: process.env[`${p.toUpperCase()}_OPENVPN_USER`] || legacy.user,
      pass: process.env[`${p.toUpperCase()}_OPENVPN_PASSWORD`] || legacy.pass
    };
  }
}

module.exports = new VpnCredentialsService();
