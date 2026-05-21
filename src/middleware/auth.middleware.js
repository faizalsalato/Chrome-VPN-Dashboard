const authService = require('../services/auth.service');

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Token de autenticação não fornecido'
    });
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Formato de token inválido'
    });
  }

  const token = parts[1];
  const user = authService.verifyToken(token);

  if (!user) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Token inválido ou expirado'
    });
  }

  req.user = user;
  next();
}

module.exports = authMiddleware;
