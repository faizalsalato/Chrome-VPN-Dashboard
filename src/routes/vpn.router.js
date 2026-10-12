const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const vpnCredentials = require('../services/vpn-credentials.service');

// All VPN routes require authentication
router.use(authMiddleware);

// GET /api/vpn-credentials - Lista providers (surfshark/expressvpn) com status
router.get('/', async (req, res, next) => {
  try {
    res.json({ providers: vpnCredentials.list() });
  } catch (err) {
    next(err);
  }
});

// PUT /api/vpn-credentials/:provider - Salva credenciais de um provider
router.put('/:provider', async (req, res, next) => {
  try {
    const provider = req.params.provider;
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'Usuário e senha são obrigatórios'
      });
    }
    const result = vpnCredentials.save(provider, username, password);
    res.json({ message: `Credenciais do ${provider} salvas com sucesso`, ...result });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({
        error: 'SaveError',
        message: err.message
      });
    }
    next(err);
  }
});

module.exports = router;
