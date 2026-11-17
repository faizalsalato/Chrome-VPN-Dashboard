const http = require('http');

/**
 * ProxyTesterService - testa se um proxy está "live" e retorna dados de
 * geolocalização do IP de saída.
 *
 * Faz uma requisição HTTP real ATRAVÉS do proxy (forward proxy com URI
 * absoluta) para o ip-api.com — a mesma fonte de geo já usada no projeto.
 * Funciona para proxies HTTP/HTTPS (forward), inclusive autenticados via
 * cabeçalho Proxy-Authorization (ex.: Bright Data).
 */
const GEO_URL =
  'http://ip-api.com/json/?fields=status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,query';
const DEFAULT_TIMEOUT = 9000;

class ProxyTesterService {
  /**
   * @param {object} cfg { host, port, scheme, user, pass }
   * @returns {Promise<object>} { live, ip, country, ..., latencyMs, error }
   */
  async test(cfg, timeoutMs = DEFAULT_TIMEOUT) {
    const { host, port, user, pass } = cfg || {};

    if (!host || !port) {
      return this._dead('Host e porta são obrigatórios', 0, 'invalid');
    }
    const p = parseInt(port, 10);
    if (isNaN(p) || p < 1 || p > 65535) {
      return this._dead('Porta inválida', 0, 'invalid');
    }

    const auth = (user && pass)
      ? 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')
      : null;

    // SOCKS5 nao fala HTTP: o handshake e binario e a credencial vai dentro
    // dele, nao num cabecalho Proxy-Authorization. Sem este ramo o tester
    // mandava um pedido HTTP para um socket SOCKS5, recebia "Parse Error:
    // Expected HTTP/" e dava o proxy como morto — a instancia nascia com geo
    // `proxy-unknown`, fuso UTC e idioma en-US, e o whoer acusava a divergencia
    // entre o fuso do sistema e o do IP.
    if (cfg && cfg.scheme === 'socks5') {
      let result = await this._queryGeoSocks5(host, p, user, pass, timeoutMs);
      for (let wait of [2000, 4000]) {
        if (result._rateLimited) {
          await new Promise(r => setTimeout(r, wait));
          result = await this._queryGeoSocks5(host, p, user, pass, timeoutMs);
        } else {
          break;
        }
      }
      if (result._rateLimited) {
        return this._dead('Serviço de geolocalização em rate-limit. Tente novamente em instantes.', 0, 'geo_ratelimit');
      }
      return result;
    }

    // ip-api.com (plano gratuito) limita ~45 req/min. Em caso de rate-limit,
    // faz até 2 novas tentativas com espera progressiva antes de desistir.
    let result = await this._queryGeo(host, p, auth, timeoutMs);
    for (let wait of [2000, 4000]) {
      if (result._rateLimited) {
        await new Promise(r => setTimeout(r, wait));
        result = await this._queryGeo(host, p, auth, timeoutMs);
      } else {
        break;
      }
    }
    // Ainda em rate-limit após as tentativas: devolve erro amigável.
    if (result._rateLimited) {
      return this._dead('Serviço de geolocalização em rate-limit. Tente novamente em instantes.', 0, 'geo_ratelimit');
    }
    return result;
  }

  _queryGeo(host, port, auth, timeoutMs) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const headers = { Host: 'ip-api.com', Connection: 'close' };
      if (auth) headers['Proxy-Authorization'] = auth;

