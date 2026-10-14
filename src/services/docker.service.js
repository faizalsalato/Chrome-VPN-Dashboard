/**
 * DockerService
 *
 * Ciclo de vida dos containers das instâncias: criar, iniciar, parar, remover
 * e reconciliar. A montagem da spec de cada container fica em
 * chrome-container.service.js / gluetun-container.service.js, e a descoberta
 * das instâncias em instance-discovery.service.js.
 */
const Docker = require('dockerode');
const proxyInjector = require('./proxy-injector.service');
const fingerprintService = require('./fingerprint.service');
const chromeContainer = require('./chrome-container.service');
const gluetunContainer = require('./gluetun-container.service');
const cloakbrowser = require('./cloakbrowser.service');
const browserImage = require('./browser-image.service');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const START_TIMEOUT = 30000;
const STOP_TIMEOUT = 15000;

function normalizeType(config) {
  return config.type === 'proxy' ? 'proxy' : 'vpn';
}

class DockerService {
  /**
   * Config do container do Chrome a partir da config de instância.
   * O forwarder de proxy autenticado roda no processo do dashboard, então a
   * porta dele é derivada do id da instância.
   */
  chromeConfig(config) {
    const type = normalizeType(config);
    const browser = chromeContainer.normalizeBrowser(config.browser);
    const isCloak = cloakbrowser.isCloakBrowser(browser);
    const proxy = type === 'proxy' ? config.proxy || null : null;
    return {
      id: config.id,
      port: config.port,
      type,
      browser,
      fingerprint: config.fingerprint || null,
      gluetunName: `gluetun${config.id}`,
      proxy,
      // O CloakBrowser aceita usuário:senha na própria URL do proxy; o forwarder
      // só existe porque o Chrome não aceita credenciais na flag.
      forwarderPort: proxy && proxy.auth && !isCloak ? proxyInjector.getPort(config.id) : null,
      // Porta interna do navegador (9223 no CloakBrowser: o roteador que serve
      // CDP e tela) — é a que o gluetun publica no modo VPN.
      displayPort: chromeContainer.internalPortFor(browser),
      isCloak
    };
  }

  /**
   * Garante que o container do Chrome existe com a spec do perfil atual
   * (TZ/idioma/imagem/rede), recriando quando necessário. Recriar apaga o
   * /config do perfil — re-injete o fingerprint depois.
   */
  async ensureChromeContainer(config) {
    return chromeContainer.ensure(this.chromeConfig(config));
  }

  /**
   * Recria apenas o container do navegador, mantendo o túnel de pé (o IP de
   * saída não muda). Usado quando o perfil passou a apontar outro fuso/idioma
   * e ainda não há sessão do usuário para preservar.
   */
  async recreateChromeContainer(config) {
    await chromeContainer.remove(config.id);
    return chromeContainer.ensure(this.chromeConfig(config));
  }

  /**
   * Garante a imagem do navegador antes de criar o container.
   *
   * O CloakBrowser usa uma imagem LOCAL (`browserImage.image()`): a oficial
   * mais o patch que troca o Xvfb pelo KasmVNC no tamanho de tela do perfil.
   * Ela não está em registry nenhum — sai da imagem oficial (baixada aqui) e é
   * construída localmente. Baixar pelo nome derivado falharia sempre.
   */
  async ensureBrowserImage(browser) {
    if (cloakbrowser.isCloakBrowser(browser)) {
      await this._pullImage(cloakbrowser.baseImage());
      return browserImage.ensureImage();
    }
    return this._pullImage(chromeContainer.imageFor(browser));
  }

  /** Sobe o container do túnel (se existir e estiver parado). */
  async startVpnContainer(id) {
    if (!(await gluetunContainer.exists(id))) return false;
    const started = await gluetunContainer.start(id);
    if (started) await this._sleep(2000);
    return started;
  }

