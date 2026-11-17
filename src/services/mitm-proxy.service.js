/**
 * MitmProxyService
 *
 * Proxy local que termina o TLS do lado do Chrome e reescreve os cabeçalhos de
 * identidade (`User-Agent`, `Sec-CH-UA*`) antes de re-encriptar para o destino.
 *
 * Por que existe: a extensão de fingerprint conserta o que o JavaScript vê, mas
 * os cabeçalhos saem do binário Linux. Sem isto, o servidor de destino recebe
 * `X11; Linux x86_64` enquanto a página se declara macOS — a divergência que
 * qualquer detector de anti-bot encontra em dois requests.
 *
 * Como o Chrome confia no certificado: `--ignore-certificate-errors-spki-list`
 * com o pin SPKI do nosso certificado. Não instalamos CA no container (a imagem
 * não tem `certutil`) e não afrouxamos a verificação de TLS: o Chrome aceita
 * exatamente os certificados cujo SPKI estiver na lista, e mais nada.
 *
 * Fluxo de uma conexão:
 *   Chrome --CONNECT--> [nós] --200--> Chrome faz TLS com o nosso certificado
 *   --> lemos a requisição em claro --> reescrevemos os cabeçalhos
 *   --> abrimos TLS de verdade até o destino (via proxy upstream, se houver)
 *   --> devolvemos a resposta.
 *
 * É um MITM de verdade: o tráfego do perfil passa em claro por este processo.
 * Só faz sentido porque o processo é do dono do perfil e roda na mesma máquina.
 */
const http = require('http');
const net = require('net');
const tls = require('tls');

const mitmCa = require('./mitm-ca.service');
const httpHeaders = require('./http-headers.service');

// Porta base própria: não colide com os forwarders de autenticação (8100+).
const BASE_PORT = parseInt(process.env.MITM_BASE_PORT || '8300', 10);
// Portas que valem MITM. Fora destas, o túnel é cego (só repassa bytes).
const MITM_PORTS = new Set([443, 8443, 9443]);
// Cabeçalhos que não podem ser repassados como vieram.
const HOP_BY_HOP = new Set([
  'connection', 'proxy-connection', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'
]);

class MitmProxyService {
  constructor() {
    // id -> { server, upstream, fingerprint, contexts: Map }
    this.proxies = new Map();
  }

  /** Porta determinística do MITM de uma instância. */
  getPort(id) {
    return BASE_PORT + parseInt(id, 10);
  }

  isRunning(id) {
    return this.proxies.has(id);
  }

  /**
   * Sobe (ou reinicia) o MITM de uma instância.
   *
   * @param {number} id
   * @param {object} upstream { host, port, user, pass, scheme } — proxy de saída
   * @param {object} fingerprint fingerprint do perfil (contrato do content.js)
   * @returns {Promise<number>} porta em que escuta
   */
  async start(id, upstream, fingerprint) {
    if (this.proxies.has(id)) await this.stop(id);

    const headers = httpHeaders.headersFor(fingerprint);
    if (!headers) {
      // Sem UA no perfil não há o que reescrever: subir o MITM só adicionaria
      // um ponto de falha. Quem chamou deve usar o forwarder simples.
      throw new Error('fingerprint sem userAgent: nada a reescrever');
    }

    const port = this.getPort(id);
    const entry = {
      upstream: upstream || null,
      headers,
      contexts: new Map(),
      server: null
    };
    entry.server = await this._createServer(port, entry);
    this.proxies.set(id, entry);
    console.log(
      `[INFO] [mitm] MITM da instância ${id} ativo em 0.0.0.0:${port}` +
      (upstream ? ` -> ${upstream.host}:${upstream.port}` : ' -> direto')
    );
    return port;
  }

