const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { initDatabase } = require('./database');
const authRouter = require('./routes/auth.router');
const instancesRouter = require('./routes/instances.router');
const vpnRouter = require('./routes/vpn.router');
const proxiesRouter = require('./routes/proxies.router');
const cloakLicensesRouter = require('./routes/cloak-licenses.router');
const proxyInjector = require('./services/proxy-injector.service');
const instanceService = require('./services/instance.service');

const app = express();
const PORT = process.env.PORT || 3100;
// Atrás do nginx (reverse proxy): confia no loopback para X-Forwarded-For/req.ip.
app.set('trust proxy', 'loopback');

// Middleware
app.use(cors());
// O envio de ficheiros para o perfil NÃO passa por aqui: ele vai cru
// (`application/octet-stream`) e é lido em streaming pela rota, sem teto. Este
// limite só vale para o corpo JSON — inclusive o contrato antigo de upload, que
// manda o ficheiro em base64 (33% maior) dentro do JSON. Fica folgado para uma
// página antiga em cache ainda conseguir enviar; o caminho novo não depende dele.
app.use(express.json({ limit: '64mb' }));

// Carimbo nas URLs dos assets (JS/CSS) do HTML. Sem isto o browser pode
// continuar a usar o ficheiro antigo depois de um deploy e o usuário jura que a
// mudança não chegou (foi o que aconteceu com a lista de países). O carimbo
// muda a cada arranque do dashboard — que é quando o código novo entra em vigor.
const ASSET_VERSION = Date.now().toString(36);
const INDEX_HTML = path.join(__dirname, '..', 'public', 'index.html');

function withAssetVersion(html) {
  return html.replace(/(src|href)="\/(js|css)\/([^"]+)"/g, `$1="/$2/$3?v=${ASSET_VERSION}"`);
}

// O index.html passa por aqui (antes do estático) para levar o carimbo.
app.get('/', (req, res, next) => {
  fs.readFile(INDEX_HTML, 'utf-8', (err, html) => {
    if (err) return next(err);
    res.type('html').send(withAssetVersion(html));
  });
});

app.use(express.static(path.join(__dirname, '..', 'public')));

// Routes
app.use('/api/auth', authRouter);
app.use('/api/instances', instancesRouter);
app.use('/api/vpn-credentials', vpnRouter);
app.use('/api/proxies', proxiesRouter);
app.use('/api/cloak-licenses', cloakLicensesRouter);

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

// Reativa os forwarders de proxy autenticado persistidos no banco.
// Containers podem ter subido via RestartPolicy, mas o forwarder vive neste processo.
proxyInjector.restore().catch((err) => {
  console.error(`[${new Date().toISOString()}] [ERROR] Falha ao restaurar forwarders de proxy:`, err.message);
});

const HOST = process.env.HOST || '0.0.0.0';
const server = app.listen(PORT, HOST, () => {
  console.log(`[${new Date().toISOString()}] [INFO] Dashboard rodando em ${HOST}:${PORT}`);
  console.log(`[${new Date().toISOString()}] [INFO] Domain: ${process.env.DOMAIN || 'sakr.ath.cx'}`);
});

// Vigia a saída das instâncias em execução: a VPN pode reconectar sozinha
// noutra cidade, e o perfil precisa acompanhar o IP (sem recriar o navegador).
instanceService.startExitWatcher();

// Graceful shutdown
async function shutdown(signal) {
  console.log(`[${new Date().toISOString()}] [INFO] ${signal} recebido. Encerrando...`);
  instanceService.stopExitWatcher();
  server.close(async () => {
    try {
      await proxyInjector.stopAll();
    } catch (_) {
      // ignora erro de limpeza durante encerramento
    }
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
