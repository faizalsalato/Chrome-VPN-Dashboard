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
const adminRouter = require('./routes/admin.router');
const adminAuth = require('./middleware/admin-auth.middleware');
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

// --- Página de administração ------------------------------------------------
//
// Fica em src/admin/ (fora de public/) de propósito: o express.static não a
// alcança, então o HTML nunca é servido sem passar pelo gate do token.
//
// Fluxo: /admin/?token=sakarutel -> valida -> grava cookie httpOnly -> redireciona
// para /admin/ limpo. O token sai da URL no primeiro acesso (não fica em
// histórico, Referer nem log de proxy).
const ADMIN_HTML = path.join(__dirname, 'admin', 'index.html');

// O Express, por padrão, trata "/admin/" como igual a "/admin". Sem esta
// checagem, a rota de redirect abaixo captura "/admin/" também e a página entra
// em laço. Aqui: só redireciona quando o caminho é EXATAMENTE "/admin".
app.get('/admin', (req, res, next) => {
  if (req.path !== '/admin') return next();
  const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  res.redirect(301, '/admin/' + qs);
});

app.get('/admin/', (req, res, next) => {
  const token = req.query.token;

  if (token !== undefined) {
    if (!adminAuth.tokenMatches(token)) {
      return res.status(401).type('html').send(
        '<!DOCTYPE html><meta charset="utf-8"><title>401</title>' +
        '<div style="font:15px system-ui;max-width:460px;margin:80px auto;color:#e6edf3;background:#0d1117;padding:0">' +
        '<h1 style="font-size:18px">Token inválido</h1>' +
        '<p style="color:#8b949e">A página de administração exige o token correto na URL.</p></div>'
      );
    }

    // Token válido: grava a sessão e limpa a URL.
    res.cookie(adminAuth.COOKIE_NAME, adminAuth.cookieValue(), {
      httpOnly: true,
      sameSite: 'strict',
      secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
      maxAge: adminAuth.COOKIE_MAX_AGE * 1000,
      path: '/'
    });
    return res.redirect(302, '/admin/');
  }

  if (!adminAuth.hasSession(req)) {
    return res.status(401).type('html').send(
      '<!DOCTYPE html><meta charset="utf-8"><title>401</title>' +
      '<div style="font:15px system-ui;max-width:460px;margin:80px auto;color:#e6edf3;background:#0d1117;padding:0">' +
      '<h1 style="font-size:18px">Acesso restrito</h1>' +
      '<p style="color:#8b949e">Abra esta página com <code>?token=…</code> na URL.</p></div>'
    );
  }

  fs.readFile(ADMIN_HTML, 'utf-8', (err, html) => {
    if (err) return next(err);
    res.type('html').send(html);
  });
});

// API da página de administração (autenticação própria por token).
app.use('/api/admin', adminRouter);

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
// /admin/ tem rota própria acima: o fallback não pode engoli-la.
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/') && !req.path.startsWith('/admin')) {
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
