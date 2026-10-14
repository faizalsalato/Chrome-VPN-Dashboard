const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const proxiesService = require('../services/proxies.service');
const proxyTester = require('../services/proxy-tester.service');

// All proxy routes require authentication
router.use(authMiddleware);

/**
 * Faz o parse de uma lista de proxies em texto (uma por linha).
 * Formatos aceitos (o que não bater é ignorado):
 *   host:porta:usuario:senha      (Bright Data)
 *   host:porta:usuario:senha      com esquema http:// ou https:// no início
 *   user:pass@host:porta          (formato URL com credenciais)
 *   host:porta                    (sem autenticação)
 *   ip:porta:user:pass
 * Linhas em branco e com # são ignoradas.
 */
function parseProxyList(text) {
  const out = [];
  const lines = String(text || '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    // Remove esquema opcional no início (http:// ou https://)
    let scheme = 'http';
    let rest = line;
    const schemeMatch = rest.match(/^(https?):\/\//i);
    if (schemeMatch) {
      scheme = schemeMatch[1].toLowerCase();
      rest = rest.slice(schemeMatch[0].length);
    }

    // Formato user:pass@host:porta
    const atMatch = rest.match(/^([^:@]+):([^@]*)@(.+)$/);
    if (atMatch) {
      const [, user, pass, hostport] = atMatch;
      const hp = parseHostPort(hostport);
      if (hp) out.push({ host: hp.host, port: hp.port, user: decodeURIComponent(user), pass: decodeURIComponent(pass), scheme });
      continue;
    }

    // Formato host:porta:user:pass  ( Bright Data: host:port:user:pass )
    const parts = rest.split(':');
    if (parts.length >= 4) {
      // Cuidado: a senha pode conter ':' — juntamos o resto como senha.
      const host = parts[0];
      const port = parts[1];
      const user = parts[2];
      const pass = parts.slice(3).join(':');
      if (isValidPort(port)) {
        out.push({ host, port, user, pass, scheme });
        continue;
      }
    }

    // Formato host:porta (sem auth)
    const hp = parseHostPort(rest);
    if (hp) out.push({ host: hp.host, port: hp.port, user: '', pass: '', scheme });
  }
  return out;
}

function parseHostPort(str) {
  const m = String(str).match(/^(\[[^\]]+\]|[^:]+):(\d+)$/);
  if (!m) return null;
  if (!isValidPort(m[2])) return null;
  return { host: m[1], port: m[2] };
}

function isValidPort(p) {
  const n = parseInt(p, 10);
  return !isNaN(n) && n >= 1 && n <= 65535;
}

// GET /api/proxies - Lista a biblioteca de proxies salvos
router.get('/', async (req, res, next) => {
  try {
    res.json({ proxies: proxiesService.list() });
  } catch (err) {
    next(err);
  }
});

// POST /api/proxies - Cria um novo proxy
router.post('/', async (req, res, next) => {
  try {
    const { name, host, port, scheme, auth, username, password } = req.body || {};
    const result = proxiesService.save({ name, host, port, scheme, auth, username, password });
    res.status(201).json({ message: 'Proxy salvo com sucesso', ...result });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: 'ValidationError', message: err.message });
    }
    next(err);
  }
});

// PUT /api/proxies/:id - Atualiza um proxy
router.put('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'ValidationError', message: 'ID inválido' });
    }
    const { name, host, port, scheme, auth, username, password } = req.body || {};
    const result = proxiesService.save({ id, name, host, port, scheme, auth, username, password });
    res.json({ message: 'Proxy atualizado com sucesso', ...result });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: 'ValidationError', message: err.message });
    }
    next(err);
  }
});

// DELETE /api/proxies/:id - Remove um proxy
router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'ValidationError', message: 'ID inválido' });
    }
    proxiesService.remove(id);
    res.json({ message: 'Proxy removido com sucesso' });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: 'NotFound', message: err.message });
    }
    next(err);
  }
});

// POST /api/proxies/bulk - Importa uma lista de proxies de uma vez.
// Aceita { list: "host:porta:user:pass\\nhost:porta:user:pass\\n..." } ou { items: [...] }.
router.post('/bulk', async (req, res, next) => {
  try {
    const body = req.body || {};
    const items = body.items
      ? body.items
      : parseProxyList(body.list || '');
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'Nenhum proxy válido encontrado na lista'
      });
    }
    const result = proxiesService.bulkImport(items);
    res.json({ message: `Importados ${result.imported} de ${result.total}`, ...result });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: 'ValidationError', message: err.message });
    }
    next(err);
  }
});

// GET /api/proxies/:id/full - Retorna o proxy completo (com senha) para uso na criação
router.get('/:id/full', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'ValidationError', message: 'ID inválido' });
    }
    res.json(proxiesService.getWithSecrets(id));
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: 'NotFound', message: err.message });
    }
    next(err);
  }
});

// POST /api/proxies/test - Testa um proxy informado no corpo (formulário)
router.post('/test', async (req, res, next) => {
  try {
    const { host, port, scheme, auth, username, password } = req.body || {};
    if (!host || !port) {
      return res.status(400).json({ error: 'ValidationError', message: 'Host e porta são obrigatórios' });
    }
    const result = await proxyTester.test({ host, port, scheme, user: username, pass: password });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/proxies/:id/test - Testa um proxy já salvo (busca credenciais no banco).
// Quando o teste responde, a geo do IP de saída fica guardada no proxy: é ela que
// a tela de criação de instância mostra (o país), sem precisar testar de novo.
router.post('/:id/test', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'ValidationError', message: 'ID inválido' });
    }
    const proxy = proxiesService.getWithSecrets(id);
    const result = await proxyTester.test({
      host: proxy.host, port: proxy.port, scheme: proxy.scheme,
      user: proxy.user, pass: proxy.pass
    });
    proxiesService.saveGeo(id, result);
    res.json(result);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: 'NotFound', message: err.message });
    }
    next(err);
  }
});

module.exports = router;
