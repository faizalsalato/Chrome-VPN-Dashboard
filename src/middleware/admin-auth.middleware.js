const crypto = require('crypto');

/**
 * Autenticação da página /admin/ por token compartilhado.
 *
 * O token vem em `?token=sakarutel`. Três decisões que valem explicação:
 *
 * 1. O token NÃO fica na URL depois do primeiro acesso. Ele é trocado por um
 *    cookie httpOnly e o browser é redirecionado para /admin/ limpo. Token em
 *    URL vaza por histórico, Referer e log de proxy — e este token dá acesso a
 *    start/stop/delete de instância.
 *
 * 2. O cookie não guarda o token: guarda um HMAC dele. Se o cookie vazar, não
 *    entrega o segredo.
 *
 * 3. A comparação é timing-safe. Comparar strings com `===` vaza o tamanho do
 *    prefixo correto pelo tempo de resposta.
 */

const TOKEN = process.env.ADMIN_PAGE_TOKEN || 'sakarutel';
const COOKIE_NAME = 'admin_page';
const COOKIE_MAX_AGE = 12 * 60 * 60; // 12h

/** Valor do cookie: HMAC do token. Constante para um dado token. */
function cookieValue() {
  return crypto.createHmac('sha256', TOKEN).update('admin-page-v1').digest('hex');
}

/** Comparação timing-safe entre dois segredos. */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** O token informado confere? */
function tokenMatches(candidate) {
  if (!candidate) return false;
  return safeEqual(candidate, TOKEN);
}

/** Lê um cookie do cabeçalho sem depender de cookie-parser. */
function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) {
      return decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  return null;
}

/** A requisição já tem sessão de admin válida? */
function hasSession(req) {
  const cookie = readCookie(req, COOKIE_NAME);
  if (!cookie) return false;
  return safeEqual(cookie, cookieValue());
}

/**
 * Middleware das rotas /api/admin/*.
 * Aceita o cookie de sessão ou o token cru no cabeçalho `X-Admin-Token`.
 */
function requireAdmin(req, res, next) {
  if (hasSession(req)) return next();

  const header = req.headers['x-admin-token'];
  if (tokenMatches(header)) return next();

  return res.status(401).json({
    error: 'Unauthorized',
    message: 'Token de administração ausente ou inválido'
  });
}

module.exports = {
  TOKEN,
  COOKIE_NAME,
  COOKIE_MAX_AGE,
  cookieValue,
  tokenMatches,
  hasSession,
  readCookie,
  requireAdmin
};
