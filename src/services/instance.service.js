const dockerService = require('./docker.service');
const nginxService = require('./nginx.service');
const vpnService = require('./vpn.service');
const proxyInjector = require('./proxy-injector.service');
const fingerprintService = require('./fingerprint.service');
const { getDb } = require('../database');

const BASE_PORT = parseInt(process.env.BASE_PORT || '3001', 10);
const MAX_INSTANCES = parseInt(process.env.MAX_INSTANCES || '20', 10);
const DOMAIN = process.env.DOMAIN || 'sakr.ath.cx';

class InstanceService {
  async getAll() {
    let dockerConnected = true;
    let instances = [];

    try {
      instances = await dockerService.listInstances();
    } catch (err) {
      dockerConnected = false;
      console.error('[ERROR] [instance-service] Docker inacessível:', err.message);
    }

    // Busca metadados persistidos (tipo + proxy) do banco
    let dbMeta = {};
    try {
      const db = getDb();
      const rows = db.prepare('SELECT id, type, proxy_host, proxy_port, proxy_user, proxy_scheme, proxy_auth, fingerprint, browser, vpn_provider FROM instances').all();
      for (const r of rows) {
        dbMeta[r.id] = r;
      }
    } catch (err) {
      // Banco pode não estar pronto; segue só com dados do Docker
    }

    // Enrich running instances with VPN info
    const enriched = await Promise.all(
      instances.map(async (instance) => {
        const meta = dbMeta[instance.id];
        const type = instance.type || (meta && meta.type) || 'vpn';
        let vpnInfo = null;
        let healthStatus = {
          gluetun: 'unknown',
          chrome: 'unknown'
        };

        if (instance.status === 'running') {
          if (type === 'vpn' && instance.gluetunContainer) {
            try {
              vpnInfo = await vpnService.getVPNStatus(instance.gluetunContainer);
            } catch (err) {
              vpnInfo = { publicIP: null, country: null, connected: false, lastChecked: new Date().toISOString() };
            }
            healthStatus.gluetun = await dockerService.getContainerHealth(instance.gluetunContainer);
          }
          healthStatus.chrome = await dockerService.getContainerHealth(instance.chromeContainer);
        } else {
          healthStatus.gluetun = instance.status === 'stopped' ? 'stopped' : 'unknown';
          healthStatus.chrome = instance.status === 'stopped' ? 'stopped' : 'unknown';
        }

        const proxyInfo = type === 'proxy' && meta
          ? {
              host: meta.proxy_host,
              port: meta.proxy_port,
              user: meta.proxy_user,
              scheme: meta.proxy_scheme || 'http',
              auth: !!meta.proxy_auth
            }
          : null;

        let fingerprintInfo = null;
        if (meta && meta.fingerprint) {
          try { fingerprintInfo = JSON.parse(meta.fingerprint); } catch (_) { /* ignore */ }
        }

        return {
          ...instance,
          type,
          browser: (meta && meta.browser) || instance.browser || 'chromium',
          vpnProvider: (meta && meta.vpn_provider) || instance.vpnProvider || 'surfshark',
          proxyInfo,
          fingerprint: fingerprintInfo,
          vpnInfo,
          healthStatus
        };
      })
    );

    return {
      instances: enriched,
      dockerConnected,
      lastUpdated: new Date().toISOString()
    };
  }

