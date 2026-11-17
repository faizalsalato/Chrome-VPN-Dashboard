/**
 * Página /admin/ e sua API.
 *
 * O que estes testes protegem, em ordem de importância:
 *   1. sem token, o HTML NÃO é servido (o gate não é decorativo)
 *   2. token errado é recusado
 *   3. token certo grava cookie httpOnly e limpa a URL (o token não fica na URL)
 *   4. a API /api/admin/* recusa sem sessão e sem header
 *   5. o SPA fallback não engole /admin/
 */
const express = require('express');
const request = require('supertest');
const path = require('path');

process.env.ADMIN_PAGE_TOKEN = 'sakarutel';

const adminAuth = require('../src/middleware/admin-auth.middleware');

/** App mínimo que reproduz o gate do server.js sem subir Docker nem banco. */
function buildApp() {
  const app = express();
  app.use(express.json());

  const ADMIN_HTML = path.join(__dirname, '..', 'src', 'admin', 'index.html');
  const fs = require('fs');

  app.get('/admin', (req, res, next) => {
    if (req.path !== '/admin') return next();
    const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    res.redirect(301, '/admin/' + qs);
  });

  app.get('/admin/', (req, res) => {
    const token = req.query.token;

    if (token !== undefined) {
      if (!adminAuth.tokenMatches(token)) {
        return res.status(401).type('html').send('<h1>Token inválido</h1>');
      }
      res.cookie(adminAuth.COOKIE_NAME, adminAuth.cookieValue(), {
        httpOnly: true,
        sameSite: 'strict',
        maxAge: adminAuth.COOKIE_MAX_AGE * 1000,
        path: '/'
      });
      return res.redirect(302, '/admin/');
    }

    if (!adminAuth.hasSession(req)) {
      return res.status(401).type('html').send('<h1>Acesso restrito</h1>');
    }

    fs.readFile(ADMIN_HTML, 'utf-8', (err, html) => {
      if (err) return res.status(500).send('erro');
      res.type('html').send(html);
    });
  });

  // Rota de API protegida, para provar o middleware.
  app.get('/api/admin/ping', adminAuth.requireAdmin, (req, res) => res.json({ ok: true }));

  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api/') && !req.path.startsWith('/admin')) {
      res.type('html').send('<h1>dashboard</h1>');
    } else {
      res.status(404).send('not found');
    }
  });

  return app;
}

describe('página /admin/ — gate do token', () => {
  let app;
  beforeEach(() => { app = buildApp(); });

  it('sem token e sem sessão: 401, e o HTML da página NÃO é servido', async () => {
    const res = await request(app).get('/admin/');
    expect(res.status).toBe(401);
    expect(res.text).not.toContain('Administração');
    expect(res.text).toContain('Acesso restrito');
  });

  it('token errado: 401', async () => {
    const res = await request(app).get('/admin/?token=errado');
    expect(res.status).toBe(401);
    expect(res.text).toContain('Token inválido');
  });

  it('token certo: grava cookie httpOnly e redireciona para /admin/ limpo', async () => {
    const res = await request(app).get('/admin/?token=sakarutel');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin/');

    const cookies = res.headers['set-cookie'] || [];
    const session = cookies.find((c) => c.startsWith('admin_page='));
    expect(session).toBeDefined();
    expect(session).toContain('HttpOnly');
    expect(session).toContain('SameSite=Strict');
    // O cookie não pode conter o token em claro.
    expect(session).not.toContain('sakarutel');
  });

  it('com o cookie de sessão: serve o HTML da página', async () => {
    const login = await request(app).get('/admin/?token=sakarutel');
    const session = (login.headers['set-cookie'] || [])
      .find((c) => c.startsWith('admin_page='))
      .split(';')[0];

    const res = await request(app).get('/admin/').set('Cookie', session);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Administração');
    expect(res.text).toContain('/api/admin/state');
  });

  it('/admin sem barra final redireciona preservando o token', async () => {
    const res = await request(app).get('/admin?token=sakarutel');
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('/admin/?token=sakarutel');
  });

  it('o SPA fallback não engole /admin/', async () => {
    const res = await request(app).get('/admin/');
    expect(res.text).not.toContain('dashboard');
  });
});

describe('API /api/admin — autenticação', () => {
  let app;
  beforeEach(() => { app = buildApp(); });

  it('sem credencial: 401', async () => {
    const res = await request(app).get('/api/admin/ping');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('header X-Admin-Token correto: passa', async () => {
    const res = await request(app).get('/api/admin/ping').set('X-Admin-Token', 'sakarutel');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('header X-Admin-Token errado: 401', async () => {
    const res = await request(app).get('/api/admin/ping').set('X-Admin-Token', 'nope');
    expect(res.status).toBe(401);
  });

  it('cookie de sessão válido: passa', async () => {
    const login = await request(app).get('/admin/?token=sakarutel');
    const session = (login.headers['set-cookie'] || [])
      .find((c) => c.startsWith('admin_page='))
      .split(';')[0];

    const res = await request(app).get('/api/admin/ping').set('Cookie', session);
    expect(res.status).toBe(200);
  });

  it('cookie forjado: 401', async () => {
    const res = await request(app).get('/api/admin/ping').set('Cookie', 'admin_page=deadbeef');
    expect(res.status).toBe(401);
  });
});

describe('admin-auth.middleware — unidade', () => {
  it('tokenMatches aceita só o token exato', () => {
    expect(adminAuth.tokenMatches('sakarutel')).toBe(true);
    expect(adminAuth.tokenMatches('sakarute')).toBe(false);
    expect(adminAuth.tokenMatches('sakarutel ')).toBe(false);
    expect(adminAuth.tokenMatches('')).toBe(false);
    expect(adminAuth.tokenMatches(null)).toBe(false);
  });

  it('o valor do cookie é HMAC, não o token', () => {
    const v = adminAuth.cookieValue();
    expect(v).not.toContain('sakarutel');
    expect(v).toMatch(/^[0-9a-f]{64}$/);
  });

  it('readCookie lê o valor certo entre vários cookies', () => {
    const req = { headers: { cookie: 'a=1; admin_page=xyz; b=2' } };
    expect(adminAuth.readCookie(req, 'admin_page')).toBe('xyz');
    expect(adminAuth.readCookie(req, 'naoexiste')).toBe(null);
    expect(adminAuth.readCookie({ headers: {} }, 'admin_page')).toBe(null);
  });
});
