/**
 * Identidade do perfil: idioma/fuso seguem a localização da conexão; a
 * identidade (userAgent, tela, GPU) é determinística pelo seed e não muda
 * quando a VPN troca de cidade.
 */
const profileFingerprint = require('../src/services/profile-fingerprint.service');
const fingerprintService = require('../src/services/fingerprint.service');
const localeProfile = require('../src/services/locale-profile.service');

const GERMANY = localeProfile.fromLocation({ country: 'Germany', source: 'vpn-country' });
const BRAZIL = localeProfile.fromLocation({
  country: 'Brazil', countryCode: 'BR', city: 'São Paulo', timezone: 'America/Sao_Paulo',
  ip: '191.1.2.3', source: 'vpn'
});

function identityOf(fingerprint) {
  return {
    userAgent: fingerprint.userAgent,
    platform: fingerprint.platform,
    screen: fingerprint.screen,
    webgl: fingerprint.webgl
  };
}

describe('generate', () => {
  it('gera o perfil no idioma e fuso do país', () => {
    const fingerprint = profileFingerprint.generate('chrome1', GERMANY);
    expect(fingerprint.seed).toBe('chrome1');
    expect(fingerprint.language).toBe('de-DE');
    expect(fingerprint.languages).toEqual(['de-DE', 'de', 'en-US', 'en']);
    expect(fingerprint.timezone).toBe('Europe/Berlin');
    expect(fingerprint.geo.countryCode).toBe('DE');
  });

  it('a identidade é determinística pelo seed', () => {
    const first = profileFingerprint.generate('chrome7', GERMANY);
    const second = profileFingerprint.generate('chrome7', BRAZIL);
    // Mesmo seed, localizações diferentes: identidade igual, locale diferente.
    expect(identityOf(first)).toEqual(identityOf(second));
    expect(first.timezone).not.toBe(second.timezone);
    expect(first.language).not.toBe(second.language);
  });

  it('seeds diferentes produzem identidades diferentes', () => {
    // A UA sozinha não mede isso: ela só depende da plataforma (2 opções),
    // então dois seeds podem cair no mesmo desktop. A identidade completa
    // (plataforma + tela + GPU + hardware) é o que precisa variar.
    const identidades = new Set(
      Array.from({ length: 20 }, (_, i) => JSON.stringify(
        identityOf(profileFingerprint.generate(`chrome${i + 1}`, GERMANY))
      ))
    );
    expect(identidades.size).toBeGreaterThan(3);
  });

  it('a UA é sempre de um desktop plausível', () => {
    for (const seed of ['chrome1', 'chrome2', 'chrome3', 'chrome4', 'chrome5']) {
      const ua = profileFingerprint.generate(seed, GERMANY).userAgent;
      expect(ua).toMatch(
        /^Mozilla\/5\.0 \((Windows NT 10\.0; Win64; x64|Macintosh; Intel Mac OS X 10_15_7)\)/
      );
    }
  });

  it('override de fuso e idioma é aplicado com coerência', () => {
    const fingerprint = profileFingerprint.generate('chrome4', GERMANY, {
      timezone: 'Europe/Lisbon',
      language: 'pt-PT'
    });
    expect(fingerprint.timezone).toBe('Europe/Lisbon');
    expect(fingerprint.language).toBe('pt-PT');
    expect(fingerprint.languages[0]).toBe('pt-PT');
    // A geolocalização continua sendo a da conexão.
    expect(fingerprint.geo.countryCode).toBe('DE');
  });

  it('override de fuso inválido cai no fuso da conexão', () => {
    const fingerprint = profileFingerprint.generate('chrome5', GERMANY, { timezone: 'Nao/Existe' });
    expect(fingerprint.timezone).toBe('Europe/Berlin');
  });

  it('override de campo de identidade é respeitado', () => {
    const fingerprint = profileFingerprint.generate('chrome6', GERMANY, { userAgent: 'custom-UA' });
    expect(fingerprint.userAgent).toBe('custom-UA');
    expect(fingerprint.timezone).toBe('Europe/Berlin');
  });
});

