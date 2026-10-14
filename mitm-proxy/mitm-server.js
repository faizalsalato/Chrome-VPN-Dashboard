/**
 * Servidor MITM HTTP/HTTPS.
 */

const http = require('http');
const https = require('https');
const { createProxyServer } = require('http-proxy');
const { rewriteHeaders, shouldSkipHost } = require('./header-utils');

class MitmServer {
  constructor(port, targetOs, ca, skipHosts) {
    this.port = port;
    this.targetOs = targetOs;
    this.ca = ca;
    this.skipHosts = skipHosts;
    this.proxy = createProxyServer({});
    this._setupProxyEvents();
  }

  _setupProxyEvents() {
    this.proxy.on('error', (err) => {
      console.error('[mitm] Proxy error:', err.message);
    });
  }

  start() {
    const server = http.createServer((req, res) => {
      this.handleHttp(req, res);
    });

    server.listen(this.port, () => {
      console.log(`[mitm] ✅ HTTP listen ${this.port}`);
    });

    return server;
  }

  handleHttp(req, res) {
    const host = req.headers.host || '';
    const skip = shouldSkipHost(host, this.skipHosts);
    if (skip) {
      return this.proxy.web(req, res, { target: `http://${host}`, changeOrigin: true });
    }

    const newHeaders = rewriteHeaders(req.headers, this.targetOs, this.skipHosts);
    if (newHeaders) {
      req.headers = newHeaders;
      console.log(`[mitm] 🔀 HTTP→${host} headers reescritos`);
    } else {
      console.log(`[mitm] ↩️  HTTP→${host} sem alteração`);
    }

    this.proxy.web(req, res, { target: `http://${host}`, changeOrigin: true });
  }

  // HTTPS com MITM
  createHttpsServer() {
    const server = https.createServer({}, (req, res) => {
      this.handleHttps(req, res);
    });

    server.listen(this.port + 1, () => {
      console.log(`[mitm] ✅ HTTPS MITM listen ${this.port + 1}`);
    });

    return server;
  }

  handleHttps(req, res) {
    const host = req.headers.host || '';
    const match = host.match(/^([^:]+)(?::(\d+))?$/);
    if (!match) {
      res.writeHead(400).end('Bad request');
      return;
    }
    const hostname = match[1].replace(/[\[\]]/g, '');
    const port = match[2] ? parseInt(match[2], 10) : 443;

    const skip = shouldSkipHost(host, this.skipHosts);
    if (skip) {
      return this.proxy.web(req, res, { target: `https://${host}`, changeOrigin: true });
    }

    this._getOrCreateCert(hostname).then(({ cert, key }) => {
      const options = { cert, key, sni: hostname };
      const secureReq = https.request({
        host: hostname,
        port,
        servername: hostname,
        secureProtocol: 'TLS_method',
      }, (remoteRes) => {
        req.headers.host = host;
        this.proxy.web(req, res, { target: `https://${hostname}:${port}`, changeOrigin: true });
      });
      req.pipe(secureReq);
      secureReq.on('error', (err) => {
        console.error('[mitm] HTTPS error:', err.message);
        res.writeHead(502).end('Bad gateway');
      });
    }).catch((err) => {
      console.error('[mitm] Cert error:', err);
      res.writeHead(500).end('Internal error');
    });
  }

  async _getOrCreateCert(hostname) {
    if (!this.ca.isReady()) {
      await this.ca.ensure();
    }
    return { cert: this.ca.certificate, key: this.ca.privateKey };
  }

  close() {
    this.server?.close();
    this.proxy?.close?.();
  }
}

module.exports = MitmServer;
