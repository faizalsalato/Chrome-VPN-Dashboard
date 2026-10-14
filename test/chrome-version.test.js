/**
 * Versão do navegador da imagem.
 *
 * O persona precisa usar a versão REAL do binário: o Chrome anuncia a própria
 * versão nos Client Hints, então um número inventado vira duas versões
 * diferentes na mesma página (o whoer.net pegou exatamente isso).
 */
const chromeVersion = require('../src/services/chrome-version.service');

describe('versionOf', () => {
  it('extrai o build completo da saída do chromium --version', () => {
    const saida = 'Chromium 154.0.8037.92 built on Debian GNU/Linux 13 (trixie)';
    expect(chromeVersion.versionOf(saida)).toBe('154.0.8037.92');
    expect(chromeVersion.majorOf(saida)).toBe(154);
  });

  it('aceita a saída do brave', () => {
    expect(chromeVersion.versionOf('Brave Browser 154.1.2.3')).toBe('154.1.2.3');
  });

  it('recusa saída que não é versão de navegador', () => {
    expect(chromeVersion.versionOf('command not found')).toBeNull();
    expect(chromeVersion.versionOf('')).toBeNull();
    // Número pequeno é ruído, não versão de navegador.
    expect(chromeVersion.versionOf('Erro 2.3.4')).toBeNull();
  });
});

describe('versionFor/majorFor', () => {
  const envOriginal = process.env.CHROME_MAJOR;

  afterEach(() => {
    if (envOriginal === undefined) delete process.env.CHROME_MAJOR;
    else process.env.CHROME_MAJOR = envOriginal;
    chromeVersion._clearCache();
  });

  it('honra a sobrescrita por ambiente (usada em testes e no deploy)', () => {
    process.env.CHROME_MAJOR = '160';
    expect(chromeVersion.versionFor()).toBe('160.0.0.0');
    expect(chromeVersion.majorFor()).toBe(160);
  });

  it('ignora sobrescrita absurda e devolve um major plausível', () => {
    process.env.CHROME_MAJOR = '3';
    expect(chromeVersion.majorFor()).toBeGreaterThanOrEqual(50);
  });

  it('nunca lança quando não há Docker para perguntar', () => {
    delete process.env.CHROME_MAJOR;
    expect(() => chromeVersion.versionFor()).not.toThrow();
    expect(chromeVersion.versionFor()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
/**
 * CloakBrowser: a versão não sai do `--version` (o binário é outro), e sim do
 * diagnóstico próprio da imagem (`cloakbrowser info`). Sem Docker, a referência
 * é a versão completa que a imagem traz, não o "major.0.0.0" do Chromium.
 */
describe('CloakBrowser', () => {
  it('pergunta a versão à imagem do CloakBrowser', () => {
    expect(chromeVersion.imageFor('cloakbrowser')).toBe('cloakhq/cloakbrowser:latest');
    expect(chromeVersion.imageFor('chromium')).toBe(chromeVersion.CHROME_IMAGE);
    expect(chromeVersion.imageFor('brave')).toBe(chromeVersion.BRAVE_IMAGE);
  });

  it('a referência é a versão completa do Chromium embutido', () => {
    expect(chromeVersion.fallbackVersionFor('cloakbrowser')).toBe('146.0.7680.177');
    // Nos outros navegadores a referência segue o formato dos Client Hints.
    const chromiumFallback = `${chromeVersion.FALLBACK_CHROME_MAJOR}.0.0.0`;
    expect(chromeVersion.fallbackVersionFor('chromium')).toBe(chromiumFallback);
    expect(chromeVersion.fallbackVersionFor('brave')).toBe(chromiumFallback);
  });

  it('devolve a versão do CloakBrowser mesmo sem Docker', () => {
    const envOriginal = process.env.CHROME_MAJOR;
    delete process.env.CHROME_MAJOR;
    try {
      const versao = chromeVersion.versionFor('cloakbrowser');
      expect(versao).toMatch(/^\d+\.\d+\.\d+/);
      expect(versao.startsWith('146.')).toBe(true);
      expect(chromeVersion.majorFor('cloakbrowser')).toBe(146);
    } finally {
      if (envOriginal !== undefined) process.env.CHROME_MAJOR = envOriginal;
      chromeVersion._clearCache();
    }
  });
});
