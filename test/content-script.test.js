/**
 * Verifica o spoof de fuso/idioma do content script (a parte que o site vê).
 * O script roda num contexto vm isolado para não alterar o Date/Intl do Jest.
 * O oráculo é o próprio ICU do Node (Intl nativo), independente da minha conta.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CONTENT_PATH = path.join(__dirname, '..', 'src', 'fingerprint-extension', 'content.js');
const fingerprintService = require('../src/services/fingerprint.service');

/**
 * Carrega o content script COM O BUILD REAL DO INJETOR — o mesmo arquivo que é
 * gravado dentro do container — num contexto vm isolado. Usar o construtor de
 * produção aqui é proposital: o teste já passou uma vez enquanto o arquivo
 * injetado saía com erro de sintaxe e a extensão não aplicava nada.
 */
function loadContentScript(fingerprint) {
  const source = fingerprintService._buildContent(fingerprint);
  const context = vm.createContext({});
  // Mínimo de DOM que o script toca.
  vm.runInContext('var navigator = {}; var screen = {}; var window = {};', context);
  vm.runInContext(source, context);
  return context;
}

function evaluate(context, expression) {
  return vm.runInContext(expression, context);
}

/** Offset esperado (minutos a oeste de UTC) segundo o ICU nativo do Node. */
function nativeOffsetMinutes(timeZone, instant) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(instant);
  const name = (parts.find((p) => p.type === 'timeZoneName') || {}).value || 'GMT';
  const match = name.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!match) return 0;
  const minutes = parseInt(match[2], 10) * 60 + parseInt(match[3], 10);
  return match[1] === '-' ? minutes : -minutes;
}

const WINTER = Date.UTC(2023, 0, 15, 12, 0, 0);
const SUMMER = Date.UTC(2023, 6, 15, 12, 0, 0);
const ONE_INSTANT = 1700000000000; // 2023-11-14T22:13:20Z

const PROFILE = {
  seed: 'chrome9',
  language: 'pt-BR',
  languages: ['pt-BR', 'en-US', 'en'],
  timezone: 'America/Sao_Paulo',
  geo: { country: 'Brazil', countryCode: 'BR', city: 'São Paulo', timezone: 'America/Sao_Paulo' }
};

describe('content.js — idioma', () => {
  const context = loadContentScript(PROFILE);

  it('aplica navigator.language e languages do perfil', () => {
    expect(evaluate(context, 'navigator.language')).toBe('pt-BR');
    expect(evaluate(context, 'navigator.languages.join(",")')).toBe('pt-BR,en-US,en');
  });

  it('marca navigator.webdriver como false', () => {
    expect(evaluate(context, 'navigator.webdriver')).toBe(false);
  });

  it('Intl usa o idioma do perfil quando o site não pede nenhum', () => {
    expect(evaluate(context, 'Intl.DateTimeFormat().resolvedOptions().locale')).toBe('pt-BR');
    expect(evaluate(context, 'Intl.NumberFormat().resolvedOptions().locale')).toBe('pt-BR');
  });
});

