/**
 * MITM Header Proxy - Ponto de entrada principal.
 *
 * Configurações via variáveis de ambiente:
 *   PROXY_PORT       Porta HTTP (padrão: 8888)
 *   PROXY_OS         Sistema "falso": windows | macos | linux | android | ios (padrão: windows)
 *   PROXY_SKIP       Host(s) para não modificar (padrão: "")
 *   PROXY_LOG        Nível de log: silent | info | debug (padrão: info)
 *
 * Arquivo de configuração opcional: headers.json (sobrescreve os padrões)
 */

const path = require('path');
const CAManager = require('./ca-manager');
const MitmServer = require('./mitm-server');

const CONFIG = {
  listenPort: Number(process.env.PROXY_PORT || 8888),
  targetOs: process.env.PROXY_OS || 'windows',
  skipHosts: (process.env.PROXY_SKIP || '').split(',').filter(Boolean),
  logLevel: process.env.PROXY_LOG || 'info',
  ca: {
    certPath: path.join(__dirname, 'ca', 'ca_cert.pem'),
    keyPath: path.join(__dirname, 'ca', 'ca_key.pem'),
    subject: '/C=US/ST=California/L=San Francisco/O=MitmProxy/CN=*.localhost',
  },
};

async function main() {
  console.log('[mitm] 🚀 Iniciando MITM Header Proxy...');
  console.log(`[mitm] Porta: ${CONFIG.listenPort}`);
  console.log(`[mitm] OS alvo: ${CONFIG.targetOs}`);

  const ca = new CAManager(CONFIG.ca.certPath, CONFIG.ca.keyPath, CONFIG.ca.subject);
  if (!ca.isReady()) {
    console.log('[mitm] ⚠️  Gerando CA privada (apenas primeira vez)...');
    await ca.generate();
    console.log('[mitm] ✅ CA gerada.');
  } else {
    console.log('[mitm] ✅ CA pronta.');
  }

  const mitm = new MitmServer(CONFIG.listenPort, CONFIG.targetOs, ca, CONFIG.skipHosts);
  mitm.start();
  mitm.createHttpsServer();

  process.on('SIGTERM', () => {
    console.log('[mitm] 🛑 Encerrando...');
    mitm.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[mitm] ❌ Erro:', err);
  process.exit(1);
});
