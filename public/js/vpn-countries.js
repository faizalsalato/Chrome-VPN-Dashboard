/**
 * Países que o gluetun aceita, por provedor de VPN.
 *
 * Por que existe: cada provedor tem a sua lista e os nomes variam — a ExpressVPN
 * chama «USA» aos Estados Unidos, «UK» ao Reino Unido e «India (via UK)» à
 * Índia, enquanto a Surfshark usa «United States»/«United Kingdom»/«India». Com
 * uma lista única era preciso traduzir nomes e ficavam de fora países que o
 * provedor tem.
 *
 * As listas saíram do PRÓPRIO gluetun: quando recebe um país inválido ele
 * responde com as opções aceites. A ordem e a grafia são as dele — incluindo
 * «Marocco» (grafia do gluetun para Marrocos), que é o que ele aceita.
 */
const VpnCountries = {
  surfshark: [
    'Albania', 'Algeria', 'Andorra', 'Argentina', 'Armenia', 'Australia', 'Austria',
    'Azerbaijan', 'Bahamas', 'Bangladesh', 'Belgium', 'Belize', 'Bhutan', 'Bolivia',
    'Bosnia and Herzegovina', 'Brazil', 'Brunei', 'Bulgaria', 'Cambodia', 'Canada',
    'Chile', 'Colombia', 'Costa Rica', 'Croatia', 'Cyprus', 'Czech Republic', 'Denmark',
    'Ecuador', 'Egypt', 'Estonia', 'Finland', 'France', 'Georgia', 'Germany', 'Ghana',
    'Greece', 'Greenland', 'Hong Kong', 'Hungary', 'Iceland', 'India', 'Indonesia',
    'Ireland', 'Isle of Man', 'Israel', 'Italy', 'Japan', 'Kazakhstan', 'Laos', 'Latvia',
    'Liechtenstein', 'Lithuania', 'Luxembourg', 'Macau', 'Malaysia', 'Malta', 'Marocco',
    'Mexico', 'Moldova', 'Monaco', 'Mongolia', 'Montenegro', 'Myanmar', 'Nepal',
    'Netherlands', 'New Zealand', 'Nigeria', 'North Macedonia', 'Norway', 'Pakistan',
    'Panama', 'Paraguay', 'Peru', 'Philippines', 'Poland', 'Portugal', 'Puerto Rico',
    'Romania', 'Saudi Arabia', 'Serbia', 'Singapore', 'Slovakia', 'Slovenia',
    'South Africa', 'South Korea', 'Spain', 'Sri Lanka', 'Sweden', 'Switzerland',
    'Taiwan', 'Thailand', 'Turkey', 'Ukraine', 'United Arab Emirates', 'United Kingdom',
    'United States', 'Uruguay', 'Uzbekistan', 'Venezuela', 'Vietnam'
  ],

  expressvpn: [
    'Albania', 'Algeria', 'Andorra', 'Argentina', 'Australia', 'Austria', 'Azerbaijan',
    'Bahamas', 'Bangladesh', 'Belarus', 'Belgium', 'Bhutan', 'Bolivia', 'Brazil',
    'Brunei', 'Bulgaria', 'Cambodia', 'Canada', 'Cayman Islands', 'Chile', 'Colombia',
    'Costa Rica', 'Croatia', 'Cuba', 'Cyprus', 'Czech Republic', 'Denmark',
    'Dominican Republic', 'Ecuador', 'Egypt', 'Estonia', 'Finland', 'France', 'Georgia',
    'Germany', 'Greece', 'Guam', 'Guatemala', 'Honduras', 'Hong Kong', 'Hungary',
    'Iceland', 'India (via Singapore)', 'India (via UK)', 'Indonesia', 'Ireland',
    'Israel', 'Italy', 'Japan', 'Kazakhstan', 'Laos', 'Latvia', 'Liechtenstein',
    'Lithuania', 'Luxembourg', 'Macau', 'Malaysia', 'Mexico', 'Moldova', 'Mongolia',
    'Morocco', 'Myanmar', 'Nepal', 'Netherlands', 'New Zealand', 'North Macedonia',
    'Norway', 'Panama', 'Peru', 'Philippines (via Singapore)', 'Poland', 'Portugal',
    'Romania', 'Serbia', 'Singapore', 'Slovakia', 'Slovenia', 'South Africa',
    'South Korea', 'Spain', 'Sri Lanka', 'Sweden', 'Switzerland', 'Taiwan', 'Thailand',
    'Turkey', 'UK', 'USA', 'Ukraine', 'Uruguay', 'Venezuela', 'Vietnam'
  ],

  /** Lista do provedor (provedor desconhecido cai na da Surfshark). */
  for(provider) {
    return this[provider] || this.surfshark;
  },

  /**
   * Preenche um `<select>` com a lista do provedor, mantendo o valor atual
   * quando ele existe nessa lista.
   */
  fill(select, provider, current) {
    if (!select) return;
    const list = this.for(provider);
    const wanted = current || select.value;

    select.innerHTML = list.map((name) => `<option value="${name}">${name}</option>`).join('');
    if (wanted && list.includes(wanted)) select.value = wanted;
  }
};
