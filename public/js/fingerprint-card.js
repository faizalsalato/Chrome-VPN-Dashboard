/**
 * FingerprintCard - bloco do card da instância que mostra a identidade do
 * perfil (SO/resolução, localização da conexão, fuso do sistema e idioma).
 *
 * A localização exibida é a mesma usada para alinhar o navegador: país/cidade
 * do IP de saída e o fuso marcado pelo fingerprint.
 *
 * O selo de procedência ("IP verificado", "por país", "divergente"...) abre o
 * bloco numa linha própria, como cabeçalho: é o que diz de onde veio o perfil.
 */
const FingerprintCard = {
  render(instance) {
    const fp = instance.fingerprint;
    if (!fp) return '';

    const geo = fp.geo || {};
    const location = this._locationLabel(geo);
    const badge = this._syncBadge(fp, instance);

    return `
          <div class="proxy-info fp-info">
            ${badge ? `<div class="info-row fp-sync-row">${badge}</div>` : ''}
            <div class="info-row">
              <span class="info-label">Fingerprint</span>
              <span class="info-value" title="userAgent e tela do perfil">${this._osLabel(fp)} · ${this._resolution(fp)}</span>
            </div>
            <div class="info-row">
              <span class="info-label">Localização</span>
              <span class="info-value" title="Local da saída usada no perfil">
                <span class="fp-loc">${location}</span>
              </span>
            </div>
            <div class="info-row">
              <span class="info-label">Sistema Timezone</span>
              <span class="info-value">${this._safe(fp.timezone) || 'N/A'}</span>
            </div>
            <div class="info-row">
              <span class="info-label">Idioma</span>
              <span class="info-value" title="${this._safe((fp.languages || []).join(', '))}">${this._safe(fp.language) || 'N/A'}</span>
            </div>
          </div>`;
  },

  _osLabel(fp) {
    if (!fp.platform) return 'N/A';
    if (fp.platform.startsWith('Win')) return 'Windows';
    if (fp.platform.startsWith('Mac')) return 'macOS';
    return 'Linux';
  },

  _resolution(fp) {
    return fp.screen ? `${fp.screen.width}x${fp.screen.height}` : 'N/A';
  },

  _locationLabel(geo) {
    const country = this._safe(geo.country) || 'Desconhecido';
    const city = this._safe(geo.city);
    return city ? `${country} · ${city}` : country;
  },

  /**
   * Selo de procedência: avisa quando o perfil veio do país escolhido (e não
   * do IP já verificado) e quando o fuso do fingerprint divergir do IP da VPN.
   */
  _syncBadge(fp, instance) {
    const source = (fp.geo && fp.geo.source) || 'fallback';
    const vpnTimezone = instance.vpnInfo && instance.vpnInfo.timezone;

    if (vpnTimezone && fp.timezone && vpnTimezone !== fp.timezone) {
      return `<span class="fp-sync fp-sync-warn" title="Fuso do perfil difere do IP de saída (${this._safe(vpnTimezone)})">divergente</span>`;
    }

    const labels = {
      vpn: 'IP verificado',
      proxy: 'IP verificado',
      'vpn-country': 'por país',
      override: 'manual',
      fallback: 'neutro'
    };
    const label = labels[source];
    if (!label) return '';

    const kind = source === 'vpn' || source === 'proxy' ? 'fp-sync-ok' : 'fp-sync-neutral';
    const title = source === 'vpn-country'
      ? 'Ajustado ao país da VPN; confirme no próximo start para usar a cidade real'
      : `Origem do perfil: ${source}`;
    return `<span class="fp-sync ${kind}" title="${title}">${label}</span>`;
  },

  /**
   * Mantém apenas caracteres esperados em nomes de país/cidade/fuso. Evita
   * que a geo do IP de saída injete marcação no card.
   */
  _safe(value) {
    if (value == null) return '';
    return String(value).replace(/[^\p{L}\p{N} .,'()/_-]/gu, '');
  }
};
