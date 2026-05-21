const http = require('http');
const Docker = require('dockerode');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const VPN_API_TIMEOUT = 5000;
const CACHE_TTL = 30000; // 30 seconds

class VPNService {
  constructor() {
    // Cache: { containerName: { data, timestamp } }
    this._cache = new Map();
  }

  async getVPNStatus(containerName) {
    // Return cached data if fresh
    const cached = this._cache.get(containerName);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
      return cached.data;
    }

    try {
      const container = docker.getContainer(containerName);
      const info = await container.inspect();

      if (!info.State.Running) {
        const result = {
          publicIP: null,
          country: null,
          connected: false,
          lastChecked: new Date().toISOString()
        };
        this._cache.set(containerName, { data: result, timestamp: Date.now() });
        return result;
      }

      // Read IP from /tmp/gluetun/ip
      const publicIP = await this._execInContainer(container, 'cat /tmp/gluetun/ip 2>/dev/null');
      const connected = !!(publicIP && this._isValidIP(publicIP));

      // Get country - only query API if IP changed from last cache
      let country = null;
      if (connected) {
        const prevData = cached ? cached.data : null;
        if (prevData && prevData.publicIP === publicIP && prevData.country) {
          // IP didn't change, reuse country
          country = prevData.country;
        } else {
          country = await this._getCountryFromIP(publicIP);
        }
      }

      const result = {
        publicIP: connected ? publicIP : null,
        country: connected ? country : null,
        connected,
        lastChecked: new Date().toISOString()
      };

      this._cache.set(containerName, { data: result, timestamp: Date.now() });
      return result;
    } catch (err) {
      const result = {
        publicIP: null,
        country: null,
        connected: false,
        lastChecked: new Date().toISOString()
      };
      this._cache.set(containerName, { data: result, timestamp: Date.now() });
      return result;
    }
  }

  async getPublicIP(containerName) {
    const status = await this.getVPNStatus(containerName);
    return status.publicIP;
  }

  async getCountry(containerName) {
    const status = await this.getVPNStatus(containerName);
    return status.country;
  }

  clearCache(containerName) {
    if (containerName) {
      this._cache.delete(containerName);
    } else {
      this._cache.clear();
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
      const timeout = setTimeout(() => resolve(this._parseChunks(chunks)), VPN_API_TIMEOUT);

      stream.on('data', (chunk) => {
        chunks.push(chunk);
      });

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

  _parseChunks(chunks) {
    let result = '';
    for (const chunk of chunks) {
      if (chunk.length > 8) {
        result += chunk.slice(8).toString('utf-8');
      } else {
        result += chunk.toString('utf-8');
      }
    }
    return result.trim();
  }

  _isValidIP(str) {
    if (!str) return false;
    const parts = str.split('.');
    if (parts.length !== 4) return false;
    return parts.every(p => {
      const num = parseInt(p, 10);
      return num >= 0 && num <= 255 && String(num) === p;
    });
  }

  async _getCountryFromIP(ip) {
    try {
      const data = await this._httpGet(`http://ip-api.com/json/${ip}?fields=country`);
      if (data) {
        const parsed = JSON.parse(data);
        return parsed.country || null;
      }
    } catch {
      // Ignore
    }
    return null;
  }

  _httpGet(url) {
    return new Promise((resolve) => {
      const req = http.get(url, { timeout: 3000 }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
  }
}

module.exports = new VPNService();