  /**
   * Portas publicadas por QUALQUER container do host (inclusive de outros
   * apps). O dashboard só conhece as portas das próprias instâncias, então sem
   * esta lista ele pode escolher uma porta já ocupada e o Docker falha ao subir
   * o container ("address already in use").
   *
   * @param {object} [client] cliente dockerode (injetável nos testes)
   * @returns {Promise<Set<number>>}
   */
  async listPublishedPorts(client = docker) {
    try {
      const containers = await client.listContainers({ all: true });
      const ports = new Set();
      for (const container of containers) {
        for (const mapping of container.Ports || []) {
          if (mapping.PublicPort) ports.add(mapping.PublicPort);
        }
      }
      return ports;
    } catch (err) {
      // Sem Docker não há como saber; quem chama decide o que fazer.
      return new Set();
    }
  }

  /** O container do Chrome já está rodando? */
  async isChromeRunning(id) {
    try {
      const info = await docker.getContainer(`chrome${id}`).inspect();
      return !!(info.State && info.State.Running);
    } catch (err) {
      return false;
    }
  }

  /** País pedido ao túnel (SERVER_COUNTRIES do container do gluetun). */
  async getVpnCountry(id) {
    const info = await gluetunContainer.inspect(id);
    if (!info) return null;
    const entry = (info.Config.Env || []).find((item) => item.startsWith('SERVER_COUNTRIES='));
    return entry ? entry.slice('SERVER_COUNTRIES='.length) : null;
  }

  async startInstance(id) {
    await this.startVpnContainer(id);

    const chrome = docker.getContainer(`chrome${id}`);
    const chromeInfo = await chrome.inspect();
    if (!chromeInfo.State.Running) {
      await this._startWithTimeout(chrome, START_TIMEOUT);
    }
  }

  async stopInstance(id) {
    try {
      const chrome = docker.getContainer(`chrome${id}`);
      const chromeInfo = await chrome.inspect();
      if (chromeInfo.State.Running) {
        await this._stopWithTimeout(chrome, STOP_TIMEOUT);
      }
    } catch (err) {
      if (err.statusCode !== 404) {
        console.warn(`[WARN] Erro ao parar chrome${id}:`, err.message);
      }
    }

    try {
      await gluetunContainer.stop(id);
    } catch (err) {
      console.warn(`[WARN] Erro ao parar gluetun${id}:`, err.message);
    }
  }

  /**
   * Cria uma instância. config.type = 'vpn' (gluetun + chrome) ou 'proxy'
   * (só chrome). Para proxy: config.proxy = { host, port, user, pass, scheme, auth }.
   */
  async createInstance(config) {
    config.browser = chromeContainer.normalizeBrowser(config.browser);
    await this.ensureBrowserImage(config.browser);

    if (normalizeType(config) === 'proxy') {
      return this._createProxyInstance(config);
    }
    return this._createVpnInstance(config);
  }

  async _createVpnInstance(config) {
    const id = config.id;
    const domain = process.env.DOMAIN || 'sakr.ath.cx';
    const vpnProvider = config.vpnProvider === 'expressvpn' ? 'expressvpn' : 'surfshark';
    const credentials = require('./vpn-credentials.service').getEffective(vpnProvider);
    const openvpnUser = config.openvpnUser || credentials.user;
    const openvpnPassword = config.openvpnPassword || credentials.pass;

    if (!openvpnUser || !openvpnPassword) {
      throw Object.assign(
        new Error(`Credenciais do ${vpnProvider} não configuradas. Salve-as em "Credenciais VPN"`),
        { status: 400 }
      );
    }

    await this._pullImage(gluetunContainer.GLUETUN_IMAGE);

    const gluetun = await gluetunContainer.create({
      id,
      port: config.port,
      vpnProvider,
      openvpnUser,
      openvpnPassword,
      serverCountries: config.serverCountries || 'United States',
      displayPort: chromeContainer.internalPortFor(config.browser)
    });

    try {
      await chromeContainer.create(this.chromeConfig(config));

      // Injeta a extensão de fingerprint (putArchive funciona com o container
      // parado) ANTES de qualquer start — a extensão fica persistida no perfil.
      // O CloakBrowser não usa extensão: o stealth dele é compilado no binário.
      if (!cloakbrowser.isCloakBrowser(config.browser)) {
        await this._injectFingerprint(id, config.fingerprint);
      }

      return {
        id,
        type: 'vpn',
        vpnProvider,
        browser: config.browser,
        gluetunContainer: `gluetun${id}`,
        chromeContainer: `chrome${id}`,
        port: config.port,
        subdomain: `chrome${id}.${domain}`,
        status: 'stopped',
        createdAt: new Date().toISOString()
      };
    } catch (err) {
      try {
        await gluetun.remove({ force: true });
      } catch (removeErr) {
        console.error('[ERROR] Rollback falhou ao remover gluetun:', removeErr.message);
      }
      throw err;
    }
  }

