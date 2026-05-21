const dockerService = require('./docker.service');
const nginxService = require('./nginx.service');
const vpnService = require('./vpn.service');
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

    // Enrich running instances with VPN info
    const enriched = await Promise.all(
      instances.map(async (instance) => {
        let vpnInfo = null;
        let healthStatus = {
          gluetun: 'unknown',
          chrome: 'unknown'
        };

        if (instance.status === 'running') {
          try {
            vpnInfo = await vpnService.getVPNStatus(instance.gluetunContainer);
          } catch (err) {
            vpnInfo = { publicIP: null, country: null, connected: false, lastChecked: new Date().toISOString() };
          }

          healthStatus.gluetun = await dockerService.getContainerHealth(instance.gluetunContainer);
          healthStatus.chrome = await dockerService.getContainerHealth(instance.chromeContainer);
        } else {
          healthStatus.gluetun = instance.status === 'stopped' ? 'stopped' : 'unknown';
          healthStatus.chrome = instance.status === 'stopped' ? 'stopped' : 'unknown';
        }

        return {
          ...instance,
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

  async create(country) {
    const port = await this.getNextAvailablePort();
    const id = port - BASE_PORT + 1;

    const config = {
      id,
      port,
      domain: DOMAIN,
      vpnProvider: 'surfshark',
      vpnType: 'openvpn',
      serverCountries: country || 'United States',
      openvpnUser: 'G9t9Fr7L67MT9Qg7AuV6P6PH',
      openvpnPassword: 'aemT8ba6Tm3DqKta8B9qtuVK'
    };

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
      db.prepare('INSERT OR REPLACE INTO instances (id, port, subdomain) VALUES (?, ?, ?)').run(
        id, port, `chrome${id}.${DOMAIN}`
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
    return instance;
  }

  async remove(id) {
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
    await dockerService.startInstance(id);
    console.log(`[${new Date().toISOString()}] [INFO] [instance-service] Instância ${id} iniciada`);
  }

  async stop(id) {
    await dockerService.stopInstance(id);
    console.log(`[${new Date().toISOString()}] [INFO] [instance-service] Instância ${id} parada`);
  }

  async restart(id) {
    await dockerService.stopInstance(id);
    await new Promise(resolve => setTimeout(resolve, 2000));
    await dockerService.startInstance(id);
    console.log(`[${new Date().toISOString()}] [INFO] [instance-service] Instância ${id} reiniciada`);
  }

  async changeCountry(id, country) {
    // To change country, we need to recreate the gluetun container with new env
    const db = getDb();
    const instance = db.prepare('SELECT * FROM instances WHERE id = ?').get(id);
    if (!instance) {
      throw Object.assign(new Error(`Instância ${id} não encontrada`), { status: 404 });
    }

    // Stop and remove containers
    await dockerService.removeInstance(id);
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Recreate with new country
    const config = {
      id,
      port: instance.port,
      domain: DOMAIN,
      vpnProvider: 'surfshark',
      vpnType: 'openvpn',
      serverCountries: country,
      openvpnUser: 'G9t9Fr7L67MT9Qg7AuV6P6PH',
      openvpnPassword: 'aemT8ba6Tm3DqKta8B9qtuVK'
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
