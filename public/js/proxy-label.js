/**
 * ProxyLabel - rótulo de um proxy salvo.
 *
 * O país vem da geo guardada no último teste do proxy (GET /api/proxies).
 * Um proxy ainda não testado não tem país, e nesse caso o rótulo diz isso —
 * em nenhum momento o endereço (host:porta/usuário) é usado como rótulo,
 * porque na escolha o que importa é onde o proxy sai, não os dados de conexão.
 *
 * Módulo puro (não toca no DOM) para poder ser testado direto.
 */
const ProxyLabel = {
  /** Texto aparado ou null quando vazio. */
  _text(value) {
    const s = String(value == null ? '' : value).trim();
    return s || null;
  },

  /** "Alemanha · Munique" — ou null quando o país ainda é desconhecido. */
  countryLine(proxy) {
    const country = this._text((proxy || {}).country);
    if (!country) return null;
    const city = this._text(proxy.city);
    return city ? `${country} · ${city}` : country;
  },

  /**
   * Rótulo de uma opção de seleção (criação de instância).
   * Ex.: "Alemanha · Munique (#4)". O "(#id)" só existe para distinguir dois
   * proxies do mesmo país — não é o endereço do proxy.
   */
  forPick(proxy) {
    const p = proxy || {};
    const line = this.countryLine(p) || 'País não identificado — teste o proxy';
    return `${line} (#${p.id})`;
  },

  /** Verdadeiro quando o proxy já foi testado com sucesso ao menos uma vez. */
  hasCountry(proxy) {
    return !!this._text((proxy || {}).country);
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ProxyLabel;
}