  async _createProxyInstance(config) {
    const id = config.id;
    const domain = process.env.DOMAIN || 'sakr.ath.cx';
    const proxy = config.proxy || {};
    const auth = !!(proxy.auth && proxy.user && proxy.pass);
    config.proxy = Object.assign({}, proxy, { auth });

    const isCloak = cloakbrowser.isCloakBrowser(config.browser);
    await chromeContainer.create(this.chromeConfig(config));

    // O CloakBrowser traz a impressão digital no binário: nada de extensão.
    if (!isCloak) await this._injectFingerprint(id, config.fingerprint);

    // No modo autenticado, sobe o forwarder local agora (antes do start) para
    // que o Chrome já encontre o injetor ativo ao iniciar. O CloakBrowser não
    // precisa dele: as credenciais vão na própria URL do proxy.
    if (auth && !isCloak) {
      try {
        await proxyInjector.start(id, {
          host: proxy.host,
          port: proxy.port,
          user: proxy.user,
          pass: proxy.pass,
          scheme: proxy.scheme || 'http'
        });
        console.log(`[INFO] [proxy] Forwarder de autenticação ativo para chrome${id}`);
      } catch (err) {
        console.error(`[ERROR] [proxy] Falha ao iniciar forwarder de chrome${id}:`, err.message);
        await chromeContainer.remove(id).catch(() => { /* ignore */ });
        throw Object.assign(new Error('Falha ao preparar proxy autenticado'), { status: 500 });
      }
    }

    return {
      id,
      type: 'proxy',
      browser: config.browser,
      auth,
      gluetunContainer: null,
      chromeContainer: `chrome${id}`,
      port: config.port,
      subdomain: `chrome${id}.${domain}`,
      status: 'stopped',
      createdAt: new Date().toISOString()
    };
  }

  /**
   * Remove os CONTAINERS de uma instância preservando o volume do perfil.
   *
   * É o que a troca de país/proxy precisa: os containers são refeitos do zero
   * (comando, ambiente, rede), mas a sessão do usuário — cookies, login — fica.
   * `removeInstance` apaga o volume e serve só para REMOVER a instância.
   */
  async removeContainers(id) {
    try {
      await chromeContainer.remove(id);
    } catch (err) {
      console.warn(`[WARN] Erro ao remover chrome${id}:`, err.message);
    }

    try {
      await gluetunContainer.remove(id);
    } catch (err) {
      console.warn(`[WARN] Erro ao remover gluetun${id}:`, err.message);
    }
  }

  async removeInstance(id) {
    await this.removeContainers(id);

    // O perfil (cookies/login) morre junto com a instância.
    try {
      await chromeContainer.removeProfileVolume(id);
    } catch (err) {
      console.warn(`[WARN] Erro ao remover o volume do perfil ${id}:`, err.message);
    }
  }

  async getContainerHealth(name) {
    try {
      const info = await docker.getContainer(name).inspect();
      if (!info.State.Running) return 'stopped';
      if (info.State.Health) {
        return info.State.Health.Status === 'healthy' ? 'running' : 'unhealthy';
      }
      return 'running';
    } catch (err) {
      return 'unknown';
    }
  }

  /** Injeta a extensão de fingerprint, sem derrubar a criação se falhar. */
  async _injectFingerprint(id, fingerprint) {
    if (!fingerprint) return;
    try {
      await fingerprintService.inject(`chrome${id}`, fingerprint);
      console.log(`[INFO] [fingerprint] Extensao injetada em chrome${id} (seed=${fingerprint.seed})`);
    } catch (err) {
      console.warn(`[WARN] [fingerprint] Falha ao injetar em chrome${id}:`, err.message);
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
          docker.modem.followProgress(stream, (pullErr, output) => {
            if (pullErr) reject(pullErr);
            else resolve(output);
          });
        });
        console.log(`[INFO] Imagem ${imageName} baixada com sucesso`);
      } else {
        throw err;
      }
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
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = new DockerService();
