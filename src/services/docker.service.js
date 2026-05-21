const Docker = require('dockerode');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

class DockerService {
  async listInstances() {
    try {
      const containers = await docker.listContainers({ all: true });

      const gluetunContainers = containers.filter(c =>
        c.Names.some(n => /^\/gluetun\d+$/.test(n))
      );

      const instances = [];

      for (const gluetun of gluetunContainers) {
        const name = gluetun.Names[0].replace('/', '');
        const id = parseInt(name.replace('gluetun', ''), 10);
        const chromeName = `chrome${id}`;

        const chrome = containers.find(c =>
          c.Names.some(n => n === `/${chromeName}`)
        );

        let status = 'stopped';
        if (gluetun.State === 'running' && chrome && chrome.State === 'running') {
          status = 'running';
        } else if (gluetun.State === 'running' || (chrome && chrome.State === 'running')) {
          status = 'error';
        }

        // Extract port from gluetun port bindings
        let port = null;
        if (gluetun.Ports) {
          const portBinding = gluetun.Ports.find(p => p.PrivatePort === 3000 && p.PublicPort);
          if (portBinding) {
            port = portBinding.PublicPort;
          }
        }

        instances.push({
          id,
          gluetunContainer: name,
          chromeContainer: chromeName,
          port: port || (parseInt(process.env.BASE_PORT || '3001', 10) + id - 1),
          subdomain: `chrome${id}.${process.env.DOMAIN || 'sakr.ath.cx'}`,
          status,
          createdAt: gluetun.Created ? new Date(gluetun.Created * 1000).toISOString() : new Date().toISOString()
        });
      }

      return instances.sort((a, b) => a.id - b.id);
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'EACCES') {
        throw Object.assign(new Error('Docker socket inacessível'), { status: 503 });
      }
      throw err;
    }
  }

  async startInstance(id) {
    const gluetunName = `gluetun${id}`;
    const chromeName = `chrome${id}`;

    // Start gluetun first
    const gluetun = docker.getContainer(gluetunName);
    const gluetunInfo = await gluetun.inspect();

    if (gluetunInfo.State.Running) {
      // Already running, just start chrome
    } else {
      await this._startWithTimeout(gluetun, 30000);
      // Wait a moment for gluetun to initialize
      await this._sleep(2000);
    }

    // Start chrome
    try {
      const chrome = docker.getContainer(chromeName);
      const chromeInfo = await chrome.inspect();
      if (!chromeInfo.State.Running) {
        await this._startWithTimeout(chrome, 30000);
      }
    } catch (err) {
      // If chrome fails, stop gluetun (rollback)
      try {
        await gluetun.stop({ t: 10 });
      } catch (stopErr) {
        // Ignore stop errors during rollback
      }
      throw err;
    }
  }

  async stopInstance(id) {
    const gluetunName = `gluetun${id}`;
    const chromeName = `chrome${id}`;

    // Stop chrome first
    try {
      const chrome = docker.getContainer(chromeName);
      const chromeInfo = await chrome.inspect();
      if (chromeInfo.State.Running) {
        await this._stopWithTimeout(chrome, 15000);
      }
    } catch (err) {
      if (err.statusCode !== 404) {
        console.warn(`[WARN] Erro ao parar ${chromeName}:`, err.message);
      }
    }

    // Stop gluetun
    try {
      const gluetun = docker.getContainer(gluetunName);
      const gluetunInfo = await gluetun.inspect();
      if (gluetunInfo.State.Running) {
        await this._stopWithTimeout(gluetun, 15000);
      }
    } catch (err) {
      if (err.statusCode !== 404) {
        console.warn(`[WARN] Erro ao parar ${gluetunName}:`, err.message);
      }
    }
  }

  async _pullImage(imageName) {
    try {
      await docker.getImage(imageName).inspect();
    } catch (err) {
      if (err.statusCode === 404) {
        console.log(`[INFO] Baixando imagem ${imageName}...`);
        const stream = await docker.pull(imageName);
        await new Promise((resolve, reject) => {
          docker.modem.followProgress(stream, (err, output) => {
            if (err) reject(err);
            else resolve(output);
          });
        });
        console.log(`[INFO] Imagem ${imageName} baixada com sucesso`);
      } else {
        throw err;
      }
    }
  }

  async createInstance(config) {
    const { id, port } = config;
    const domain = process.env.DOMAIN || 'sakr.ath.cx';
    const openvpnUser = config.openvpnUser || 'G9t9Fr7L67MT9Qg7AuV6P6PH';
    const openvpnPassword = config.openvpnPassword || 'aemT8ba6Tm3DqKta8B9qtuVK';

    // Pull images if not present
    await this._pullImage('qmcgaw/gluetun');
    await this._pullImage('lscr.io/linuxserver/chromium:latest');

    // Create gluetun container
    const gluetunContainer = await docker.createContainer({
      Image: 'qmcgaw/gluetun',
      name: `gluetun${id}`,
      Env: [
        'VPN_SERVICE_PROVIDER=surfshark',
        'VPN_TYPE=openvpn',
        `OPENVPN_USER=${openvpnUser}`,
        `OPENVPN_PASSWORD=${openvpnPassword}`,
        `SERVER_COUNTRIES=${config.serverCountries || 'United States'}`
      ],
      HostConfig: {
        CapAdd: ['NET_ADMIN'],
        PortBindings: {
          '3000/tcp': [{ HostPort: String(port) }]
        },
        RestartPolicy: { Name: 'unless-stopped' }
      }
    });

    // Create chrome container (LinuxServer Chromium - lightweight with KasmVNC)
    try {
      const chromeContainer = await docker.createContainer({
        Image: 'lscr.io/linuxserver/chromium:latest',
        name: `chrome${id}`,
        Env: [
          'PUID=1000',
          'PGID=1000',
          'TZ=Etc/UTC',
          'CHROME_CLI=--no-sandbox --disable-gpu --disable-dev-shm-usage'
        ],
        HostConfig: {
          NetworkMode: `container:gluetun${id}`,
          ShmSize: 536870912, // 512MB (suficiente para chromium leve)
          RestartPolicy: { Name: 'unless-stopped' }
        }
      });

      return {
        id,
        gluetunContainer: `gluetun${id}`,
        chromeContainer: `chrome${id}`,
        port,
        subdomain: `chrome${id}.${domain}`,
        status: 'stopped',
        createdAt: new Date().toISOString()
      };
    } catch (err) {
      // Rollback: remove gluetun container
      try {
        await gluetunContainer.remove({ force: true });
      } catch (removeErr) {
        console.error('[ERROR] Rollback falhou ao remover gluetun:', removeErr.message);
      }
      throw err;
    }
  }

  async removeInstance(id) {
    const gluetunName = `gluetun${id}`;
    const chromeName = `chrome${id}`;

    // Stop and remove chrome
    try {
      const chrome = docker.getContainer(chromeName);
      await chrome.remove({ force: true });
    } catch (err) {
      if (err.statusCode !== 404) {
        console.warn(`[WARN] Erro ao remover ${chromeName}:`, err.message);
      }
    }

    // Stop and remove gluetun
    try {
      const gluetun = docker.getContainer(gluetunName);
      await gluetun.remove({ force: true });
    } catch (err) {
      if (err.statusCode !== 404) {
        console.warn(`[WARN] Erro ao remover ${gluetunName}:`, err.message);
      }
    }
  }

  async getContainerHealth(name) {
    try {
      const container = docker.getContainer(name);
      const info = await container.inspect();

      if (!info.State.Running) {
        return 'stopped';
      }

      if (info.State.Health) {
        return info.State.Health.Status === 'healthy' ? 'running' : 'unhealthy';
      }

      return info.State.Running ? 'running' : 'stopped';
    } catch (err) {
      return 'unknown';
    }
  }

  async _startWithTimeout(container, timeout) {
    return Promise.race([
      container.start(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timeout ao iniciar container')), timeout)
      )
    ]);
  }

  async _stopWithTimeout(container, timeout) {
    try {
      await Promise.race([
        container.stop({ t: Math.floor(timeout / 1000) }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout ao parar container')), timeout)
        )
      ]);
    } catch (err) {
      if (err.message.includes('Timeout')) {
        // Force kill
        try {
          await container.kill();
        } catch (killErr) {
          // Ignore
        }
      } else if (err.statusCode !== 304) {
        // 304 = already stopped
        throw err;
      }
    }
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = new DockerService();
