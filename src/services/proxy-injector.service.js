const net = require('net');

// Porta base dos forwarders locais. Cada instância autenticada usa BASE_PORT + id.
const BASE_PORT = parseInt(process.env.PROXY_INJECTOR_BASE_PORT || '8100', 10);

/**
 * ProxyInjectorService
 *
 * Motivo: o Chromium moderno (>= 137, ex. 154) removeu o suporte a extensões
 * Manifest V2 carregadas via --load-extension responderem ao desafio 407
 * (Proxy-Authorization). Para autenticar em um proxy upstream de forma à prova
 * de versão, subimos um forwarder TCP local SEM autenticação que:
 *   1. escuta em 0.0.0.0:<BASE_PORT+id> (alcançável pelo container via
 *      host.docker.internal);
 *   2. intercepta a primeira requisição do cliente (CONNECT ou absolute-URI);
 *   3. injeta o cabeçalho `Proxy-Authorization: Basic base64(user:pass)`;
 *   4. encaminha o fluxo ao proxy upstream real.
 *
 * O Chrome aponta apenas para `http://host.docker.internal:<porta>` e "acha"
 * que o proxy local não exige autenticação.
 */
class ProxyInjectorService {
  constructor() {
    // id -> { server, upstream }
    this.forwarders = new Map();
  }

  /** Porta determinística do forwarder de uma instância. */
  getPort(id) {
    return BASE_PORT + parseInt(id, 10);
  }

  isRunning(id) {
    return this.forwarders.has(id);
  }

  /**
   * Inicia (ou reinicia) o forwarder de uma instância.
   * @param {number} id
   * @param {object} upstream { host, port, user, pass, scheme }
   * @returns {Promise<number>} porta em que o forwarder escuta
   */
  async start(id, upstream) {
    // Já rodando: derruba antes de resubir (recarrega credenciais se mudaram).
    if (this.forwarders.has(id)) {
      await this.stop(id);
    }

    const port = this.getPort(id);
    const server = await this._createForwarder(port, upstream);
    this.forwarders.set(id, { server, upstream });
    console.log(
      `[INFO] [proxy-injector] Forwarder da instância ${id} ativo em 0.0.0.0:${port} -> ${upstream.host}:${upstream.port}`
    );
    return port;
  }

  /**
   * Para o forwarder de uma instância (idempotente).
   */
  async stop(id) {
    const entry = this.forwarders.get(id);
    if (!entry) return;
    this.forwarders.delete(id);

    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      try {
        entry.server.close(() => finish());
      } catch (_) {
        finish();
      }
      // Segurança: não travar indefinidamente se houver socket pendente.
      setTimeout(finish, 3000);
    });
  }

  async stopAll() {
    const ids = Array.from(this.forwarders.keys());
    for (const id of ids) {
      await this.stop(id);
    }
  }

  /**
   * No boot do dashboard, reativa os forwarders das instâncias proxy
   * autenticadas persistidas no banco (containers podem subir sozinhos pelo
   * RestartPolicy, mas o forwarder vive no processo do dashboard).
   */
  async restore() {
    let getDb;
    try {
      ({ getDb } = require('../database'));
    } catch (_) {
      return;
    }
    try {
      const db = getDb();
      const rows = db.prepare(
        "SELECT id, proxy_host, proxy_port, proxy_user, proxy_pass, proxy_scheme " +
        "FROM instances WHERE type = 'proxy' AND proxy_auth = 1"
      ).all();
      for (const r of rows) {
        try {
          await this.start(r.id, {
            host: r.proxy_host,
            port: r.proxy_port,
            user: r.proxy_user,
            pass: r.proxy_pass,
            scheme: r.proxy_scheme || 'http'
          });
        } catch (err) {
          console.error(`[ERROR] [proxy-injector] Falha ao restaurar forwarder ${r.id}:`, err.message);
        }
      }
      if (rows.length) {
        console.log(`[INFO] [proxy-injector] ${rows.length} forwarder(s) restaurado(s)`);
      }
    } catch (err) {
      // Banco pode não estar pronto ainda; ignora.
    }
  }

  /**
   * Cria o servidor TCP forwarder. A mágica acontece no primeiro chunk:
   * injeta Proxy-Authorization antes de falar com o upstream.
   */
  _createForwarder(listenPort, upstream) {
    const authHeader =
      'Basic ' + Buffer.from(`${upstream.user}:${upstream.pass}`).toString('base64');

    const injectAuth = (head) => {
      const nl = head.indexOf('\r\n');
      if (nl === -1) return head;
      const requestLine = head.slice(0, nl);
      const rest = head.slice(nl).replace(/\r\nProxy-Authorization:[^\r\n]*/ig, '');
      return requestLine + `\r\nProxy-Authorization: ${authHeader}` + rest;
    };

    const server = net.createServer((client) => {
      let upstreamSock = null;
      let first = true;

      client.on('error', () => { if (upstreamSock) upstreamSock.destroy(); });

      client.on('data', (buf) => {
        // Depois do primeiro chunk, apenas repassa bytes (túnel transparente).
        if (!first) {
          if (upstreamSock && !upstreamSock.destroyed) upstreamSock.write(buf);
          return;
        }
        first = false;

        // Trabalha em latin1 para preservar bytes crus do proxy handshake.
        const s = buf.toString('latin1');
        const sep = s.indexOf('\r\n\r\n');
        const modified = Buffer.from(
          injectAuth(sep === -1 ? s : s.slice(0, sep)) + (sep === -1 ? '' : s.slice(sep)),
          'latin1'
        );

        upstreamSock = net.createConnection(
          { host: upstream.host, port: parseInt(upstream.port, 10) },
          () => upstreamSock.write(modified)
        );
        upstreamSock.on('data', (d) => { if (!client.destroyed) client.write(d); });
        upstreamSock.on('end', () => { try { client.end(); } catch (_) { /* ignore */ } });
        upstreamSock.on('error', () => client.destroy());
      });

      client.on('end', () => { if (upstreamSock && !upstreamSock.destroyed) upstreamSock.end(); });
    });

    return new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(listenPort, '0.0.0.0', () => resolve(server));
    });
  }
}

module.exports = new ProxyInjectorService();
