/**
 * Tabela país -> idioma/fuso e a resolução de localização: é a base que garante
 * que o fingerprint não contradiga o IP de saída.
 */
const localeProfile = require('../src/services/locale-profile.service');

describe('resolveCountryCode', () => {
  it('aceita ISO alpha-2, nome em inglês e apelido', () => {
    expect(localeProfile.resolveCountryCode('DE')).toBe('DE');
    expect(localeProfile.resolveCountryCode('de')).toBe('DE');
    expect(localeProfile.resolveCountryCode('Germany')).toBe('DE');
    expect(localeProfile.resolveCountryCode('Alemanha')).toBe('DE');
    expect(localeProfile.resolveCountryCode('United States')).toBe('US');
    expect(localeProfile.resolveCountryCode('Canada')).toBe('CA');
  });

  it('devolve null para país desconhecido ou vazio', () => {
    expect(localeProfile.resolveCountryCode('Wakanda')).toBeNull();
    expect(localeProfile.resolveCountryCode('')).toBeNull();
    expect(localeProfile.resolveCountryCode(null)).toBeNull();
    expect(localeProfile.resolveCountryCode('ZZ')).toBeNull();
  });
});

describe('fromLocation — VPN por país', () => {
  it('país de um único fuso: idioma e fuso do país', () => {
    const de = localeProfile.fromLocation({ country: 'Germany' });
    expect(de.countryCode).toBe('DE');
    expect(de.country).toBe('Germany');
    expect(de.language).toBe('de-DE');
    expect(de.timezone).toBe('Europe/Berlin');
    expect(de.languages).toEqual(['de-DE', 'de', 'en-US', 'en']);
  });

  it('país multi-fuso usa o fuso/cidade reais medidos no IP', () => {
    const ca = localeProfile.fromLocation({
      country: 'Canada',
      countryCode: 'CA',
      city: 'Vancouver',
      region: 'British Columbia',
      timezone: 'America/Vancouver',
      ip: '142.113.0.1',
      source: 'vpn'
    });
    // O fuso medido vence o padrão do país (America/Toronto).
    expect(ca.timezone).toBe('America/Vancouver');
    expect(ca.city).toBe('Vancouver');
    expect(ca.ip).toBe('142.113.0.1');
    expect(ca.source).toBe('vpn');
    expect(ca.languages[0]).toBe('en-CA');
  });

  it('ignora um fuso inválido e cai no padrão do país', () => {
    const us = localeProfile.fromLocation({ country: 'US', timezone: 'Nao/Existe' });
    expect(us.timezone).toBe('America/New_York');
  });

  it('sem país conhecido devolve um perfil neutro válido', () => {
    const unknown = localeProfile.fromLocation({ source: 'proxy-unknown' });
    expect(unknown.countryCode).toBeNull();
    expect(unknown.source).toBe('proxy-unknown');
    expect(localeProfile.isIana(unknown.timezone)).toBe(true);
    expect(unknown.languages.length).toBeGreaterThan(0);
  });
});

describe('fromLocation — override explícito', () => {
  it('idiomas do override vencem o idioma do país', () => {
    const profile = localeProfile.fromLocation({
      country: 'Germany',
      languages: ['en-US', 'pt-BR']
    });
    expect(profile.languages).toEqual(['en-US', 'pt-BR']);
    expect(profile.language).toBe('en-US');
    // O fuso continua sendo o do país: só o idioma foi sobrescrito.
    expect(profile.timezone).toBe('Europe/Berlin');
  });

  it('override dentro de locale tem a maior precedência', () => {
    const profile = localeProfile.fromLocation({
      country: 'Japan',
      languages: ['de-DE'],
      locale: { languages: ['fr-FR'], timezone: 'Europe/Paris' }
    });
    expect(profile.languages).toEqual(['fr-FR']);
    expect(profile.timezone).toBe('Europe/Paris');
  });

  it('lista de idiomas inválida é ignorada', () => {
    const profile = localeProfile.fromLocation({ country: 'BR', languages: ['@@@', ''] });
    expect(profile.language).toBe('pt-BR');
  });
});

describe('acceptLanguage', () => {
  it('monta o cabeçalho com q-values decrescentes', () => {
    expect(localeProfile.acceptLanguage(['de-DE', 'de', 'en-US', 'en']))
      .toBe('de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7');
  });

  it('lista vazia usa o perfil neutro', () => {
    const header = localeProfile.acceptLanguage([]);
    expect(header.length).toBeGreaterThan(0);
    expect(header).not.toContain('undefined');
  });
});

describe('normalizeTimezone', () => {
  it('aceita IANA conhecido e rejeita lixo', () => {
    expect(localeProfile.normalizeTimezone('Europe/Lisbon')).toBe('Europe/Lisbon');
    expect(localeProfile.normalizeTimezone('UTC')).toBe('UTC');
    expect(localeProfile.normalizeTimezone('Europe/Lisboa')).toBeNull();
    expect(localeProfile.normalizeTimezone('Berlin')).toBeNull();
    expect(localeProfile.normalizeTimezone('')).toBeNull();
  });

  // Regressão: Intl.supportedValuesOf no ICU antigo (Node 18) só devolve o nome
  // canônico de cada zona, então estes apelidos eram recusados e o perfil do
  // país caía em UTC — contradizendo o IP de saída.
  it('aceita apelidos de fuso que o ICU antigo não lista como canônicos', () => {
    const aliases = [
      'Asia/Kolkata',
      'Europe/Kyiv',
      'America/Nuuk',
      'Asia/Yangon',
      'Asia/Kathmandu',
      'Asia/Ho_Chi_Minh',
      'America/Argentina/Buenos_Aires'
    ];
    for (const zone of aliases) {
      expect(localeProfile.normalizeTimezone(zone)).toBe(zone);
    }
  });

  it('nenhum país da tabela cai no fuso neutro', () => {
    const fallback = localeProfile.neutral().timezone;
    const countries = ['India', 'Ukraine', 'Vietnam', 'Argentina', 'Greenland', 'Nepal', 'Myanmar'];
    for (const country of countries) {
      const profile = localeProfile.fromLocation({ country });
      expect(profile.timezone).not.toBe(fallback);
      expect(localeProfile.isIana(profile.timezone)).toBe(true);
    }
  });
});

describe('tabela de países', () => {
  it('todo perfil tem nome, idioma BCP-47 e fuso IANA válido', () => {
    const profiles = localeProfile.allProfiles();
    const codes = Object.keys(profiles);
    expect(codes.length).toBeGreaterThan(80);

    for (const code of codes) {
      const profile = profiles[code];
      expect(profile.name).toBeTruthy();
      expect(localeProfile.languagesFor(profile.language)[0]).toBe(profile.language);
      expect(localeProfile.isIana(profile.timezone)).toBe(true);
    }
  });

  it('idiomas derivados incluem inglês de apoio', () => {
    expect(localeProfile.languagesFor('de-DE')).toEqual(['de-DE', 'de', 'en-US', 'en']);
    expect(localeProfile.languagesFor('en-US')).toEqual(['en-US', 'en']);
  });
});
