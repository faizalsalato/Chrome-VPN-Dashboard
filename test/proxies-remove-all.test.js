/**
 * "Eliminar todos" da biblioteca de proxies.
 *
 * Dois pontos que importam:
 *  1. a limpeza NÃO pode levar as instâncias junto — cada instância guarda o
 *     endereço/credenciais na própria linha, e o que se solta é só a ligação à
 *     biblioteca (`proxy_id`), que é de onde o cartão tira a geo;
 *  2. tudo corre numa transação (não fica meio apagado se algo falhar).
 */
const express = require('express');
const jwt = require('jsonwebtoken');

const state = { total: 0, runs: [], dentroDeTransacao: 0 };

jest.mock('../src/database', () => ({
  getDb: () => ({
    prepare: (sql) => ({
      get: () => ({ total: state.total }),
      all: () => [],
      run: (...args) => {
        state.runs.push({ sql: String(sql).trim(), args });
        return { changes: 1 };
      }
    }),
    transaction: (fn) => () => {
      state.dentroDeTransacao += 1;
      try {
        return fn();
      } finally {
        state.dentroDeTransacao -= 1;
      }
    }
  })
}));

const proxiesService = require('../src/services/proxies.service');
const proxiesRouter = require('../src/routes/proxies.router');

describe('proxies.service — removeAll', () => {
  beforeEach(() => {
    state.total = 3;
    state.runs = [];
    state.dentroDeTransacao = 0;
  });

  it('apaga a biblioteca e solta as instâncias, numa transação', () => {
    const resultado = proxiesService.removeAll();

    expect(resultado).toEqual({ removed: 3 });

    const sqls = state.runs.map((r) => r.sql);
    expect(sqls.some((s) => /DELETE FROM proxies/i.test(s))).toBe(true);
    expect(sqls.some((s) => /UPDATE instances SET proxy_id = NULL/i.test(s))).toBe(true);

    // A transação abriu e fechou.
    expect(state.dentroDeTransacao).toBe(0);
  });

  it('biblioteca vazia devolve removed: 0', () => {
    state.total = 0;

    expect(proxiesService.removeAll()).toEqual({ removed: 0 });
  });
});

describe('DELETE /api/proxies — eliminar todos', () => {
  let server;
  let base;
  let token;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/proxies', proxiesRouter);
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    token = jwt.sign(
      { id: 1, username: 'admin' },
      process.env.JWT_SECRET || 'sakaru',
      { expiresIn: 60 }
    );
  });

  afterAll(async () => {
    const fechado = new Promise((resolve) => server.close(resolve));
    if (server.closeAllConnections) server.closeAllConnections();
    await fechado;
  });

  beforeEach(() => {
    state.total = 2;
    state.runs = [];
  });

  async function del() {
    const res = await fetch(`${base}/api/proxies`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    return { status: res.status, body: await res.json() };
  }

  it('devolve quantos proxies saíram', async () => {
    const res = await del();

    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(2);
    expect(res.body.message).toMatch(/2 proxy/);
  });

  it('biblioteca vazia responde que já estava vazia', async () => {
    state.total = 0;

    const res = await del();

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/já estava vazia/i);
  });

  it('exige autenticação (e não apaga nada sem ela)', async () => {
    const res = await fetch(`${base}/api/proxies`, { method: 'DELETE' });

    expect([401, 403]).toContain(res.status);
    expect(state.runs).toHaveLength(0);
  });
});
