const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const proxiesService = require('../services/proxies.service');

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

module.exports = router;
