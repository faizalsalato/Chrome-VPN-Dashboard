const express = require('express');
const router = express.Router();
const authService = require('../services/auth.service');
const authMiddleware = require('../middleware/auth.middleware');

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const origin = req.ip || req.connection.remoteAddress || 'unknown';

  // Validate input
  if (!username || !password) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'Nome de usuário e senha são obrigatórios'
    });
  }

  if (username.length > 64) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'Nome de usuário deve ter no máximo 64 caracteres'
    });
  }

  if (password.length > 128) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'Senha deve ter no máximo 128 caracteres'
    });
  }

  // Check rate limit
  if (authService.isRateLimited(origin)) {
    const remaining = authService.getRateLimitRemainingTime(origin);
    return res.status(429).json({
      error: 'TooManyRequests',
      message: 'Muitas tentativas de login. Tente novamente mais tarde.',
      retryAfter: remaining
    });
  }

  // Authenticate
  const token = authService.login(username, password);

  if (!token) {
    authService.recordFailedAttempt(origin);
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Credenciais inválidas'
    });
  }

  // Success - clear failed attempts
  authService.clearFailedAttempts(origin);

  const expiresIn = parseInt(process.env.SESSION_EXPIRY || '86400', 10);
  res.json({
    token,
    expiresIn
  });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  // JWT is stateless - client removes token
  res.json({ message: 'Sessão encerrada' });
});

// GET /api/auth/verify
router.get('/verify', authMiddleware, (req, res) => {
  res.json({
    valid: true,
    user: {
      id: req.user.id,
      username: req.user.username
    }
  });
});

module.exports = router;
