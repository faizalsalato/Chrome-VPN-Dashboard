const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDatabase } = require('./database');
const authRouter = require('./routes/auth.router');
const instancesRouter = require('./routes/instances.router');

const app = express();
const PORT = process.env.PORT || 3100;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Routes
app.use('/api/auth', authRouter);
app.use('/api/instances', instancesRouter);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// SPA fallback - serve index.html for non-API routes
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/')) {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] [ERROR] ${err.message}`, err.stack);
  const status = err.status || 500;
  res.status(status).json({
    error: err.name || 'InternalError',
    message: err.message || 'Erro interno do servidor',
    details: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

// Initialize database and start server
initDatabase();

const server = app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] [INFO] Dashboard rodando na porta ${PORT}`);
  console.log(`[${new Date().toISOString()}] [INFO] Domain: ${process.env.DOMAIN || 'sakr.ath.cx'}`);
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`[${new Date().toISOString()}] [INFO] ${signal} recebido. Encerrando...`);
  server.close(() => {
    console.log(`[${new Date().toISOString()}] [INFO] Servidor encerrado.`);
    process.exit(0);
  });
  setTimeout(() => {
    console.error('[WARN] Forçando encerramento após timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