describe('sync', () => {
  const stored = profileFingerprint.generate('chrome1', GERMANY);

  it('mesma localização não altera nada', () => {
    const result = profileFingerprint.sync(stored, 'chrome1', GERMANY);
    expect(result.changed).toBe(false);
    expect(result.fingerprint).toBe(stored);
  });

  it('VPN reconectada em outro país re-alinha idioma e fuso', () => {
    const result = profileFingerprint.sync(stored, 'chrome1', BRAZIL);
    expect(result.changed).toBe(true);
    expect(result.fingerprint.timezone).toBe('America/Sao_Paulo');
    expect(result.fingerprint.language).toBe('pt-BR');
    expect(result.fingerprint.geo.city).toBe('São Paulo');
    expect(result.fingerprint.geo.ip).toBe('191.1.2.3');
    // A identidade do perfil é preservada.
    expect(identityOf(result.fingerprint)).toEqual(identityOf(stored));
  });

  it('mesma localização em outra caixa/formato não re-alinha', () => {
    const storedBr = profileFingerprint.generate('chrome2', BRAZIL);
    const same = localeProfile.fromLocation({
      country: 'brazil', countryCode: 'br', city: 'são paulo',
      timezone: 'America/Sao_Paulo', source: 'vpn'
    });
    const result = profileFingerprint.sync(storedBr, 'chrome2', same);
    expect(result.changed).toBe(false);
    expect(result.fingerprint).toBe(storedBr);
  });

  it('proxy sem geo preserva o perfil existente', () => {
    const unknown = localeProfile.fromLocation({ source: 'proxy-unknown' });
    const result = profileFingerprint.sync(stored, 'chrome1', unknown);
    expect(result.changed).toBe(false);
    expect(result.fingerprint).toBe(stored);
  });

  it('sem fingerprint salvo, gera um novo alinhado à localização', () => {
    const result = profileFingerprint.sync(null, 'chrome9', BRAZIL);
    expect(result.changed).toBe(true);
    expect(result.fingerprint.seed).toBe('chrome9');
    expect(result.fingerprint.timezone).toBe('America/Sao_Paulo');
  });
});

