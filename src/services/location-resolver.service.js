/**
 * LocationResolverService
 *
 * Ponto único que responde "por onde esta conexão sai?" — seja por VPN (país
 * escolhido + geo real do túnel) ou por proxy (geolocalização do IP de saída).
 * O fingerprint do perfil usa esta resposta para alinhar idioma e fuso horário
 * com o IP que o site vai ver.
 */
const localeProfile = require('./locale-profile.service');
const vpnService = require('./vpn.service');
const proxyTester = require('./proxy-tester.service');

const VPN_WAIT_TIMEOUT = 25000;

class LocationResolverService {
  /**
   * Localização de uma instância VPN.
   * Usa a geo real do túnel quando já há IP de saída; senão cai no país
   * escolhido no perfil (com o fuso padrão do país).
   *
   * @param {string} country país pedido (nome em inglês/pt-BR ou ISO)
   * @param {string} [containerName] container do gluetun, se existir
   * @returns {Promise<object>} localização normalizada
   */
  async forVpn(country, containerName) {
    if (containerName) {
      const status = await vpnService.getVPNStatus(containerName);
      if (status.connected) return this._fromVpnStatus(status, country);
    }
    return localeProfile.fromLocation({ country, source: 'vpn-country' });
  }

  /**
   * Igual a forVpn, mas espera o túnel conectar — usado no start, quando o
   * Gluetun acabou de subir e ainda não tem IP de saída.
   */
  async forVpnConnected(country, containerName, timeoutMs = VPN_WAIT_TIMEOUT) {
    if (!containerName) return this.forVpn(country, null);

    const status = await vpnService.waitForConnection(containerName, timeoutMs);
    if (status.connected) return this._fromVpnStatus(status, country);
    return localeProfile.fromLocation({ country, source: 'vpn-country' });
  }

  _fromVpnStatus(status, fallbackCountry) {
    return localeProfile.fromLocation({
      country: status.country || fallbackCountry,
      countryCode: status.countryCode,
      city: status.city,
      region: status.region,
      timezone: status.timezone,
      ip: status.publicIP,
      source: 'vpn'
    });
  }

  /**
   * Localização de um proxy: geolocaliza o IP de saída fazendo uma requisição
   * real através dele.
   *
   * @param {object} proxy { host, port, scheme, user, pass, auth }
   * @returns {Promise<{location: object, test: object|null, error: string|null}>}
   */
  async forProxy(proxy) {
    const test = await proxyTester.test(proxy);
    if (!test.live) {
      return {
        test,
        error: test.error || 'Proxy sem geolocalização',
        location: localeProfile.fromLocation({ source: 'proxy-unknown' })
      };
    }
    return {
      test,
      error: null,
      location: localeProfile.fromLocation({
        country: test.country,
        countryCode: test.countryCode,
        city: test.city,
        region: test.region,
        timezone: test.timezone,
        ip: test.ip,
        source: 'proxy'
      })
    };
  }
}

module.exports = new LocationResolverService();
