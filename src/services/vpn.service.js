/**
 * VPNService
 *
 * Lê o IP de saída do container do túnel (Gluetun) e resolve a geolocalização
 * (país, cidade e fuso horário) via ip-api.com. Esses dados alimentam o
 * fingerprint do perfil: o navegador precisa falar e marcar o horário do
 * mesmo lugar de onde o tráfego sai.
 */
const http = require('http');
const Docker = require('dockerode');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const EXEC_TIMEOUT = 5000;
const CACHE_TTL = 30000;
const GEO_TIMEOUT = 5000;
const GEO_FIELDS =
  'status,message,country,countryCode,regionName,city,zip,lat,lon,timezone,isp,query';
const RATE_LIMIT_WAITS = [2000, 4000];

const DISCONNECTED = {
  publicIP: null,
  country: null,
  countryCode: null,
  city: null,
  region: null,
  timezone: null,
  connected: false,
  lastChecked: null
};

class VPNService {
  constructor() {
    // containerName -> { data, timestamp }
    this._cache = new Map();
  }

  /** Status do túnel, com cache curto para não martelar o daemon. */
  async getVPNStatus(containerName) {
    const cached = this._cache.get(containerName);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data;
    }

    const result = await this._probe(containerName, cached ? cached.data : null);
    this._cache.set(containerName, { data: result, timestamp: Date.now() });
    return result;
  }

  async getPublicIP(containerName) {
    return (await this.getVPNStatus(containerName)).publicIP;
  }

  async getCountry(containerName) {
    return (await this.getVPNStatus(containerName)).country;
  }

  /**
   * Espera o túnel conectar e devolver a geolocalização da saída.
   * Usado no start para alinhar o fingerprint ao IP real.
   *
   * @param {string} containerName
   * @param {number} timeoutMs tempo máximo de espera
   * @returns {Promise<object>} status (com connected=false se não conectar)
   */
  async waitForConnection(containerName, timeoutMs = 25000) {
    const deadline = Date.now() + timeoutMs;
    let status = await this.getVPNStatus(containerName);

    while (!status.connected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      this.clearCache(containerName);
      status = await this.getVPNStatus(containerName);
    }
    return status;
  }

  clearCache(containerName) {
    if (containerName) this._cache.delete(containerName);
    else this._cache.clear();
  }

  async _probe(containerName, previous) {
    try {
      const container = docker.getContainer(containerName);
      const info = await container.inspect();

      if (!info.State.Running) {
        return Object.assign({}, DISCONNECTED, { lastChecked: new Date().toISOString() });
      }

      const publicIP = await this._execInContainer(container, 'cat /tmp/gluetun/ip 2>/dev/null');
      const connected = !!(publicIP && this._isValidIP(publicIP));
      if (!connected) {
        return Object.assign({}, DISCONNECTED, { lastChecked: new Date().toISOString() });
      }

      // Mesmo IP de antes: reaproveita a geo (evita rate-limit do ip-api).
      const geo = previous && previous.publicIP === publicIP && previous.timezone
        ? { country: previous.country, countryCode: previous.countryCode, city: previous.city,
            region: previous.region, timezone: previous.timezone }
        : await this._getGeoFromIP(publicIP);

      return {
        publicIP,
        country: geo.country || null,
        countryCode: geo.countryCode || null,
        city: geo.city || null,
        region: geo.region || null,
        timezone: geo.timezone || null,
        connected: true,
        lastChecked: new Date().toISOString()
      };
    } catch (err) {
      return Object.assign({}, DISCONNECTED, { lastChecked: new Date().toISOString() });
    }
  }

  async _execInContainer(container, cmd) {
    try {
      const exec = await container.exec({
        Cmd: ['sh', '-c', cmd],
        AttachStdout: true,
        AttachStderr: true
      });
      const stream = await exec.start({ Detach: false });
      const output = await this._streamToString(stream);
      return output || null;
    } catch (err) {
      return null;
    }
  }

  _streamToString(stream) {
    return new Promise((resolve) => {
      const chunks = [];
      const timeout = setTimeout(() => resolve(this._parseChunks(chunks)), EXEC_TIMEOUT);

      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => {
        clearTimeout(timeout);
        resolve(this._parseChunks(chunks));
      });
      stream.on('error', () => {
        clearTimeout(timeout);
        resolve(this._parseChunks(chunks));
      });
    });
  }

  /** Remove o cabeçalho de 8 bytes do stream de exec do Docker. */
  _parseChunks(chunks) {
    let result = '';
    for (const chunk of chunks) {
      result += chunk.length > 8 ? chunk.slice(8).toString('utf-8') : chunk.toString('utf-8');
    }
    return result.trim();
  }

  _isValidIP(str) {
    if (!str) return false;
    const parts = str.split('.');
    if (parts.length !== 4) return false;
    return parts.every((p) => {
      const num = parseInt(p, 10);
      return num >= 0 && num <= 255 && String(num) === p;
    });
  }

  /** Geolocaliza o IP de saída, com retry em caso de rate-limit do ip-api. */
  async _getGeoFromIP(ip) {
    for (let attempt = 0; attempt <= RATE_LIMIT_WAITS.length; attempt++) {
      const result = await this._queryGeo(ip);
      if (!result.rateLimited) return result.data;
      if (attempt < RATE_LIMIT_WAITS.length) {
        await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_WAITS[attempt]));
      }
    }
    return {};
  }

  _queryGeo(ip) {
    return new Promise((resolve) => {
      const url = `http://ip-api.com/json/${ip}?fields=${GEO_FIELDS}`;
      const req = http.get(url, { timeout: GEO_TIMEOUT }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            if (json.status !== 'success') {
              const rateLimited = /rate limit|limit/i.test(json.message || '');
              return resolve({ rateLimited, data: {} });
            }
            resolve({
              rateLimited: false,
              data: {
                country: json.country || null,
                countryCode: json.countryCode || null,
                region: json.regionName || null,
                city: json.city || null,
                timezone: json.timezone || null
              }
            });
          } catch (err) {
            resolve({ rateLimited: false, data: {} });
          }
        });
      });
      req.on('error', () => resolve({ rateLimited: false, data: {} }));
      req.on('timeout', () => { req.destroy(); resolve({ rateLimited: false, data: {} }); });
    });
  }
}

module.exports = new VPNService();
