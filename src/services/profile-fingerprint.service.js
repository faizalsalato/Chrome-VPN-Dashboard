/**
 * ProfileFingerprintService
 *
 * Decide a identidade de um perfil: gera o fingerprint alinhado à localização
 * da conexão e diz quando ele precisa ser re-alinhado (a VPN reconectou em
 * outro país, o proxy trocou de IP, o usuário trocou o país).
 *
 * A identidade (userAgent, tela, GPU) é determinística pelo seed e nunca muda
 * sozinha; só idioma/fuso/geo seguem a localização.
 */
const fingerprintService = require('./fingerprint.service');

class ProfileFingerprintService {
  /** Compara a geo persistida com uma localização recém-resolvida. */
  sameLocation(geo, location) {
    if (!geo || !location) return false;
    return this._key(geo) === this._key(location);
  }

  _key(geo) {
    const country = geo.countryCode || geo.country || '';
    const city = geo.city || '';
    return `${String(country).toLowerCase()}|${String(city).toLowerCase()}|${geo.timezone || ''}`;
  }

  /**
   * Gera o fingerprint de um perfil novo.
   *
   * @param {string} seed
   * @param {object} location localização normalizada
   * @param {object} [overrides] campos que o usuário sobrescreveu na criação
   */
  generate(seed, location, overrides) {
    const base = fingerprintService.generate(seed, location);
    return this._mergeOverrides(base, overrides, location);
  }

  /**
   * Re-alinha um fingerprint existente à localização atual e à versão real do
   * navegador da imagem.
   *
   * @returns {{fingerprint: object, changed: boolean}}
   */
  sync(stored, seed, location) {
    const current = stored && typeof stored === 'object' ? stored : null;
    // Sem localização confiável (proxy sem geo): o perfil é preservado como
    // está — mas a versão do navegador ainda é conferida abaixo, porque ela não
    // depende da localização.
    const hasLocation = !!location && !(!location.countryCode && location.source === 'proxy-unknown');

    let fingerprint = current;
    let changed = false;

    if (hasLocation && (!current || !this.sameLocation(current.geo, location))) {
      fingerprint = current
        ? fingerprintService.relocate(current, location)
        : fingerprintService.generate(seed, location);
      changed = true;
    }

    if (!fingerprint) return { fingerprint: null, changed: false };

    // Perfis antigos trazem a versão inventada do gerador anterior (a UA dizia
    // "Chrome/135" num binário 154) e nenhum Client Hint: o navegador anunciaria
    // uma versão na UA e outra em navigator.userAgentData.
    const version = fingerprintService.alignBrowserVersion(fingerprint);
    if (version.changed) {
      fingerprint = version.fingerprint;
      changed = true;
    }

    return { fingerprint, changed };
  }

  /**
   * Aplica overrides do usuário mantendo a coerência: se ele mexeu em idioma
   * ou fuso, os campos derivados são recalculados junto (para não deixar geo e
   * fuso discordando).
   */
  _mergeOverrides(base, overrides, location) {
    if (!overrides || typeof overrides !== 'object' || !Object.keys(overrides).length) {
      return base;
    }

    const merged = Object.assign({}, base, overrides);
    const touchesLocale = overrides.language || overrides.languages || overrides.timezone;
    if (!touchesLocale) return merged;

    return fingerprintService.relocate(merged, Object.assign({}, location, {
      countryCode: location ? location.countryCode : null,
      country: location ? location.country : null,
      city: location ? location.city : null,
      languages: overrides.languages || (overrides.language ? [overrides.language] : undefined),
      timezone: overrides.timezone,
      source: 'override'
    }));
  }
}

module.exports = new ProfileFingerprintService();
