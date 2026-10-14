/**
 * InstanceDiscoveryService
 *
 * Descobre as instâncias a partir do Docker daemon: pares gluetun{N}+chrome{N}
 * (modo VPN) e chrome{N} sozinho (modo proxy). Só enxerga containers cujo nome
 * segue exatamente o padrão gerado pelo dashboard, então containers de teste
 * avulsos (ex.: "gluetun-01") não entram na listagem.
 */
const Docker = require('dockerode');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const VPN_NAME_RE = /^\/gluetun(\d+)$/;
const CHROME_NAME_RE = /^\/chrome(\d+)$/;
const DISPLAY_PORT = 3000;
// Portas privadas que o dashboard publica: a 3000 é a área de trabalho do
// Chromium/Brave; a 9222 é o CDP do CloakBrowser (que não tem tela). Sem isso,
// uma instância CloakBrowser perderia a porta real e cairia no BASE_PORT+id-1.
const KNOWN_PRIVATE_PORTS = [DISPLAY_PORT, 9222];

function findName(container, regex) {
  return (container.Names || []).find((name) => regex.test(name)) || null;
}

class InstanceDiscoveryService {
  /**
   * @returns {Promise<Array>} instâncias com id, tipo, containers, porta e status.
   */
  async list() {
    try {
      const containers = await docker.listContainers({ all: true });

      const gluetunContainers = containers.filter((c) => findName(c, VPN_NAME_RE));
      const chromeContainers = containers.filter((c) => findName(c, CHROME_NAME_RE));

      const ids = new Set();
      for (const c of gluetunContainers) ids.add(parseInt(findName(c, VPN_NAME_RE).replace('/gluetun', ''), 10));
      for (const c of chromeContainers) ids.add(parseInt(findName(c, CHROME_NAME_RE).replace('/chrome', ''), 10));

      const instances = [];
      for (const id of ids) {
        const gluetun = gluetunContainers.find((c) => findName(c, VPN_NAME_RE) === `/gluetun${id}`) || null;
        const chrome = chromeContainers.find((c) => findName(c, CHROME_NAME_RE) === `/chrome${id}`) || null;
        // O tipo é definido pela existência do container do túnel.
        const type = gluetun ? 'vpn' : 'proxy';

        instances.push({
          id,
          type,
          gluetunContainer: gluetun ? `gluetun${id}` : null,
          chromeContainer: `chrome${id}`,
          port: this._resolvePort(type, gluetun, chrome, id),
          subdomain: `chrome${id}.${process.env.DOMAIN || 'sakr.ath.cx'}`,
          status: this._resolveStatus(type, gluetun, chrome),
          createdAt: this._createdAt(gluetun, chrome)
        });
      }

      return instances.sort((a, b) => a.id - b.id);
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'EACCES') {
        throw Object.assign(new Error('Docker socket inacessivel'), { status: 503 });
      }
      throw err;
    }
  }

  /** Porta pública: vem do gluetun no modo VPN e do chrome no modo proxy. */
  _resolvePort(type, gluetun, chrome, id) {
    const source = type === 'vpn' ? gluetun : chrome;
    const binding = (source && source.Ports ? source.Ports : [])
      .find((p) => KNOWN_PRIVATE_PORTS.includes(p.PrivatePort) && p.PublicPort);
    if (binding) return binding.PublicPort;
    return parseInt(process.env.BASE_PORT || '3001', 10) + id - 1;
  }

  _resolveStatus(type, gluetun, chrome) {
    const gluetunRunning = !!(gluetun && gluetun.State === 'running');
    const chromeRunning = !!(chrome && chrome.State === 'running');

    if (type === 'proxy') return chromeRunning ? 'running' : 'stopped';
    if (gluetunRunning && chromeRunning) return 'running';
    if (gluetunRunning || chromeRunning) return 'error';
    return 'stopped';
  }

  _createdAt(gluetun, chrome) {
    const source = gluetun || chrome;
    return source && source.Created
      ? new Date(source.Created * 1000).toISOString()
      : new Date().toISOString();
  }
}

module.exports = new InstanceDiscoveryService();
