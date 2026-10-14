const { getDb } = require('../database');

/**
 * ProxiesService - CRUD de uma biblioteca de proxies salvos.
 * A senha é mascarada na listagem (nunca retornada pela API de leitura),
 * seguindo o mesmo padrão do menu "Credenciais VPN".
 */
class ProxiesService {
  /**
   * Lista todos os proxies salvos (sem expor a senha).
   * Retorna apenas metadados + flag hasPassword.
   */
  list() {
    const db = getDb();
    const rows = db.prepare(
      'SELECT id, name, host, port, scheme, auth, username, password, ' +
      'country, country_code, city, timezone, geo_ip, isp, tested_at, updated_at ' +
      'FROM proxies ORDER BY name'
    ).all();
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      host: r.host,
      port: r.port,
      scheme: r.scheme || 'http',
      auth: !!r.auth,
      username: r.username || '',
      hasPassword: !!(r.password && r.password.length),
      // Geo do último teste (a senha nunca é exposta; isto é só o IP de saída).
      country: r.country || null,
      countryCode: r.country_code || null,
      city: r.city || null,
      timezone: r.timezone || null,
      geoIp: r.geo_ip || null,
      isp: r.isp || null,
      testedAt: r.tested_at || null,
      updatedAt: r.updated_at
    }));
  }

  /**
   * Guarda a geo do último teste bem-sucedido de um proxy.
   * É o que permite mostrar o PAÍS de um proxy salvo sem testá-lo de novo.
   *
   * @param {number} id
   * @param {object} geo resultado do proxy-tester ({ country, countryCode, city, ... })
   */
  saveGeo(id, geo) {
    if (!geo || !geo.live) return { saved: false };
    const country = geo.country || null;
    if (!country) return { saved: false };

    getDb().prepare(
      `UPDATE proxies
       SET country = ?, country_code = ?, city = ?, timezone = ?, geo_ip = ?, isp = ?,
           tested_at = datetime('now')
       WHERE id = ?`
    ).run(
      country,
      geo.countryCode || null,
      geo.city || null,
      geo.timezone || null,
      geo.ip || null,
      geo.isp || null,
      id
    );
    return { saved: true };
  }

  get(id) {
    const db = getDb();
    const row = db.prepare(
      'SELECT id, name, host, port, scheme, auth, username, password FROM proxies WHERE id = ?'
    ).get(id);
    if (!row) {
      throw Object.assign(new Error('Proxy não encontrado'), { status: 404 });
    }
    return row;
  }

  /**
   * Retorna o proxy completo (com senha) para uso interno ao criar instância.
   */
  getWithSecrets(id) {
    const row = this.get(id);
    return {
      id: row.id,
      name: row.name,
      host: row.host,
      port: row.port,
      scheme: row.scheme || 'http',
      auth: !!row.auth,
      user: row.username || '',
      pass: row.password || ''
    };
  }

  /**
   * Cria ou atualiza um proxy.
   * Se id for informado, atualiza (mantendo a senha caso venha em branco).
   */
  save({ id, name, host, port, scheme, auth, username, password }) {
    if (!name || !name.trim()) {
      throw Object.assign(new Error('Nome é obrigatório'), { status: 400 });
    }
    if (!host || !host.trim()) {
      throw Object.assign(new Error('Host é obrigatório'), { status: 400 });
    }
    const portNum = parseInt(port, 10);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      throw Object.assign(new Error('Porta inválida'), { status: 400 });
    }
    const normalizedScheme = scheme === 'https' ? 'https' : 'http';
    const authFlag = auth ? 1 : 0;
    if (authFlag && (!username || !username.trim())) {
      throw Object.assign(new Error('Proxy autenticado requer usuário'), { status: 400 });
    }
    if (authFlag && id && !password) {
      // Atualização sem senha: precisa já existir uma senha salva
      const existing = this._passwordOf(id);
      if (!existing) {
        throw Object.assign(new Error('Proxy autenticado requer senha'), { status: 400 });
      }
    }
    if (authFlag && !id && !password) {
      throw Object.assign(new Error('Proxy autenticado requer senha'), { status: 400 });
    }

    const db = getDb();
    const cleanName = name.trim();
    const cleanHost = host.trim();
    const cleanUser = (username || '').trim();

    if (id) {
      // UPDATE (mantém senha antiga se password vier vazio)
      if (password) {
        db.prepare(`UPDATE proxies
          SET name = ?, host = ?, port = ?, scheme = ?, auth = ?, username = ?, password = ?, updated_at = datetime('now')
          WHERE id = ?`).run(cleanName, cleanHost, portNum, normalizedScheme, authFlag, cleanUser, password, id);
      } else {
        db.prepare(`UPDATE proxies
          SET name = ?, host = ?, port = ?, scheme = ?, auth = ?, username = ?, updated_at = datetime('now')
          WHERE id = ?`).run(cleanName, cleanHost, portNum, normalizedScheme, authFlag, cleanUser, id);
      }
      return { id, name: cleanName };
    }

    const info = db.prepare(`INSERT INTO proxies (name, host, port, scheme, auth, username, password, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
      .run(cleanName, cleanHost, portNum, normalizedScheme, authFlag, cleanUser, password || '');
    return { id: info.lastInsertRowid, name: cleanName };
  }

  remove(id) {
    const db = getDb();
    const info = db.prepare('DELETE FROM proxies WHERE id = ?').run(id);
    if (info.changes === 0) {
      throw Object.assign(new Error('Proxy não encontrado'), { status: 404 });
    }
    return { removed: true };
  }

  /**
   * Importa uma lista de proxies de uma vez.
   * Aceita itens já parseados: { host, port, user, pass, scheme?, name? }.
   * Ignora duplicatas (mesmo host+porta+usuário). Não sobrescreve existentes.
   * Roda em uma transação (tudo ou nada por item válido).
   *
   * @param {Array<object>} items
   * @returns {{imported:number, skipped:number, total:number}}
   */
  bulkImport(items) {
    if (!Array.isArray(items)) {
      throw Object.assign(new Error('Lista inválida'), { status: 400 });
    }
    const db = getDb();

    // Conjunto de chaves já existentes (host|port|user) para deduplicar
    const existing = new Set(
      db.prepare('SELECT host, port, username FROM proxies').all()
        .map(r => `${r.host.toLowerCase()}|${r.port}|${(r.username || '').toLowerCase()}`)
    );

    const insert = db.prepare(`INSERT INTO proxies (name, host, port, scheme, auth, username, password, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`);

    let imported = 0;
    let skipped = 0;

    const runAll = db.transaction((rows) => {
      for (const it of rows) {
        const host = String(it.host || '').trim();
        const port = parseInt(it.port, 10);
        const user = String(it.user || it.username || '').trim();
        const pass = String(it.pass || it.password || '');
        if (!host || isNaN(port) || port < 1 || port > 65535) {
          skipped++;
          continue;
        }
        const key = `${host.toLowerCase()}|${port}|${user.toLowerCase()}`;
        if (existing.has(key)) {
          skipped++;
          continue;
        }
        const hasAuth = !!(user && pass);
        // Nome automático: host:porta (ou user@host:porta se autenticado)
        const name = (it.name && String(it.name).trim())
          || (hasAuth ? `${user}@${host}:${port}` : `${host}:${port}`);
        const scheme = it.scheme === 'https' ? 'https' : 'http';
        insert.run(name.trim(), host, port, scheme, hasAuth ? 1 : 0, user, pass);
        existing.add(key); // evita duplicata dentro do próprio lote
        imported++;
      }
    });

    runAll(items);
    return { imported, skipped, total: Array.isArray(items) ? items.length : 0 };
  }

  /** Lê apenas a senha de um proxy (uso interno em validações). */
  _passwordOf(id) {
    const row = getDb().prepare('SELECT password FROM proxies WHERE id = ?').get(id);
    return row ? row.password : '';
  }
}

module.exports = new ProxiesService();
