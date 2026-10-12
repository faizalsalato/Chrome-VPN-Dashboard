const Docker = require('dockerode');
const proxyInjector = require('./proxy-injector.service');
const fingerprintService = require('./fingerprint.service');
const vpnCredentials = require('./vpn-credentials.service');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const CHROME_IMAGE = 'lscr.io/linuxserver/chromium:latest';
const BRAVE_IMAGE = 'lscr.io/linuxserver/brave:latest';
const GLUETUN_IMAGE = 'qmcgaw/gluetun';

/** Resolve a imagem Docker conforme o navegador escolhido no perfil. */
function browserImage(browser) {
  return browser === 'brave' ? BRAVE_IMAGE : CHROME_IMAGE;
}

// Flags base do Chromium (headless-friendly). Preservadas pelo wrapper do LinuxServer.
const CHROME_BASE_CLI = '--no-sandbox --disable-gpu --disable-dev-shm-usage';

class DockerService {
  async listInstances() {
    try {
      const containers = await docker.listContainers({ all: true });

      // Instancias podem ser: (a) VPN -> gluetun{id} + chrome{id}
      //                     (b) Proxy -> apenas chrome{id} com proxy
      const gluetunContainers = containers.filter(c =>
        c.Names.some(n => /^\/gluetun\d+$/.test(n))
      );
      const chromeContainers = containers.filter(c =>
        c.Names.some(n => /^\/chrome\d+$/.test(n))
      );

      const idSet = new Set();
      for (const c of gluetunContainers) {
        const n = c.Names.find(nm => /^\/gluetun\d+$/.test(nm));
        idSet.add(parseInt(n.replace('/gluetun', ''), 10));
      }
      for (const c of chromeContainers) {
        const n = c.Names.find(nm => /^\/chrome\d+$/.test(nm));
        idSet.add(parseInt(n.replace('/chrome', ''), 10));
      }

      const instances = [];

      for (const id of idSet) {
        const gluetun = gluetunContainers.find(c =>
          c.Names.some(n => n === `/gluetun${id}`)
        );
        const chrome = chromeContainers.find(c =>
          c.Names.some(n => n === `/chrome${id}`)
        );

        // Tipo definido pela existencia do gluetun
        const type = gluetun ? 'vpn' : 'proxy';

        let status = 'stopped';
        if (type === 'vpn') {
          if (gluetun.State === 'running' && chrome && chrome.State === 'running') {
            status = 'running';
          } else if (gluetun.State === 'running' || (chrome && chrome.State === 'running')) {
            status = 'error';
          }
        } else {
          status = chrome && chrome.State === 'running' ? 'running' : 'stopped';
        }

        // Porta: VPN vem do binding do gluetun; proxy do binding do chrome
        let port = null;
        if (type === 'vpn' && gluetun.Ports) {
          const portBinding = gluetun.Ports.find(p => p.PrivatePort === 3000 && p.PublicPort);
          if (portBinding) port = portBinding.PublicPort;
        } else if (type === 'proxy' && chrome && chrome.Ports) {
          const portBinding = chrome.Ports.find(p => p.PrivatePort === 3000 && p.PublicPort);
          if (portBinding) port = portBinding.PublicPort;
        }

        instances.push({
          id,
          type,
          gluetunContainer: gluetun ? `gluetun${id}` : null,
          chromeContainer: `chrome${id}`,
          port: port || (parseInt(process.env.BASE_PORT || '3001', 10) + id - 1),
          subdomain: `chrome${id}.${process.env.DOMAIN || 'sakr.ath.cx'}`,
          status,
          createdAt: (gluetun || chrome).Created
            ? new Date((gluetun || chrome).Created * 1000).toISOString()
            : new Date().toISOString()
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

  async startInstance(id) {
    const chromeName = `chrome${id}`;

    // Verifica se e instancia VPN (tem gluetun) ou proxy
    let hasGluetun = false;
    let gluetun;
    try {
      gluetun = docker.getContainer(`gluetun${id}`);
      await gluetun.inspect();
      hasGluetun = true;
    } catch (err) {
      hasGluetun = false;
    }

    if (hasGluetun) {
      const gluetunInfo = await gluetun.inspect();
      if (!gluetunInfo.State.Running) {
        await this._startWithTimeout(gluetun, 30000);
        await this._sleep(2000);
      }
    }

    const chrome = docker.getContainer(chromeName);
    const chromeInfo = await chrome.inspect();
    if (!chromeInfo.State.Running) {
      await this._startWithTimeout(chrome, 30000);
    }
  }

  async stopInstance(id) {
    const gluetunName = `gluetun${id}`;
    const chromeName = `chrome${id}`;

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

  /**
   * Cria uma instancia. config.type = 'vpn' (gluetun + chrome) ou 'proxy' (só chrome).
   * Para proxy: config.proxy = { host, port, user, pass, scheme, auth }.
   */
  async createInstance(config) {
    const { id, port } = config;
    const domain = process.env.DOMAIN || 'sakr.ath.cx';
    const type = config.type === 'proxy' ? 'proxy' : 'vpn';
    // Navegador do perfil: 'chromium' (padrão) ou 'brave'.
    config.browser = config.browser === 'brave' ? 'brave' : 'chromium';

    await this._pullImage(browserImage(config.browser));

    if (type === 'proxy') {
      return this._createProxyInstance(config);
    }
    return this._createVpnInstance(config);
  }

  async _createVpnInstance(config) {
    const { id, port } = config;
    const domain = process.env.DOMAIN || 'sakr.ath.cx';
    // Provedor VPN: 'surfshark' (padrão) ou 'expressvpn' — ambos usam OpenVPN no Gluetun.
    const vpnProvider = config.vpnProvider === 'expressvpn' ? 'expressvpn' : 'surfshark';
    config.vpnProvider = vpnProvider;
    const creds = vpnCredentials.getEffective(vpnProvider);
    const openvpnUser = config.openvpnUser || creds.user;
    const openvpnPassword = config.openvpnPassword || creds.pass;
    if (!openvpnUser || !openvpnPassword) {
      throw Object.assign(
        new Error(`Credenciais do ${vpnProvider} não configuradas. Salve-as em "Credenciais VPN"`),
        { status: 400 }
      );
    }
    const fingerprint = config.fingerprint || null;
    // Navegador: Brave lê flags em BRAVE_CLI; Chromium em CHROME_CLI.
    const browser = config.browser === 'brave' ? 'brave' : 'chromium';
    const cliEnvVar = browser === 'brave' ? 'BRAVE_CLI' : 'CHROME_CLI';
    const shmSize = browser === 'brave' ? 1073741824 : 536870912; // Brave recomenda 1gb

    // Fingerprint por perfil (estilo GoLogin): carrega a extensão injetada
    // em /config/fp-extension no --load-extension do Chromium.
    const chromeCli = fingerprint
      ? `${CHROME_BASE_CLI} --load-extension=${fingerprintService.CONTAINER_EXT_PATH}`
      : CHROME_BASE_CLI;

    await this._pullImage(GLUETUN_IMAGE);

    const gluetunContainer = await docker.createContainer({
      Image: GLUETUN_IMAGE,
      name: `gluetun${id}`,
      Env: [
        'VPN_SERVICE_PROVIDER=' + vpnProvider,
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

    try {
      const chromeContainer = await docker.createContainer({
        Image: browserImage(browser),
        name: `chrome${id}`,
        Env: [
          'PUID=1000',
          'PGID=1000',
          'TZ=Etc/UTC',
          `${cliEnvVar}=${chromeCli}`
        ],
        HostConfig: {
          NetworkMode: `container:gluetun${id}`,
          ShmSize: shmSize,
          RestartPolicy: { Name: 'unless-stopped' }
        }
        // Nota: sem ExposedPorts aqui — o Chrome compartilha o namespace de
        // rede do gluetun (que já publica a porta 3000). Declarar ExposedPorts
        // junto com NetworkMode de tipo "container:" é rejeitado pelo Docker.
      });

      // Injeta a extensão de fingerprint (putArchive funciona com container
      // parado) ANTES de qualquer start — a extensão fica persistida no perfil.
      if (fingerprint) {
        try {
          await fingerprintService.inject(`chrome${id}`, fingerprint);
          console.log(`[INFO] [fingerprint] Extensao injetada em chrome${id} (seed=${fingerprint.seed})`);
        } catch (err) {
          // Nao derruba a criacao: a instancia funciona sem fingerprint.
          console.warn(`[WARN] [fingerprint] Falha ao injetar em chrome${id}:`, err.message);
        }
      }

      return {
        id,
        type: 'vpn',
        vpnProvider,
        browser,
        gluetunContainer: `gluetun${id}`,
        chromeContainer: `chrome${id}`,
        port,
        subdomain: `chrome${id}.${domain}`,
        status: 'stopped',
        createdAt: new Date().toISOString()
      };
    } catch (err) {
      try {
        await gluetunContainer.remove({ force: true });
      } catch (removeErr) {
        console.error('[ERROR] Rollback falhou ao remover gluetun:', removeErr.message);
      }
      throw err;
    }
  }

  async _createProxyInstance(config) {
    const { id, port } = config;
    const domain = process.env.DOMAIN || 'sakr.ath.cx';
    const proxy = config.proxy || {};
    const auth = !!(proxy.auth && proxy.user && proxy.pass);
    const scheme = proxy.scheme || 'http';
    const fingerprint = config.fingerprint || null;
    // Navegador: Brave lê flags em BRAVE_CLI; Chromium em CHROME_CLI.
    const browser = config.browser === 'brave' ? 'brave' : 'chromium';
    const cliEnvVar = browser === 'brave' ? 'BRAVE_CLI' : 'CHROME_CLI';
    const shmSize = browser === 'brave' ? 1073741824 : 536870912; // Brave recomenda 1gb
    const fpFlag = fingerprint
      ? ` --load-extension=${fingerprintService.CONTAINER_EXT_PATH}`
      : '';

    // ExtraHosts garante que o container resolva host.docker.internal -> gateway,
    // alcançando o forwarder que roda no processo do dashboard.
    const extraHosts = ['host.docker.internal:host-gateway'];
    let cli;

    if (auth) {
      // Modo autenticado: o Chrome aponta para o forwarder local SEM auth,
      // que injeta Proxy-Authorization e repassa ao upstream real.
      const forwarderPort = proxyInjector.getPort(id);
      cli = `${CHROME_BASE_CLI} --proxy-server=http://host.docker.internal:${forwarderPort}${fpFlag}`;
    } else {
      // Modo normal: o próprio Chrome fala direto com o proxy upstream.
      cli = `${CHROME_BASE_CLI} --proxy-server=${scheme}://${proxy.host}:${proxy.port}${fpFlag}`;
    }

    const chromeContainer = await docker.createContainer({
      Image: browserImage(browser),
      name: `chrome${id}`,
      Env: [
        'PUID=1000',
        'PGID=1000',
        'TZ=Etc/UTC',
        `${cliEnvVar}=${cli}`
      ],
      HostConfig: {
        PortBindings: {
          '3000/tcp': [{ HostPort: String(port) }]
        },
        ExtraHosts: extraHosts,
        ShmSize: shmSize,
        RestartPolicy: { Name: 'unless-stopped' }
      },
      ExposedPorts: { '3000/tcp': {} }
    });

    // Injeta a extensão de fingerprint (putArchive funciona com container parado).
    if (fingerprint) {
      try {
        await fingerprintService.inject(`chrome${id}`, fingerprint);
        console.log(`[INFO] [fingerprint] Extensao injetada em chrome${id} (seed=${fingerprint.seed})`);
      } catch (err) {
        console.warn(`[WARN] [fingerprint] Falha ao injetar em chrome${id}:`, err.message);
      }
    }

    // No modo autenticado, sobe o forwarder local agora (antes do start) para
    // que o Chrome já encontre o injetor ativo ao iniciar.
    if (auth) {
      try {
        await proxyInjector.start(id, {
          host: proxy.host,
          port: proxy.port,
          user: proxy.user,
          pass: proxy.pass,
          scheme
        });
        console.log(`[INFO] [proxy] Forwarder de autenticação ativo para chrome${id}`);
      } catch (err) {
        console.error(`[ERROR] [proxy] Falha ao iniciar forwarder de chrome${id}:`, err.message);
        try { await chromeContainer.remove({ force: true }); } catch (_) { /* ignore */ }
        throw Object.assign(new Error('Falha ao preparar proxy autenticado'), { status: 500 });
      }
    }

    return {
      id,
      type: 'proxy',
      browser,
      auth,
      gluetunContainer: null,
      chromeContainer: `chrome${id}`,
      port,
      subdomain: `chrome${id}.${domain}`,
      status: 'stopped',
      createdAt: new Date().toISOString()
    };
  }

  async removeInstance(id) {
    const gluetunName = `gluetun${id}`;
    const chromeName = `chrome${id}`;

    try {
      const chrome = docker.getContainer(chromeName);
      await chrome.remove({ force: true });
    } catch (err) {
      if (err.statusCode !== 404) {
        console.warn(`[WARN] Erro ao remover ${chromeName}:`, err.message);
      }
    }

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
        try {
          await container.kill();
        } catch (killErr) {
          // Ignore
        }
      } else if (err.statusCode !== 304) {
        throw err;
      }
    }
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = new DockerService();