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