  async create(options = {}) {
    const { country, type = 'vpn', proxy } = options;
    const browser = options.browser === 'brave' ? 'brave' : 'chromium';
    // Provedor VPN: 'surfshark' (padrão) ou 'expressvpn'.
    const vpnProvider = options.vpnProvider === 'expressvpn' ? 'expressvpn' : 'surfshark';
    const port = await this.getNextAvailablePort();
    const id = port - BASE_PORT + 1;

    const config = {
      id,
      port,
      domain: DOMAIN,
      type,
      browser
    };

    if (type === 'proxy') {
      config.proxy = {
        host: proxy.host,
        port: proxy.port,
        user: proxy.user || '',
        pass: proxy.pass || '',
        scheme: proxy.scheme || 'http',
        auth: !!proxy.auth
      };
    } else {
      // Provedor + credenciais pelo banco (fallback interno no docker.service).
      config.vpnProvider = vpnProvider;
      config.vpnType = 'openvpn';
      config.serverCountries = country || 'United States';
    }

    // Fingerprint determinístico por perfil (estilo GoLogin): o mesmo id
    // sempre gera a mesma identidade. Um objeto parcial em options.fingerprint
    // sobrescreve campos específicos, mantendo o restante consistente.
    const fingerprint = Object.assign(
      fingerprintService.generate(`chrome${id}`),
      options.fingerprint || {}
    );
    config.fingerprint = fingerprint;

    // Step 1: Create Docker containers
    let instance;
    try {
      instance = await dockerService.createInstance(config);
    } catch (err) {
      throw new Error(`Falha ao criar containers: ${err.message}`);
    }

    // Step 2: Add Nginx server block
    try {
      await nginxService.addServerBlock(instance);
    } catch (err) {
      // Rollback: remove containers
      try {
        await dockerService.removeInstance(id);
      } catch (rollbackErr) {
        console.error('[ERROR] Rollback falhou:', rollbackErr.message);
      }
      throw new Error(`Falha ao configurar Nginx: ${err.message}`);
    }

    // Step 3: Register in database
    try {
      const db = getDb();
      db.prepare(`INSERT OR REPLACE INTO instances
        (id, port, subdomain, type, proxy_host, proxy_port, proxy_user, proxy_pass, proxy_scheme, proxy_auth, fingerprint, browser, vpn_provider)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id,
        port,
        `chrome${id}.${DOMAIN}`,
        type,
        type === 'proxy' ? config.proxy.host : null,
        type === 'proxy' ? config.proxy.port : null,
        type === 'proxy' ? config.proxy.user : null,
        type === 'proxy' ? config.proxy.pass : null,
        type === 'proxy' ? config.proxy.scheme : 'http',
        type === 'proxy' && config.proxy.auth ? 1 : 0,
        JSON.stringify(fingerprint),
        browser,
        type === 'vpn' ? vpnProvider : null
      );
    } catch (err) {
      // Rollback: remove nginx + containers
      try {
        await nginxService.removeServerBlock(id);
        await dockerService.removeInstance(id);
      } catch (rollbackErr) {
        console.error('[ERROR] Rollback falhou:', rollbackErr.message);
      }
      throw new Error(`Falha ao registrar instância: ${err.message}`);
    }

    // Step 4: Start the instance
    try {
      await dockerService.startInstance(id);
      instance.status = 'running';
    } catch (err) {
      console.warn(`[WARN] Instância criada mas não iniciada: ${err.message}`);
      instance.status = 'stopped';
    }

    console.log(`[${new Date().toISOString()}] [INFO] [instance-service] Instância ${id} criada na porta ${port}`);

    // Enriquece o retorno com proxyInfo (mesmo formato do getAll), para que o
    // frontend exiba o badge de proxy imediatamente após a criação.
    instance.browser = browser;
    instance.vpnProvider = vpnProvider;
    if (type === 'proxy' && config.proxy) {
      instance.type = 'proxy';
      instance.proxyInfo = {
        host: config.proxy.host,
        port: config.proxy.port,
        user: config.proxy.user,
        scheme: config.proxy.scheme,
        auth: config.proxy.auth
      };
    }

    return instance;
  }

  async remove(id) {
    // Libera o forwarder de proxy autenticado, se existir (evita porta órfã).
    await this._stopForwarder(id);

    // Stop and remove containers
    try {
      await dockerService.removeInstance(id);
    } catch (err) {
      console.warn(`[WARN] Erro ao remover containers da instância ${id}:`, err.message);
    }

    // Remove nginx config
    try {
      await nginxService.removeServerBlock(id);
    } catch (err) {
      console.warn(`[WARN] Erro ao remover config nginx da instância ${id}:`, err.message);
    }

    // Remove from database
    const db = getDb();
    db.prepare('DELETE FROM instances WHERE id = ?').run(id);

    console.log(`[${new Date().toISOString()}] [INFO] [instance-service] Instância ${id} removida`);
  }

  async start(id) {
    // Para proxy autenticado, garante que o forwarder local (injetor de
    // Proxy-Authorization) esteja ativo ANTES de iniciar o Chrome.
    await this._ensureForwarder(id);
    // Re-injeta a extensão de fingerprint (idempotente) antes do start.
    await this._ensureFingerprint(id);
    await dockerService.startInstance(id);
    console.log(`[${new Date().toISOString()}] [INFO] [instance-service] Instância ${id} iniciada`);
  }

  async stop(id) {
    await dockerService.stopInstance(id);
    // Libera a porta do forwarder quando a instância é parada explicitamente.
    await this._stopForwarder(id);
    console.log(`[${new Date().toISOString()}] [INFO] [instance-service] Instância ${id} parada`);
  }

  async restart(id) {
    await dockerService.stopInstance(id);
    await new Promise(resolve => setTimeout(resolve, 2000));
    await this._ensureForwarder(id);
    await this._ensureFingerprint(id);
    await dockerService.startInstance(id);
    console.log(`[${new Date().toISOString()}] [INFO] [instance-service] Instância ${id} reiniciada`);
  }

  /**
   * Re-injeta a extensão de fingerprint (com o JSON persistido no banco)
   * no container chrome. Idempotente: funciona com o container parado.
   * Falhas são apenas logadas — a instância segue funcionando sem fingerprint.
   */
  async _ensureFingerprint(id) {
    try {
      const db = getDb();
      const row = db.prepare('SELECT fingerprint FROM instances WHERE id = ?').get(id);
      if (!row || !row.fingerprint) return;
      const fingerprint = JSON.parse(row.fingerprint);
      await fingerprintService.inject(`chrome${id}`, fingerprint);
    } catch (err) {
      console.warn(`[WARN] [instance-service] Falha ao re-injetar fingerprint da instância ${id}:`, err.message);
    }
  }

  /**
   * Inicia o forwarder de autenticação de proxy (injetor local) se a instância
   * for do tipo 'proxy' com auth. Usa as credenciais persistidas no banco.
   */
  async _ensureForwarder(id) {
    try {
      const db = getDb();
      const row = db.prepare(
        'SELECT type, proxy_host, proxy_port, proxy_user, proxy_pass, proxy_scheme, proxy_auth ' +
        'FROM instances WHERE id = ?'
      ).get(id);
      if (row && row.type === 'proxy' && row.proxy_auth) {
        await proxyInjector.start(id, {
          host: row.proxy_host,
          port: row.proxy_port,
          user: row.proxy_user,
          pass: row.proxy_pass,
          scheme: row.proxy_scheme || 'http'
        });
      }
    } catch (err) {
      console.warn(`[WARN] [instance-service] Falha ao preparar forwarder da instância ${id}:`, err.message);
    }
  }

  /** Para o forwarder de proxy autenticado, se existir (idempotente). */
  async _stopForwarder(id) {
    try {
      if (proxyInjector.isRunning(id)) {
        await proxyInjector.stop(id);
      }
    } catch (err) {
      console.warn(`[WARN] [instance-service] Falha ao parar forwarder da instância ${id}:`, err.message);
    }
  }

  async changeCountry(id, country) {
    // To change country, we need to recreate the gluetun container with new env
    const db = getDb();
    const instance = db.prepare('SELECT * FROM instances WHERE id = ?').get(id);
    if (!instance) {
      throw Object.assign(new Error(`Instância ${id} não encontrada`), { status: 404 });
    }

    // Troca de país só se aplica a instâncias VPN
    if ((instance.type || 'vpn') !== 'vpn') {
      throw Object.assign(new Error('Troca de país disponível apenas para instâncias VPN'), { status: 400 });
    }

    // Stop and remove containers
    await dockerService.removeInstance(id);
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Recreate with new country
    const config = {
      id,
      port: instance.port,
      domain: DOMAIN,
      type: 'vpn',
      browser: instance.browser || 'chromium',
      vpnProvider: instance.vpn_provider || 'surfshark',
      vpnType: 'openvpn',
      serverCountries: country
    };

    await dockerService.createInstance(config);
    await dockerService.startInstance(id);
    console.log(`[${new Date().toISOString()}] [INFO] [instance-service] Instância ${id} país alterado para ${country}`);
  }

  async getVPNInfo(id) {
    const containerName = `gluetun${id}`;
    return vpnService.getVPNStatus(containerName);
  }

  async getNextAvailablePort() {
    const db = getDb();

    // Check instance count limit
    const countResult = db.prepare('SELECT COUNT(*) as count FROM instances').get();
    if (countResult.count >= MAX_INSTANCES) {
      throw Object.assign(new Error(`Limite máximo de ${MAX_INSTANCES} instâncias atingido`), { status: 400 });
    }

    // Get all used ports from database
    const usedPorts = db.prepare('SELECT port FROM instances ORDER BY port').all().map(r => r.port);

    // Also check Docker for any containers not in DB
    try {
      const dockerInstances = await dockerService.listInstances();
      for (const inst of dockerInstances) {
        if (inst.port && !usedPorts.includes(inst.port)) {
          usedPorts.push(inst.port);
        }
      }
    } catch (err) {
      // If Docker is unavailable, just use DB data
    }

    // Find smallest available port in range [BASE_PORT, BASE_PORT + 99]
    for (let port = BASE_PORT; port < BASE_PORT + 100; port++) {
      if (!usedPorts.includes(port)) {
        return port;
      }
    }

    throw Object.assign(new Error('Nenhuma porta disponível no intervalo configurado'), { status: 400 });
  }
}

module.exports = new InstanceService();