  /** Para o MITM de uma instância (idempotente). */
  async stop(id) {
    const entry = this.proxies.get(id);
    if (!entry) return;
    this.proxies.delete(id);
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      try {
        entry.server.close(() => finish());
      } catch (_) {
        finish();
      }
      setTimeout(finish, 3000);
    });
  }

  async stopAll() {
    for (const id of Array.from(this.proxies.keys())) {
      await this.stop(id);
    }
  }

  /** Pin SPKI do certificado que o Chrome vai ver para um host. */
  pinFor(host) {
    return mitmCa.certificateFor(host).pin;
  }

  /** Lista de pins de todos os hosts já emitidos (para o CHROME_CLI). */
  pinsFor(hosts) {
    const list = [];
    for (const host of hosts || []) {
      try {
        list.push(this.pinFor(host));
      } catch (_) { /* host inválido: ignora */ }
    }
    return list;
  }

  /**
   * Cria o servidor. Ele atende dois tipos de entrada:
   *  - CONNECT (HTTPS): termina TLS e trata como HTTP;
   *  - requisição absoluta (HTTP simples): reescreve e repassa.
   */
  _createServer(port, entry) {
    const server = http.createServer((req, res) => {
      this._handlePlain(req, res, entry);
    });

    server.on('connect', (req, clientSocket, head) => {
      this._handleConnect(req, clientSocket, head, entry);
    });

    // Erros de socket não podem derrubar o processo do dashboard.
    server.on('clientError', (_err, socket) => {
      try { socket.destroy(); } catch (_) { /* ignore */ }
    });

    return new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(port, '0.0.0.0', () => resolve(server));
    });
  }

  /** CONNECT: decide entre túnel cego e MITM. */
  _handleConnect(req, clientSocket, head, entry) {
    const target = String(req.url || '');
    const sep = target.lastIndexOf(':');
    const host = sep === -1 ? target : target.slice(0, sep);
    const destPort = sep === -1 ? 443 : parseInt(target.slice(sep + 1), 10);

    clientSocket.on('error', () => { /* ignore */ });

    if (!MITM_PORTS.has(destPort)) {
      // Porta fora da lista: túnel cego, sem inspecionar nada.
      this._blindTunnel(host, destPort, clientSocket, head, entry);
      return;
    }

    let leaf;
    try {
      leaf = mitmCa.certificateFor(host);
    } catch (err) {
      console.error(`[ERROR] [mitm] Certificado para ${host} falhou:`, err.message);
      try { clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch (_) { /* ignore */ }
      return;
    }

    // O Chrome só chega aqui porque confia no pin deste certificado.
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    console.log(`[DEBUG] [mitm] CONNECT ${host}:${destPort} — terminando TLS para reescrever cabeçalhos`);

    const context = this._contextFor(entry, host, leaf);
    const tlsSocket = new tls.TLSSocket(clientSocket, {
      isServer: true,
      secureContext: context,
      // Sem ALPN: o Chrome negocia HTTP/1.1, que é o que sabemos reescrever.
      // Anunciar h2 aqui faria o Chrome falar um protocolo binário que este
      // proxy não interpreta.
      ALPNProtocols: ['http/1.1']
    });

    tlsSocket.on('error', () => {
      try { clientSocket.destroy(); } catch (_) { /* ignore */ }
    });

    // Entrega o socket já desencriptado ao parser HTTP do Node: assim ganhamos
    // keep-alive, chunked e pipelining de graça, em vez de reimplementar HTTP.
    const parser = http.createServer((req, res) => {
      this._handleMitm(req, res, host, destPort, entry);
    });
    parser.on('clientError', (_err, socket) => {
      try { socket.destroy(); } catch (_) { /* ignore */ }
    });
    parser.emit('connection', tlsSocket);
  }

  /** Contexto TLS por host, cacheado (emitir certificado é caro). */
  _contextFor(entry, host, leaf) {
    const cached = entry.contexts.get(host);
    if (cached) return cached;
    const context = tls.createSecureContext({ key: leaf.key, cert: leaf.cert });
    entry.contexts.set(host, context);
    return context;
  }

  /** Túnel TCP cego, usado em portas que não valem MITM. */
  _blindTunnel(host, destPort, clientSocket, head, entry) {
    this._upstreamSocket(host, destPort, entry)
      .then((upstream) => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
        upstream.on('error', () => clientSocket.destroy());
        clientSocket.on('error', () => upstream.destroy());
      })
      .catch(() => {
        try { clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch (_) { /* ignore */ }
      });
  }

  /**
   * Requisição HTTPS já desencriptada: reescreve e repassa.
   *
   * O socket de saída é aberto ANTES e entregue pronto ao http.request. O
   * `createConnection` do Node é síncrono — devolver uma Promise ali estoura
   * "socket.on is not a function", que foi exatamente o erro da primeira versão.
   */
  _handleMitm(req, res, host, destPort, entry) {
    this._upstreamTls(host, destPort, entry)
      .then((socket) => {
        const headers = this._rewrittenHeaders(req.headers, entry);
        const upstreamReq = http.request({
          host,
          port: destPort,
          method: req.method,
          path: req.url,
          headers,
          createConnection: () => socket
        }, (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        });

        upstreamReq.on('error', (err) => {
          console.error(`[ERROR] [mitm] upstream ${host}:${destPort}:`, err.message);
          this._fail(res);
        });
        // Diagnóstico: mostra o que realmente saiu no fio. Sem esta linha não há
        // como saber, olhando o log, se a reescrita pegou.
        console.log(`[DEBUG] [mitm] ${req.method} ${host}${req.url} UA="${headers['user-agent']}"`);
        req.pipe(upstreamReq);
      })
      .catch((err) => {
        console.error(`[ERROR] [mitm] TLS até ${host}:${destPort}:`, err.message);
        this._fail(res);
      });
  }

  /** Resposta de erro do MITM, sem derrubar o processo. */
  _fail(res) {
    try {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('mitm upstream error');
    } catch (_) { /* socket já fechado */ }
  }

  /** Requisição HTTP simples (sem CONNECT): reescreve e repassa. */
  _handlePlain(req, res, entry) {
    let target;
    try {
      target = new URL(req.url);
    } catch (_) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad request');
      return;
    }

    const host = target.hostname;
    const destPort = parseInt(target.port, 10) || 80;
    const headers = this._rewrittenHeaders(req.headers, entry);
    headers.host = target.host;

    // Mesmo cuidado do _handleMitm: socket pronto antes da requisição.
    this._upstreamSocket(host, destPort, entry)
      .then((socket) => {
        const upstreamReq = http.request({
          host,
          port: destPort,
          method: req.method,
          path: target.pathname + target.search,
          headers,
          createConnection: () => socket
        }, (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        });

        upstreamReq.on('error', () => this._fail(res));
        req.pipe(upstreamReq);
      })
      .catch(() => this._fail(res));
  }

  /**
   * Cabeçalhos da requisição com a identidade trocada.
   * Remove os hop-by-hop e injeta `Proxy-Authorization` quando há upstream
   * autenticado — o Chrome não sabe dessas credenciais.
   */
  _rewrittenHeaders(incoming, entry) {
    const out = {};
    for (const [name, value] of Object.entries(incoming || {})) {
      if (HOP_BY_HOP.has(name.toLowerCase())) continue;
      out[name] = value;
    }
    for (const [name, value] of Object.entries(entry.headers)) {
      out[name] = value;
    }
    return out;
  }

  /** Socket TLS até o destino, atravessando o proxy upstream se preciso. */
  _upstreamTls(host, destPort, entry) {
    return new Promise((resolve, reject) => {
      this._upstreamSocket(host, destPort, entry).then((raw) => {
        const secure = tls.connect({
          socket: raw,
          servername: host,
          // O destino é verificado normalmente: o MITM é nosso, a saída não.
          rejectUnauthorized: process.env.MITM_UPSTREAM_INSECURE !== '1'
        });
        secure.once('secureConnect', () => resolve(secure));
        secure.once('error', reject);
      }).catch(reject);
    });
  }

  /**
   * Socket cru até o destino. Com upstream autenticado, abre um CONNECT no
   * proxy de saída primeiro (é o mesmo caminho do forwarder simples).
   */
  _upstreamSocket(host, destPort, entry) {
    const upstream = entry && entry.upstream;
    const needsAuth = !!(upstream && upstream.user && upstream.pass);

    if (!needsAuth) {
      return Promise.resolve(net.createConnection({ host, port: destPort }));
    }

    return new Promise((resolve, reject) => {
      const proxySock = net.createConnection(
        { host: upstream.host, port: parseInt(upstream.port, 10) },
        () => {
          const auth = 'Basic ' + Buffer.from(`${upstream.user}:${upstream.pass}`).toString('base64');
          proxySock.write(
            `CONNECT ${host}:${destPort} HTTP/1.1\r\n` +
            `Host: ${host}:${destPort}\r\n` +
            `Proxy-Authorization: ${auth}\r\n\r\n`
          );
        }
      );

      let buffer = Buffer.alloc(0);
      const onData = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        proxySock.removeListener('data', onData);
        const statusLine = buffer.slice(0, buffer.indexOf('\r\n')).toString('latin1');
        if (!/^HTTP\/1\.[01] 2\d\d/.test(statusLine)) {
          proxySock.destroy();
          reject(new Error(`proxy upstream recusou: ${statusLine}`));
          return;
        }
        const rest = buffer.slice(end + 4);
        if (rest.length) proxySock.unshift(rest);
        resolve(proxySock);
      };

      proxySock.on('data', onData);
      proxySock.once('error', reject);
    });
  }
}

module.exports = new MitmProxyService();
module.exports.BASE_PORT = BASE_PORT;
module.exports.MITM_PORTS = MITM_PORTS;
module.exports.HOP_BY_HOP = HOP_BY_HOP;