      const req = http.request({ host, port, method: 'GET', path: GEO_URL, headers }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          const latency = Date.now() - startedAt;
          if (res.statusCode === 407) {
            return resolve(this._dead('Autenticação recusada pelo proxy (407)', latency, 'auth_failed'));
          }
          if (res.statusCode !== 200) {
            return resolve(this._dead(`Proxy respondeu HTTP ${res.statusCode}`, latency));
          }
          let json;
          try { json = JSON.parse(body); } catch {
            return resolve(this._dead('Resposta de geolocalização inválida', latency));
          }
          if (json.status !== 'success') {
            const rl = /rate limit|limit/i.test(json.message || '');
            if (rl) return resolve({ _rateLimited: true });
            return resolve(this._dead(json.message || 'Falha na consulta de geo', latency));
          }
          resolve({
            live: true,
            ip: json.query || null,
            country: json.country || null,
            countryCode: json.countryCode || null,
            region: json.regionName || null,
            regionCode: json.region || null,
            city: json.city || null,
            zip: json.zip || null,
            lat: json.lat != null ? json.lat : null,
            lon: json.lon != null ? json.lon : null,
            timezone: json.timezone || null,
            isp: json.isp || null,
            org: json.org || null,
            as: json.as || null,
            latencyMs: latency,
            error: null,
            code: null
          });
        });
      });

      req.setTimeout(timeoutMs, () => {
        req.destroy();
        resolve(this._dead(`Tempo esgotado (${timeoutMs}ms)`, Date.now() - startedAt, 'timeout'));
      });
      req.on('error', (err) => {
        let msg = err.message || 'Erro de conexão';
        if (err.code === 'ECONNREFUSED') msg = 'Conexão recusada (porta fechada?)';
        else if (err.code === 'ENOTFOUND') msg = 'Host não resolvido (DNS)';
        else if (err.code === 'ETIMEDOUT') msg = 'Tempo esgotado ao conectar';
        resolve(this._dead(msg, Date.now() - startedAt, err.code || 'error'));
      });
      req.end();
    });
  }

  /**
   * Consulta a geo ATRAVES de um proxy SOCKS5.
   *
   * Faz o handshake SOCKS5 a mao (saudacao, user/pass, CONNECT) e depois fala
   * HTTP/1.1 simples pelo tunel ja aberto. O destino vai como NOME (atyp 3): o
   * proxy resolve, que e o comportamento normal de SOCKS5.
   */
  _queryGeoSocks5(host, port, user, pass, timeoutMs) {
    const net = require('net');
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const target = 'ip-api.com';
      const done = (r) => { try { sock.destroy(); } catch (_) {} resolve(r); };

      const sock = net.connect(port, host);
      sock.setTimeout(timeoutMs, () => done(this._dead(`Tempo esgotado (${timeoutMs}ms)`, Date.now() - startedAt, 'timeout')));
      sock.on('error', (err) => {
        let msg = err.message || 'Erro de conexão';
        if (err.code === 'ECONNREFUSED') msg = 'Conexão recusada (porta fechada?)';
        else if (err.code === 'ENOTFOUND') msg = 'Host não resolvido (DNS)';
        else if (err.code === 'ETIMEDOUT') msg = 'Tempo esgotado ao conectar';
        done(this._dead(msg, Date.now() - startedAt, err.code || 'error'));
      });

      // Leitor com espera: o handshake chega em pedacos.
      let buf = Buffer.alloc(0);
      let waiter = null;
      const pump = () => { if (waiter) { const w = waiter; waiter = null; w(); } };
      sock.on('data', (d) => { buf = Buffer.concat([buf, d]); pump(); });
      const need = (n) => new Promise((res) => {
        const check = () => { if (buf.length >= n) { const out = buf.subarray(0, n); buf = buf.subarray(n); res(out); } else { waiter = check; } };
        check();
      });

      (async () => {
        await new Promise((res) => sock.once('connect', res));

        // 1. Saudacao: oferece user/pass (2) e sem auth (0).
        const methods = (user && pass) ? [0, 2] : [0];
        sock.write(Buffer.from([5, methods.length, ...methods]));
        const greet = await need(2);
        if (greet[0] !== 5) return done(this._dead('Proxy não é SOCKS5', Date.now() - startedAt, 'not_socks5'));
        if (greet[1] === 2) {
          if (!(user && pass)) return done(this._dead('Proxy exige autenticação', Date.now() - startedAt, 'auth_required'));
          const u = Buffer.from(user);
          const pw = Buffer.from(pass);
          sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([pw.length]), pw]));
          const ar = await need(2);
          if (ar[1] !== 0) return done(this._dead('Autenticação recusada pelo proxy', Date.now() - startedAt, 'auth_failed'));
        } else if (greet[1] !== 0) {
          return done(this._dead(`Método SOCKS5 não suportado (${greet[1]})`, Date.now() - startedAt, 'auth_failed'));
        }

        // 2. CONNECT ao ip-api.com:80 pelo nome (o proxy resolve).
        const h = Buffer.from(target);
        sock.write(Buffer.concat([
          Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([0, 80])
        ]));
        const rep = await need(4);
        if (rep[1] !== 0) return done(this._dead(`Proxy recusou o destino (código ${rep[1]})`, Date.now() - startedAt, 'connect_failed'));
        if (rep[3] === 1) await need(4);
        else if (rep[3] === 3) { const l = await need(1); await need(l[0]); }
        else if (rep[3] === 4) await need(16);
        await need(2);

        // 3. HTTP/1.1 simples pelo tunel.
        const path = GEO_URL.replace(/^http:\/\/[^/]+/, '');
        sock.write(`GET ${path} HTTP/1.1\r\nHost: ${target}\r\nConnection: close\r\n\r\n`);

        let head = Buffer.alloc(0);
        let body = Buffer.alloc(0);
        let headerDone = false;
        await new Promise((res) => {
          const onData = (d) => {
            if (headerDone) { body = Buffer.concat([body, d]); return; }
            head = Buffer.concat([head, d]);
            const idx = head.indexOf('\r\n\r\n');
            if (idx !== -1) {
              headerDone = true;
              body = head.subarray(idx + 4);
              head = head.subarray(0, idx);
            }
          };
          sock.on('data', onData);
          sock.once('close', res);
          sock.once('end', res);
          setTimeout(res, Math.max(1000, timeoutMs - (Date.now() - startedAt)));
        });

        const status = parseInt((head.toString().split(' ')[1] || '0'), 10);
        const latency = Date.now() - startedAt;
        if (status === 407) return done(this._dead('Autenticação recusada pelo proxy (407)', latency, 'auth_failed'));
        if (status !== 200) return done(this._dead(`Proxy respondeu HTTP ${status}`, latency));

        let json;
        try { json = JSON.parse(body.toString()); } catch {
          return done(this._dead('Resposta de geolocalização inválida', latency));
        }
        if (json.status !== 'success') {
          if (/rate limit|limit/i.test(json.message || '')) return done({ _rateLimited: true });
          return done(this._dead(json.message || 'Falha na consulta de geo', latency));
        }
        done({
          live: true,
          ip: json.query || null,
          country: json.country || null,
          countryCode: json.countryCode || null,
          region: json.regionName || null,
          regionCode: json.region || null,
          city: json.city || null,
          zip: json.zip || null,
          lat: json.lat != null ? json.lat : null,
          lon: json.lon != null ? json.lon : null,
          timezone: json.timezone || null,
          isp: json.isp || null,
          org: json.org || null,
          as: json.as || null,
          latencyMs: latency,
          error: null,
          code: null
        });
      })().catch((err) => done(this._dead(err.message || 'Falha no SOCKS5', Date.now() - startedAt, 'error')));
    });
  }

  _dead(message, latencyMs, code) {
    return {
      live: false, ip: null, country: null, countryCode: null, region: null,
      regionCode: null, city: null, zip: null, lat: null, lon: null,
      timezone: null, isp: null, org: null, as: null,
      latencyMs: latencyMs || 0, error: message, code: code || null
    };
  }
}

module.exports = new ProxyTesterService();
