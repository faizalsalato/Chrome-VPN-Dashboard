const net = require('net');

// Porta base dos relays SOCKS5. Cada instância usa BASE_PORT + id, para não
// colidir com os forwarders HTTP (PROXY_INJECTOR_BASE_PORT).
const BASE_PORT = parseInt(process.env.SOCKS_RELAY_BASE_PORT || '18100', 10);

/**
 * SocksRelayService
 *
 * Motivo: o forwarder HTTP (`proxy-injector`) injeta `Proxy-Authorization`, que
 * é um cabeçalho HTTP. Em SOCKS5 a credencial vai DENTRO do handshake, por isso
 * aquele forwarder não serve. Sem relay, o Firefox não consegue usar um SOCKS5
 * autenticado.
 *
 * Porque isto importa: com proxy HTTP o navegador entrega o NOME ao proxy no
 * CONNECT e nunca resolve DNS. Medido: depois de visitar globo.com,
 * `about:networking#dns` continuava sem `www.globo.com`. Com SOCKS5 e resolução
 * local, o navegador resolve nomes pelo resolver do container, e o DNS deixa de
 * ser o do proxy (que estava no Canadá, e derrubava a nota do whoer para 70%).
 * Com o resolver brasileiro do gluetun `br-01`, a mesma instância passou a 100%.
 *
 * O relay aceita o cliente SEM autenticação (o container não sabe a credencial)
 * e injeta user/pass no handshake com o upstream.
 */
class SocksRelayService {
  constructor() {
    // id -> { server, upstream }
    this.relays = new Map();
  }

  /** Porta determinística do relay de uma instância. */
  getPort(id) {
    return BASE_PORT + parseInt(id, 10);
  }

  isRunning(id) {
    return this.relays.has(id);
  }

  /**
   * Inicia (ou reinicia) o relay de uma instância.
   * @param {number} id
   * @param {object} upstream { host, port, user, pass }
   * @returns {Promise<number>} porta em que o relay escuta
   */
  async start(id, upstream) {
    if (this.relays.has(id)) await this.stop(id);

    const port = this.getPort(id);
    const server = await this._createRelay(port, upstream);
    this.relays.set(id, { server, upstream });
    console.log(
      `[INFO] [socks-relay] Relay da instância ${id} ativo em 0.0.0.0:${port} -> ${upstream.host}:${upstream.port}`
    );
    return port;
  }

  async stop(id) {
    const entry = this.relays.get(id);
    if (!entry) return;
    this.relays.delete(id);

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
    for (const id of Array.from(this.relays.keys())) {
      await this.stop(id);
    }
  }

  /**
   * Leitor com espera: o handshake SOCKS5 chega em pedaços, e ler sem esperar
   * o tamanho certo parte a mensagem. Devolve os bytes pedidos ou lança.
   */
  _reader(sock) {
    let buf = Buffer.alloc(0);
    let pending = null;
    let closed = false;
    let err = null;

    const wake = () => { if (pending) { const p = pending; pending = null; p(); } };
    const onData = (d) => { buf = Buffer.concat([buf, d]); wake(); };
    const onErr = (e) => { err = e; wake(); };
    const onClose = () => { closed = true; wake(); };

    sock.on('data', onData);
    sock.on('error', onErr);
    sock.on('close', onClose);

    return {
      async need(n) {
        while (buf.length < n) {
          if (err) throw err;
          if (closed) throw new Error('socket fechado');
          await new Promise((res) => { pending = res; });
        }
        const out = Buffer.from(buf.subarray(0, n));
        buf = buf.subarray(n);
        return out;
      },
      takeAll() { const out = buf; buf = Buffer.alloc(0); return out; },
      detach() {
        sock.removeListener('data', onData);
        sock.removeListener('error', onErr);
        sock.removeListener('close', onClose);
      },
    };
  }

