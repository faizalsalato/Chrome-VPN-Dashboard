const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const proxiesService = require('../services/proxies.service');
const proxyTester = require('../services/proxy-tester.service');

// All proxy routes require authentication
router.use(authMiddleware);

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

// POST /api/proxies/:id/test - Testa um proxy já salvo (busca credenciais no banco)
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
    res.json(result);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: 'NotFound', message: err.message });
    }
    next(err);
  }
});

module.exports = router;
