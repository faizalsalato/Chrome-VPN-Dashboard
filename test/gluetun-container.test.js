/**
 * País no `SERVER_COUNTRIES` do gluetun.
 *
 * O dashboard fala o nome "de gente" (United States), mas quem valida é o
 * provedor: na ExpressVPN «United States» é recusado ("the country specified is
 * not valid") e o túnel nem arranca — o utilizador vê "não conecta" mesmo com
 * as credenciais certas. Estes testes fixam os nomes por provedor.
 */
const gluetunContainer = require('../src/services/gluetun-container.service');

/** `SERVER_COUNTRIES` como sai no ambiente do container. */
function serverCountries(provider, country) {
  const options = gluetunContainer.buildCreateOptions({
    id: 7, port: 4007, vpnProvider: provider, openvpnUser: 'u', openvpnPassword: 'p',
    serverCountries: country
  });
  const entry = options.Env.find((item) => item.startsWith('SERVER_COUNTRIES='));
  return entry.slice('SERVER_COUNTRIES='.length);
}

describe('gluetun — nome do país por provedor', () => {
  it('na ExpressVPN usa os nomes que ela aceita', () => {
    expect(serverCountries('expressvpn', 'United States')).toBe('USA');
    expect(serverCountries('expressvpn', 'United Kingdom')).toBe('UK');
    expect(serverCountries('expressvpn', 'India')).toBe('India (via UK)');
  });

  it('deixa passar os países que os dois usam com o mesmo nome', () => {
    for (const provider of ['expressvpn', 'surfshark']) {
      expect(serverCountries(provider, 'Germany')).toBe('Germany');
      expect(serverCountries(provider, 'Canada')).toBe('Canada');
      expect(serverCountries(provider, 'Japan')).toBe('Japan');
    }
  });

  it('não mexe nos nomes quando o provedor não tem aliases', () => {
    expect(serverCountries('surfshark', 'United States')).toBe('United States');
    expect(serverCountries('surfshark', 'United Kingdom')).toBe('United Kingdom');
  });

  it('sem país escolhido cai no padrão (também traduzido)', () => {
    expect(serverCountries('surfshark', undefined)).toBe('United States');
    expect(serverCountries('expressvpn', undefined)).toBe('USA');
    expect(serverCountries('expressvpn', '   ')).toBe('USA');
  });

  it('provedor desconhecido segue com o nome do dashboard', () => {
    expect(serverCountries('outrovpn', 'United States')).toBe('United States');
  });
});