describe('relocate do fingerprint.service', () => {
  it('troca apenas locale/geo e mantém a identidade', () => {
    const original = fingerprintService.generate('chrome1', GERMANY);
    const moved = fingerprintService.relocate(original, BRAZIL);

    expect(moved.timezone).toBe('America/Sao_Paulo');
    expect(moved.geo.countryCode).toBe('BR');
    expect(moved.userAgent).toBe(original.userAgent);
    expect(moved.screen).toEqual(original.screen);
    expect(moved.webgl).toEqual(original.webgl);
    expect(moved.seed).toBe('chrome1');
  });
});
describe('personas de desktop', () => {
  // 60 seeds cobrem o espaço determinístico das personas com folga.
  const seeds = Array.from({ length: 60 }, (_, i) => `chrome${i + 1}`);

  it('nunca gera persona Linux (o host é Linux, isso denuncia o container)', () => {
    for (const seed of seeds) {
      const fingerprint = profileFingerprint.generate(seed, GERMANY);
      expect(['Win32', 'MacIntel']).toContain(fingerprint.platform);
      expect(fingerprint.userAgent).not.toContain('Linux');
      expect(fingerprint.userAgent).not.toContain('X11');
    }
  });

  it('não usa resoluções típicas do Chrome headless', () => {
    for (const seed of seeds) {
      const { width, height } = profileFingerprint.generate(seed, GERMANY).screen;
      expect(`${width}x${height}`).not.toBe('1536x864');
      expect(`${width}x${height}`).not.toBe('1280x720');
      // Resolução de monitor de verdade: nada minúsculo nem desproporcional.
      expect(width).toBeGreaterThanOrEqual(1366);
      expect(width / height).toBeGreaterThan(1.2);
      expect(width / height).toBeLessThan(1.9);
    }
  });

  it('a tela declarada é coerente entre os campos do próprio objeto', () => {
    for (const seed of seeds) {
      const { screen } = profileFingerprint.generate(seed, GERMANY);
      expect(screen.availWidth).toBe(screen.width);
      expect(screen.availHeight).toBeLessThanOrEqual(screen.height);
      expect(screen.outerWidth).toBe(screen.width);
      expect(screen.innerWidth).toBeLessThanOrEqual(screen.width);
      expect(screen.innerHeight).toBeLessThanOrEqual(screen.height);
    }
  });
});
describe('client hints do perfil', () => {
  const chromeVersion = require('../src/services/chrome-version.service');

  const CH_PLATFORM_BY_PLATFORM = { Win32: 'Windows', MacIntel: 'macOS' };

  it('a versão da UA é a versão real do navegador da imagem', () => {
    // Se estas duas discordarem, o Chrome anuncia uma versão na UA e outra nos
    // Client Hints — contradição que um verificador de fingerprint mostra.
    const esperado = chromeVersion.majorFor();
    for (const seed of ['chrome1', 'chrome2', 'chrome9']) {
      const fingerprint = profileFingerprint.generate(seed, GERMANY);
      expect(fingerprint.userAgent).toContain(`Chrome/${esperado}.0.0.0`);
      expect(fingerprint.clientHints.chromeMajor).toBe(esperado);
    }
  });

  it('anuncia a plataforma dos Client Hints, nunca o Linux do container', () => {
    for (const seed of ['chrome1', 'chrome2', 'chrome3', 'chrome4']) {
      const fingerprint = profileFingerprint.generate(seed, GERMANY);
      expect(fingerprint.clientHints.platform)
        .toBe(CH_PLATFORM_BY_PLATFORM[fingerprint.platform]);
      expect(fingerprint.clientHints.platform).not.toBe('Linux');
    }
  });

  it('o build completo dos Client Hints começa pela versão da UA', () => {
    const fingerprint = profileFingerprint.generate('chrome5', GERMANY);
    expect(fingerprint.clientHints.fullVersion)
      .toMatch(new RegExp(`^${fingerprint.clientHints.chromeMajor}\\.\\d+\\.\\d+`));
  });

  it('re-alinhar a localização não mexe nos Client Hints (só locale/geo)', () => {
    const original = profileFingerprint.generate('chrome6', GERMANY);
    const resultado = profileFingerprint.sync(original, 'chrome6', BRAZIL);
    expect(resultado.changed).toBe(true);
    expect(resultado.fingerprint.clientHints).toEqual(original.clientHints);
    expect(resultado.fingerprint.timezone).toBe('America/Sao_Paulo');
  });
});
describe('alinhamento com a versão real do navegador', () => {
  const chromeVersion = require('../src/services/chrome-version.service');

  /** Perfil como os antigos: versão inventada na UA e sem Client Hints. */
  function legado(seed) {
    const atual = profileFingerprint.generate(seed, GERMANY);
    return Object.assign({}, atual, {
      userAgent: atual.userAgent.replace(/Chrome\/[\d.]+/, 'Chrome/135.0.0.0'),
      appVersion: atual.appVersion.replace(/Chrome\/[\d.]+/, 'Chrome/135.0.0.0'),
      clientHints: undefined
    });
  }

  it('troca a versão inventada pela versão real do binário', () => {
    const major = chromeVersion.majorFor();
    const { fingerprint, changed } = profileFingerprint.sync(legado('chrome1'), 'chrome1', GERMANY);

    expect(changed).toBe(true);
    expect(fingerprint.userAgent).toContain(`Chrome/${major}.0.0.0`);
    expect(fingerprint.userAgent).not.toContain('Chrome/135.');
    expect(fingerprint.appVersion).toContain(`Chrome/${major}.0.0.0`);
    expect(fingerprint.clientHints.chromeMajor).toBe(major);
  });

  it('preenche os Client Hints que faltavam, seguindo a plataforma da UA', () => {
    const antigo = legado('chrome2');
    const { fingerprint } = profileFingerprint.sync(antigo, 'chrome2', GERMANY);

    expect(fingerprint.clientHints.platform)
      .toBe(antigo.platform === 'MacIntel' ? 'macOS' : 'Windows');
    expect(fingerprint.clientHints.platform).not.toBe('Linux');
    // A identidade do perfil não é tocada por este ajuste.
    expect(fingerprint.screen).toEqual(antigo.screen);
    expect(fingerprint.webgl).toEqual(antigo.webgl);
    expect(fingerprint.seed).toBe(antigo.seed);
  });

  it('não mexe em quem já está na versão real', () => {
    const atual = profileFingerprint.generate('chrome3', GERMANY);
    const { fingerprint, changed } = profileFingerprint.sync(atual, 'chrome3', GERMANY);

    expect(changed).toBe(false);
    expect(fingerprint).toBe(atual);
  });

  it('corrige a versão mesmo quando a localização não pôde ser resolvida', () => {
    const semGeo = localeProfile.fromLocation({ source: 'proxy-unknown' });
    const { fingerprint, changed } = profileFingerprint.sync(legado('chrome4'), 'chrome4', semGeo);

    expect(changed).toBe(true);
    expect(fingerprint.userAgent).toContain(`Chrome/${chromeVersion.majorFor()}.0.0.0`);
  });
});