  /**
   * Resolve um nome usando o resolvedor do pais (ex.: br-01 em 172.17.0.3).
   * Usa dns.resolve4 com `servers` para forcar o servidor, em vez do
   * /etc/resolv.conf do host. Falha suave: se o resolvedor nao responder,
   * devolve null e o relay repassa o nome ao proxy (comportamento antigo).
   */
  _resolveVia(name, dnsServer) {
    return new Promise((resolve) => {
      try {
        const dns = require('dns');
        const r = new dns.Resolver();
        r.setServers([dnsServer]);
        // Sem r.setTimeout(): nao existe nessa API e lancava excecao que o
        // catch engolia, devolvendo null sempre. O timeout e nosso.
        const timer = setTimeout(() => resolve(null), 2500);
        r.resolve4(name, (err, addresses) => {
          clearTimeout(timer);
          resolve(!err && addresses && addresses.length ? addresses[0] : null);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  _createRelay(port, upstream) {
    return new Promise((resolve, reject) => {
      const server = net.createServer((client) => {
        client.on('error', () => {});
        this._handle(client, upstream).catch(() => {
          try { client.destroy(); } catch (_) { /* ignore */ }
        });
      });

      server.on('error', (err) => reject(err));
      server.listen(port, '0.0.0.0', () => resolve(server));
    });
  }

  async _handle(client, upstream) {
    const cr = this._reader(client);
    let up = null;

    try {
      // 1. Saudação do cliente: aceitamos sem autenticação (método 0).
      const greet = await cr.need(2);
      if (greet[0] !== 5) throw new Error('não é SOCKS5');
      await cr.need(greet[1]);
      client.write(Buffer.from([5, 0]));

      // 2. Pedido do cliente: só CONNECT.
      const head = await cr.need(4);
      const cmd = head[1];
      const atyp = head[3];
      let rawAddr;

      if (atyp === 1) {
        const a = await cr.need(4);
        rawAddr = Buffer.concat([Buffer.from([1]), a]);
      } else if (atyp === 3) {
        const len = await cr.need(1);
        const d = await cr.need(len[0]);
        rawAddr = Buffer.concat([Buffer.from([3, len[0]]), d]);
      } else if (atyp === 4) {
        const a = await cr.need(16);
        rawAddr = Buffer.concat([Buffer.from([4]), a]);
      } else {
        throw new Error('atyp inválido');
      }
      const portBuf = await cr.need(2);
      if (cmd !== 1) throw new Error('só CONNECT é suportado');

      // Resolucao LOCAL do nome. O Chromium, com SOCKS5, entrega SEMPRE o nome
      // ao proxy — esta documentado no proprio Chromium ("name resolution is
      // always done proxy side"), e ao contrario do Firefox nao ha opcao de
      // resolver no cliente. Se repassarmos o nome, quem resolve e o proxy e o
      // whoer ve o DNS do proxy (Canada, no proxy BR), mesmo com IP brasileiro.
      // Resolvendo aqui pelo resolvedor do pais, o CONNECT leva ja o IP certo e
      // o DNS deixa de ser o do proxy. Medido: br-01 resolve com egress
      // brasileiro (104.23.255.5 -> Sao Paulo); o resolver do host da Alemanha.
      let destAddr = rawAddr;
      if (atyp === 3 && upstream.dnsServer) {
        const name = rawAddr.subarray(2).toString('ascii');
        const ip = await this._resolveVia(name, upstream.dnsServer);
        if (ip) {
          destAddr = Buffer.concat([Buffer.from([1]), Buffer.from(ip.split('.').map(Number))]);
        }
      }

      // 3. Handshake com o upstream, com credencial.
      up = net.connect(upstream.port, upstream.host);
      up.on('error', () => {});
      const ur = this._reader(up);

      up.write(Buffer.from([5, 1, 2]));
      const ug = await ur.need(2);
      if (ug[1] !== 2) throw new Error(`upstream não aceita user/pass (método ${ug[1]})`);

      const u = Buffer.from(upstream.user || '');
      const p = Buffer.from(upstream.pass || '');
      up.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
      const ar = await ur.need(2);
      if (ar[1] !== 0) throw new Error('upstream recusou a credencial');

      // 4. CONNECT ao upstream com o destino resolvido localmente (ou o nome,
      // se nao houver resolvedor configurado — comportamento antigo).
      up.write(Buffer.concat([Buffer.from([5, 1, 0]), destAddr, portBuf]));
      const rep = await ur.need(4);
      if (rep[1] !== 0) throw new Error(`upstream recusou o destino (código ${rep[1]})`);
      if (rep[3] === 1) await ur.need(4);
      else if (rep[3] === 3) { const l = await ur.need(1); await ur.need(l[0]); }
      else if (rep[3] === 4) await ur.need(16);
      await ur.need(2);

      // 5. Sucesso ao cliente.
      client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));

      // 6. Relay cru, sem interpretar nada.
      const leftClient = cr.takeAll();
      const leftUp = ur.takeAll();
      cr.detach();
      ur.detach();
      if (leftClient.length) up.write(leftClient);
      if (leftUp.length) client.write(leftUp);
      client.pipe(up);
      up.pipe(client);
      client.on('close', () => up.destroy());
      up.on('close', () => client.destroy());
    } catch (err) {
      try { client.write(Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0])); } catch (_) { /* ignore */ }
      client.destroy();
      if (up) up.destroy();
    }
  }

  /**
   * No boot do dashboard, reativa os relays das instâncias que declaram SOCKS5.
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
        "SELECT id, proxy_host, proxy_port, proxy_user, proxy_pass " +
        "FROM instances WHERE type = 'proxy' AND proxy_auth = 1 AND proxy_scheme = 'socks5'"
      ).all();
      for (const r of rows) {
        try {
          await this.start(r.id, {
            host: r.proxy_host,
            port: r.proxy_port,
            user: r.proxy_user,
            pass: r.proxy_pass
          });
        } catch (err) {
          console.error(`[ERROR] [socks-relay] Falha ao restaurar relay ${r.id}:`, err.message);
        }
      }
      if (rows.length) {
        console.log(`[INFO] [socks-relay] ${rows.length} relay(s) restaurado(s)`);
      }
    } catch (_) {
      // Banco pode não estar pronto ainda; ignora.
    }
  }
}

module.exports = new SocksRelayService();
