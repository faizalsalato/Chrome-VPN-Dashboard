/**
 * CloakLicensesService - biblioteca de chaves do CloakBrowser Pro.
 *
 * Por que existe: no modo grátis o binário aceita UMA sessão por vez; cada
 * chave Pro acrescenta sessões. Com várias instâncias CloakBrowser em paralelo
 * é preciso mais do que uma chave, e é esta biblioteca que as guarda e as
 * distribui pelas instâncias (a menos carregada primeiro).
 *
 * A chave NUNCA sai na listagem (só mascarada, como a senha dos proxies): quem
 * precisa dela por inteiro é o servidor, ao montar o container.
 */
const { getDb } = require('../database');

// Comprimento mínimo aceite: uma chave do CloakBrowser é bem maior que isto —
// o corte existe só para não guardar um engano de digitação óbvio.
const MIN_KEY_LENGTH = 8;

class CloakLicensesService {
  /** Lista as chaves (mascaradas), com o plano e quantas instâncias as usam. */
  list() {
    const db = getDb();
    const rows = db.prepare(
      'SELECT id, license_key, label, plan, expires, seats_active, seats_limit, checked_at, created_at ' +
      'FROM cloak_licenses ORDER BY id'
    ).all();

    const usage = this._usage();
    return rows.map(r => ({
      id: r.id,
      masked: this.mask(r.license_key),
      label: r.label || null,
      plan: r.plan || null,
      expires: r.expires || null,
      seatsActive: r.seats_active,
      seatsLimit: r.seats_limit,
      checkedAt: r.checked_at || null,
      createdAt: r.created_at,
      instances: usage.get(r.id) || 0
    }));
  }

  /** Quantas chaves existem (usado para saber se dá para usar a edição Pro). */
  count() {
    return getDb().prepare('SELECT COUNT(*) AS total FROM cloak_licenses').get().total;
  }

  /** Mostra só as pontas da chave: "abcd…wxyz". */
  mask(key) {
    const text = String(key || '');
    if (!text) return '';
    if (text.length <= 10) return '••••';
    return `${text.slice(0, 4)}…${text.slice(-4)}`;
  }

  /** Chave completa (uso interno: montar o container). */
  keyFor(id) {
    const row = getDb().prepare('SELECT license_key FROM cloak_licenses WHERE id = ?').get(id);
    return row ? row.license_key : null;
  }

  /**
   * Adiciona chaves. Aceita várias de uma vez (uma por linha, para colar uma
   * lista); duplicadas são ignoradas em silêncio.
   *
   * @returns {{added:number, skipped:number, total:number}}
   */
  addMany(text, label) {
    const keys = String(text || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    if (!keys.length) {
      throw Object.assign(new Error('Informe pelo menos uma chave'), { status: 400 });
    }

    const db = getDb();
    const insert = db.prepare('INSERT OR IGNORE INTO cloak_licenses (license_key, label) VALUES (?, ?)');
    let added = 0;
    let invalid = 0;

    const run = db.transaction((list) => {
      for (const key of list) {
        if (key.length < MIN_KEY_LENGTH) {
          invalid++;
          continue;
        }
        const info = insert.run(key, label || null);
        if (info.changes) added++;
      }
    });
    run(keys);

    return { added, skipped: keys.length - added, invalid, total: keys.length };
  }

  /**
   * Remove uma chave e solta as instâncias que a usavam (a atribuição é refeita
   * na próxima subida do container, com outra chave da biblioteca).
   */
  remove(id) {
    const db = getDb();
    const info = db.prepare('DELETE FROM cloak_licenses WHERE id = ?').run(id);
    if (info.changes === 0) {
      throw Object.assign(new Error('Chave não encontrada'), { status: 404 });
    }
    const freed = db.prepare('UPDATE instances SET cloak_license_id = NULL WHERE cloak_license_id = ?').run(id);
    return { removed: true, instancesFreed: freed.changes };
  }

  /**
   * Chave atribuída a uma instância.
   *
   * Mantém a que já está atribuída (a distribuição não muda sozinha entre
   * reinícios) e, quando ainda não há nenhuma, escolhe a MENOS carregada —
   * empate pelo id, para a escolha ser sempre a mesma.
   *
   * @returns {number|null} id da chave, ou null quando a biblioteca está vazia
   */
  assignFor(instanceId) {
    const db = getDb();
    const current = db.prepare('SELECT cloak_license_id FROM instances WHERE id = ?').get(instanceId);
    if (current && current.cloak_license_id && this.keyFor(current.cloak_license_id)) {
      return current.cloak_license_id;
    }

    const rows = db.prepare('SELECT id FROM cloak_licenses ORDER BY id').all();
    if (!rows.length) return null;

    const usage = this._usage();
    let best = null;
    for (const row of rows) {
      const total = usage.get(row.id) || 0;
      if (!best || total < best.total) best = { id: row.id, total };
    }
    return best.id;
  }

  /**
   * Garante uma chave para a instância E grava a atribuição na linha (quando a
   * linha já existe), para a distribuição não mudar a cada subida do container.
   *
   * @returns {number|null} id da chave, ou null quando a biblioteca está vazia
   */
  ensureAssigned(instanceId) {
    const id = this.assignFor(instanceId);
    if (!id) return null;
    getDb().prepare(
      'UPDATE instances SET cloak_license_id = ? WHERE id = ? AND (cloak_license_id IS NULL OR cloak_license_id <> ?)'
    ).run(id, instanceId, id);
    return id;
  }

  /** Grava o resultado de uma verificação (plano/prazo/sessões). */
  saveCheck(id, info) {
    const data = info || {};
    getDb().prepare(
      `UPDATE cloak_licenses
       SET plan = ?, expires = ?, seats_active = ?, seats_limit = ?, checked_at = datetime('now')
       WHERE id = ?`
    ).run(
      data.plan || null,
      data.expires || null,
      Number.isFinite(data.seatsActive) ? data.seatsActive : null,
      Number.isFinite(data.seatsLimit) ? data.seatsLimit : null,
      id
    );
    return { id, checked: true };
  }

  /** Quantas instâncias usam cada chave (id da chave → total). */
  _usage() {
    const rows = getDb().prepare(
      'SELECT cloak_license_id AS id, COUNT(*) AS total FROM instances ' +
      'WHERE cloak_license_id IS NOT NULL GROUP BY cloak_license_id'
    ).all();
    return new Map(rows.map(r => [r.id, r.total]));
  }
}

module.exports = new CloakLicensesService();
module.exports.MIN_KEY_LENGTH = MIN_KEY_LENGTH;
