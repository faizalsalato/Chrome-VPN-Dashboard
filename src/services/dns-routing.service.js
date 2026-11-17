const Docker = require('dockerode');
const localeProfile = require('./locale-profile.service');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// Rede onde vivem os gluetuns. O container do navegador entra nela para poder
// alcançar o resolvedor do país. Medido no servidor: sem isto, um container na
// rede `bridge` (172.17.x) não chega aos gluetuns (172.18.x) — DOCKER-ISOLATION
// bloqueia e a consulta DNS cai em timeout. Depois de `network connect`, os
// cinco resolvedores respondem.
const GLUETUN_NETWORK = process.env.GLUETUN_NETWORK || 'rotaproxy_default';

// País -> container gluetun que serve de resolvedor nesse país. Mapa medido no
// servidor com edns.ip-api.com a partir de cada túnel:
//   br-01      -> Brazil         146.70.163.206
//   gluetun-01 -> Germany         45.87.212.184
//   gluetun-02 -> Kazakhstan     217.9.250.86
//   gluetun-03 -> Hong Kong      138.199.62.5
//   gluetun-04 -> United States   92.119.177.24
// O resolvedor é o próprio IP de saída do túnel, por isso o whoer vê o mesmo
// país no IP e no DNS. Isto é o que faltava no modo proxy: o DNS aparecia
// normal no modo VPN (o container já partilha o namespace do gluetun), mas no
// modo proxy o Firefox usava o resolvedor do proxy, noutro país, e a nota
// caía para 70%.
const COUNTRY_GLUETUN = {
  BR: 'br-01',
  DE: 'gluetun-01',
  KZ: 'gluetun-02',
  HK: 'gluetun-03',
  US: 'gluetun-04'
};

// Cache do IP interno por nome de container. O IP muda se o gluetun for
// recriado; a entrada expira para não ficar presa a um endereço antigo.
const ipCache = new Map();
const CACHE_MS = 60 * 1000;

/**
 * DnsRoutingService
 *
 * Escolhe o resolvedor do país da instância e configura o container do
 * navegador para o usar. Só faz sentido com resolução local (SOCKS5 no Firefox,
 * UseProxyForDNS: false): com proxy HTTP o navegador entrega o nome ao proxy e
 * nunca consulta o resolvedor local.
 */
class DnsRoutingService {
  /** ISO-3166 alpha-2 do país a partir de nome, código ou objeto de geo. */
  countryCodeOf(country) {
    if (!country) return null;
    if (typeof country === 'object') {
      return this.countryCodeOf(country.countryCode || country.country_code || country.country);
    }
    const raw = String(country).trim();
    if (/^[A-Za-z]{2}$/.test(raw)) return raw.toUpperCase();
    // Reutiliza a tabela de apelidos do locale-profile (brasil, alemanha, ...).
    const code = localeProfile.resolveCountryCode(raw);
    return code ? String(code).toUpperCase() : null;
  }

  /** Nome do container gluetun que serve o país, ou null se não houver mapeamento. */
  gluetunFor(country) {
    const code = this.countryCodeOf(country);
    return code ? (COUNTRY_GLUETUN[code] || null) : null;
  }

  /**
   * Endereço interno (IP na rede dos gluetuns) do gluetun de um país.
   * Assíncrono porque consulta o Docker; o resultado fica em cache curto para
   * que os chamadores síncronos possam reutilizá-lo depois de uma primeira
   * resolução no arranque da instância.
   */
  async resolverFor(country) {
    const name = this.gluetunFor(country);
    if (!name) return null;

    const cached = ipCache.get(name);
    if (cached && Date.now() - cached.at < CACHE_MS) {
      return { name, ip: cached.ip, country: this.countryCodeOf(country) };
    }

    try {
      const info = await docker.getContainer(name).inspect();
      if (!info.State || !info.State.Running) return null;
      const networks = info.NetworkSettings.Networks || {};
      const net = networks[GLUETUN_NETWORK] || Object.values(networks)[0];
      const ip = net && net.IPAddress;
      if (!ip) return null;
      ipCache.set(name, { ip, at: Date.now() });
      return { name, ip, country: this.countryCodeOf(country) };
    } catch (_) {
      return null;
    }
  }

  /**
   * Resolve e guarda em cache o resolvedor do país antes da criação do
   * container. Chamado no arranque da instância, onde já há await.
   */
  async prepare(country) {
    const resolver = await this.resolverFor(country);
    if (!resolver) return null;
    ipCache.set(resolver.name, { ip: resolver.ip, at: Date.now() });
    return resolver;
  }

  /**
   * Config síncrona para o `HostConfig` do container. Só devolve algo se o
   * resolvedor já tiver sido preparado (cache), para manter `matchesSpec`
   * determinístico e sem chamadas ao Docker.
   */
  configFor(country) {
    const name = this.gluetunFor(country);
    if (!name) return { dns: [], network: null, resolver: null };
    const cached = ipCache.get(name);
    if (!cached) return { dns: [], network: null, resolver: null };
    return {
      dns: [cached.ip],
      network: GLUETUN_NETWORK,
      resolver: { name, ip: cached.ip, country: this.countryCodeOf(country) }
    };
  }

  /**
   * Garante que o container do navegador consegue chegar ao resolvedor.
   * O `Dns` de um container em execução não muda: é preciso recriar. Este
   * método só liga à rede; o Dns vai no HostConfig na criação.
   */
  async ensureNetwork(containerName) {
    try {
      const info = await docker.getContainer(containerName).inspect();
      const networks = info.NetworkSettings.Networks || {};
      if (networks[GLUETUN_NETWORK]) return { connected: true, already: true };
      await docker.getNetwork(GLUETUN_NETWORK).connect({ Container: containerName });
      return { connected: true, already: false };
    } catch (err) {
      return { connected: false, error: err.message };
    }
  }
}

module.exports = new DnsRoutingService();
module.exports.COUNTRY_GLUETUN = COUNTRY_GLUETUN;
module.exports.GLUETUN_NETWORK = GLUETUN_NETWORK;