describe('content.js — fuso horário', () => {
  const context = loadContentScript(PROFILE);

  it('resolvedOptions devolve o fuso do perfil', () => {
    expect(evaluate(context, 'Intl.DateTimeFormat().resolvedOptions().timeZone'))
      .toBe('America/Sao_Paulo');
  });

  it('getTimezoneOffset bate com o ICU nativo (America/Sao_Paulo)', () => {
    const expected = nativeOffsetMinutes('America/Sao_Paulo', new Date(ONE_INSTANT));
    expect(expected).toBe(180); // UTC-3, sem horário de verão desde 2019
    expect(evaluate(context, `new Date(${ONE_INSTANT}).getTimezoneOffset()`)).toBe(expected);
  });

  it('toString mostra hora local e rótulo GMT corretos', () => {
    const text = evaluate(context, `new Date(${ONE_INSTANT}).toString()`);
    expect(text).toMatch(/^Tue Nov 14 2023 19:13:20 GMT-0300 \(/);
    expect(text).toMatch(/\)$/);
  });

  it('toTimeString e toDateString seguem o mesmo fuso', () => {
    expect(evaluate(context, `new Date(${ONE_INSTANT}).toTimeString()`))
      .toMatch(/^19:13:20 GMT-0300 \(/);
    expect(evaluate(context, `new Date(${ONE_INSTANT}).toDateString()`))
      .toMatch(/^Tue Nov 14 2023$/);
  });

  it('um fuso explícito do site continua ganhando', () => {
    const formatted = evaluate(
      context,
      `new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false }).format(${ONE_INSTANT})`
    );
    expect(formatted).toBe('22:13');
  });

  it('respeita horário de verão de outros fusos (Europe/Berlin)', () => {
    const berlin = loadContentScript(Object.assign({}, PROFILE, { timezone: 'Europe/Berlin' }));
    expect(nativeOffsetMinutes('Europe/Berlin', new Date(WINTER))).toBe(-60);
    expect(nativeOffsetMinutes('Europe/Berlin', new Date(SUMMER))).toBe(-120);
    expect(evaluate(berlin, `new Date(${WINTER}).getTimezoneOffset()`)).toBe(-60);
    expect(evaluate(berlin, `new Date(${SUMMER}).getTimezoneOffset()`)).toBe(-120);
  });

  it('suporta fuso com meia hora (Asia/Kolkata)', () => {
    const kolkata = loadContentScript(Object.assign({}, PROFILE, { timezone: 'Asia/Kolkata' }));
    expect(evaluate(kolkata, `new Date(${ONE_INSTANT}).getTimezoneOffset()`)).toBe(-330);
    expect(evaluate(kolkata, `new Date(${ONE_INSTANT}).toString()`)).toContain('GMT+0530');
  });

  it('instante com milissegundos não deforma o rótulo GMT', () => {
    // O offset cru carrega os milissegundos do instante (-119.98 para Berlim no
    // verão). Sem arredondar antes de decompor, o rótulo saía "GMT+0160".
    const comMs = SUMMER + 999;
    const saoPaulo = evaluate(context, `new Date(${comMs}).toString()`);
    expect(saoPaulo).toContain('GMT-0300');
    expect(saoPaulo).not.toMatch(/GMT[+-]\d{2}60/);

    const berlinVerao = loadContentScript(Object.assign({}, PROFILE, { timezone: 'Europe/Berlin' }));
    const berlinTexto = evaluate(berlinVerao, `new Date(${comMs}).toString()`);
    expect(berlinTexto).toContain('GMT+0200');
    expect(berlinTexto).not.toMatch(/GMT[+-]\d{2}60/);
    expect(evaluate(berlinVerao, `new Date(${comMs}).getTimezoneOffset()`)).toBe(-120);

    // toTimeString usa o mesmo rótulo e sofre da mesma deformação.
    const horaTexto = evaluate(berlinVerao, `new Date(${comMs}).toTimeString()`);
    expect(horaTexto).toContain('GMT+0200');
  });
});

describe('build injetado (o arquivo que vai para o container)', () => {
  it('o template do repositório carrega o marcador esperado', () => {
    const template = fs.readFileSync(CONTENT_PATH, 'utf-8');
    expect(template).toContain(fingerprintService.FP_MARKER);
  });

  it('substitui o marcador e gera JS válido com o perfil embutido', () => {
    const source = fingerprintService._buildContent(PROFILE);
    // O comentário do template cita o nome do marcador, então o que precisa
    // sumir é o marcador em si (com o fallback), não a palavra.
    expect(source).not.toContain('/*__FINGERPRINT__*/');
    expect(source).toContain('America/Sao_Paulo');
    expect(source).toContain('var FP = {');
    // Compilar sem erro é o ponto: o marcador sem o fallback gerava
    // `var FP = {...} null;`, que matava a extensão inteira.
    expect(() => new vm.Script(source)).not.toThrow();
  });

  it('sem fingerprint o build continua sendo um no-op válido', () => {
    const source = fingerprintService._buildContent(null);
    expect(() => new vm.Script(source)).not.toThrow();

    const context = vm.createContext({});
    vm.runInContext('var navigator = {}; var screen = {}; var window = {};', context);
    vm.runInContext(source, context);
    expect(vm.runInContext('typeof navigator.userAgent', context)).toBe('undefined');
  });
});

describe('content.js — robustez', () => {
  it('sem fingerprint é um no-op', () => {
    const context = loadContentScript(null);
    expect(evaluate(context, 'typeof navigator.userAgent')).toBe('undefined');
    expect(evaluate(context, 'typeof navigator.language')).toBe('undefined');
  });

  it('fuso inválido não quebra a página e não inventa horário', () => {
    const context = loadContentScript(Object.assign({}, PROFILE, { timezone: 'Invalido/Zona' }));
    // Idioma continua sendo aplicado (independe do fuso).
    expect(evaluate(context, 'navigator.language')).toBe('pt-BR');
    // Sem spoof de fuso: o valor é o do próprio ambiente, sem erro.
    const offset = evaluate(context, `new Date(${ONE_INSTANT}).getTimezoneOffset()`);
    expect(typeof offset).toBe('number');
    expect(evaluate(context, `new Date(${ONE_INSTANT}).toString()`)).toContain('GMT');
  });
});
describe('content.js — User-Agent Client Hints', () => {
  // Perfil macOS: a UA diz "Macintosh", mas o binário roda em Linux. Sem a
  // camada de Client Hints o navegador anuncia "Linux" e a versão real do
  // binário — a contradição que o whoer.net exibia como "OS: Linux".
  const MAC = Object.assign({}, PROFILE, {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
    platform: 'MacIntel',
    clientHints: {
      chromeMajor: 154, fullVersion: '154.0.8037.92', platform: 'macOS', platformVersion: '15.0.0'
    }
  });

  // Perfil antigo, sem o campo clientHints: precisa funcionar pela dedução.
  const WINDOWS = Object.assign({}, PROFILE, {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
    platform: 'Win32',
    clientHints: null
  });

  it('anuncia a plataforma do perfil, e não a do container', () => {
    const context = loadContentScript(MAC);
    expect(evaluate(context, 'navigator.userAgentData.platform')).toBe('macOS');
    expect(evaluate(context, 'navigator.userAgentData.mobile')).toBe(false);
  });

  it('as marcas trazem a versão major da própria UA', () => {
    const context = loadContentScript(MAC);
    expect(evaluate(context, 'JSON.stringify(navigator.userAgentData.brands)')).toBe(JSON.stringify([
      { brand: 'Chromium', version: '154' },
      { brand: 'Google Chrome', version: '154' },
      { brand: 'Not/A)Brand', version: '24' }
    ]));
  });

  it('toJSON repete o mesmo conjunto que as marcas', () => {
    const context = loadContentScript(MAC);
    const json = evaluate(context, 'JSON.stringify(navigator.userAgentData.toJSON())');
    expect(JSON.parse(json).platform).toBe('macOS');
  });

  it('getHighEntropyValues devolve o build completo e a plataforma do perfil', async () => {
    const context = loadContentScript(MAC);
    const valores = await evaluate(
      context,
      'navigator.userAgentData.getHighEntropyValues(["uaFullVersion","platform","architecture"])'
    );
    expect(valores.uaFullVersion).toBe('154.0.8037.92');
    expect(valores.platform).toBe('macOS');
    expect(valores.platformVersion).toBe('15.0.0');
    expect(valores.architecture).toBe('x86');
    expect(valores.bitness).toBe('64');
    expect(valores.fullVersionList[0].version).toBe('154.0.8037.92');
  });

  it('sem clientHints deduz plataforma e versão do próprio perfil', async () => {
    const context = loadContentScript(WINDOWS);
    expect(evaluate(context, 'navigator.userAgentData.platform')).toBe('Windows');
    const valores = await evaluate(context, 'navigator.userAgentData.getHighEntropyValues([])');
    // Sem o campo, a UA reduzida (Chrome/154.0.0.0) é o que existe.
    expect(valores.uaFullVersion).toBe('154.0.0.0');
    expect(valores.platformVersion).toBe('10.0.0');
    expect(valores.platform).toBe('Windows');
  });
});
