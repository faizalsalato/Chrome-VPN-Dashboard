/**
 * GluetunContainerService
 *
 * Container do túnel VPN (Gluetun). O Chrome entra no namespace de rede deste
 * container, então o IP de saída do perfil é o do provedor VPN escolhido.
 */
const Docker = require('dockerode');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const GLUETUN_IMAGE = 'qmcgaw/gluetun';
const DISPLAY_PORT = '3000/tcp';
const START_TIMEOUT = 30000;
const STOP_TIMEOUT = 15000;

/**
 * Nomes de país que cada provedor espera no `SERVER_COUNTRIES`.
 *
 * O dashboard fala sempre o nome "de gente" (United States, United Kingdom),
 * mas o gluetun repassa a string ao provedor — e alguns provedores usam outros
 * nomes. Na ExpressVPN a lista é diferente: «United States» é recusado com
 * "the country specified is not valid" e o túnel **nem arranca** (o container
 * fica em ciclo de erro, e a instância parece "não conectar"). Os nomes certos
 * lá são `USA`, `UK` e `India (via UK)`.
 *
 * A chave é o nome usado pelo dashboard; o valor, o que o provedor espera.
 */
const PROVIDER_COUNTRY_ALIASES = {
  expressvpn: {
    'United States': 'USA',
    'United Kingdom': 'UK',
    India: 'India (via UK)'
  }
};

class GluetunContainerService {
  /**
   * País no nome que o provedor entende. Sem alias, o nome segue como está
   * (Surfshark, por exemplo, usa os mesmos nomes do dashboard).
   */
  serverCountry(provider, country) {
    const wanted = String(country || '').trim() || 'United States';
    const aliases = PROVIDER_COUNTRY_ALIASES[provider] || {};
    return aliases[wanted] || wanted;
  }
  /**
   * @param {object} config
   *   id, port, vpnProvider, openvpnUser, openvpnPassword, serverCountries.
   */
  buildCreateOptions(config) {
    return {
      Image: GLUETUN_IMAGE,
      name: `gluetun${config.id}`,
      Env: [
        `VPN_SERVICE_PROVIDER=${config.vpnProvider}`,
        'VPN_TYPE=openvpn',
        `OPENVPN_USER=${config.openvpnUser}`,
        `OPENVPN_PASSWORD=${config.openvpnPassword}`,
        `SERVER_COUNTRIES=${this.serverCountry(config.vpnProvider, config.serverCountries)}`
      ],
      HostConfig: {
        CapAdd: ['NET_ADMIN'],
        PortBindings: {
          [config.displayPort || DISPLAY_PORT]: [{ HostPort: String(config.port) }]
        },
        RestartPolicy: { Name: 'unless-stopped' }
      }
    };
  }

  async create(config) {
    return docker.createContainer(this.buildCreateOptions(config));
  }

  async remove(id) {
    const container = docker.getContainer(`gluetun${id}`);
    try {
      await container.remove({ force: true });
    } catch (err) {
      if (err.statusCode !== 404) throw err;
    }
  }

  async inspect(id) {
    try {
      return await docker.getContainer(`gluetun${id}`).inspect();
    } catch (err) {
      if (err.statusCode === 404) return null;
      throw err;
    }
  }

  async exists(id) {
    return (await this.inspect(id)) !== null;
  }

  async isRunning(id) {
    const info = await this.inspect(id);
    return !!(info && info.State && info.State.Running);
  }

  /** Inicia o container do túnel se estiver parado e espera ele subir. */
  async start(id) {
    const info = await this.inspect(id);
    if (!info) {
      throw Object.assign(new Error(`Container gluetun${id} não encontrado`), { statusCode: 404 });
    }
    if (info.State && info.State.Running) return false;

    const container = docker.getContainer(`gluetun${id}`);
    await Promise.race([
      container.start(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timeout ao iniciar o gluetun')), START_TIMEOUT)
      )
    ]);
    return true;
  }

  async stop(id) {
    const info = await this.inspect(id);
    if (!info || !info.State || !info.State.Running) return false;

    const container = docker.getContainer(`gluetun${id}`);
    try {
      await Promise.race([
        container.stop({ t: Math.floor(STOP_TIMEOUT / 1000) }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout ao parar o gluetun')), STOP_TIMEOUT)
        )
      ]);
    } catch (err) {
      if (err.statusCode !== 304) throw err;
    }
    return true;
  }
}

module.exports = new GluetunContainerService();
module.exports.GLUETUN_IMAGE = GLUETUN_IMAGE;
module.exports.PROVIDER_COUNTRY_ALIASES = PROVIDER_COUNTRY_ALIASES;
