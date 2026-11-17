/**
 * MITM para HTTPS: reescrita de cabeçalhos de identidade.
 *
 * O que estes testes travam: que o `User-Agent` e os `Sec-CH-UA*` que saem no
 * fio sejam EXATAMENTE os mesmos que a extensão publica em
 * `navigator.userAgentData`. Se as duas camadas discordarem, a página passa a
 * ter duas identidades e o problema que o MITM resolve volta pior.
 */
const httpHeaders = require('../src/services/http-headers.service');

const FINGERPRINT = {
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
  platform: 'MacIntel',
  clientHints: {
    chromeMajor: 154,
    fullVersion: '154.0.8037.92',
    platform: 'macOS',
    platformVersion: '15.0.0'
  }
};

describe('cabeçalhos de identidade', () => {
  it('deriva UA e Client Hints do fingerprint', () => {
    const h = httpHeaders.headersFor(FINGERPRINT);

    expect(h['user-agent']).toBe(FINGERPRINT.userAgent);
    expect(h['sec-ch-ua-mobile']).toBe('?0');
    expect(h['sec-ch-ua-full-version']).toBe('"154.0.8037.92"');
  });

  it('usa a versão maior reduzida na lista de marcas', () => {
    const h = httpHeaders.headersFor(FINGERPRINT);

    // A UA é reduzida (154.0.0.0) mas o cabeçalho de marcas usa só a maior,
    // como o Chrome real faz.
    expect(h['sec-ch-ua']).toContain('"Chromium";v="154"');
    expect(h['sec-ch-ua']).toContain('"Google Chrome";v="154"');
    expect(h['sec-ch-ua']).toContain('"Not/A)Brand";v="24"');
  });

  it('a lista completa leva o build real, não a versão reduzida', () => {
    const h = httpHeaders.headersFor(FINGERPRINT);

    expect(h['sec-ch-ua-full-version-list']).toContain('"Google Chrome";v="154.0.8037.92"');
    // O marcador GREASE mantém a versão fixa mesmo aqui.
    expect(h['sec-ch-ua-full-version-list']).toContain('"Not/A)Brand";v="24"');
  });

  it('a arquitetura acompanha a plataforma do perfil', () => {
    const mac = httpHeaders.headersFor(FINGERPRINT);
    expect(mac['sec-ch-ua-arch']).toBe('"arm"');

    const win = httpHeaders.headersFor(Object.assign({}, FINGERPRINT, {
      clientHints: Object.assign({}, FINGERPRINT.clientHints, { platform: 'Windows' })
    }));
    expect(win['sec-ch-ua-arch']).toBe('"x86"');
  });

  it('sem userAgent no perfil não inventa cabeçalho nenhum', () => {
    expect(httpHeaders.headersFor(null)).toBeNull();
    expect(httpHeaders.headersFor({})).toBeNull();
    expect(httpHeaders.headersFor({ platform: 'MacIntel' })).toBeNull();
  });

  it('reescreve o bloco preservando ordem e o resto dos cabeçalhos', () => {
    const block = [
      'Host: example.com',
      'User-Agent: Mozilla/5.0 (X11; Linux x86_64) Chrome/154.0.0.0',
      'Accept: text/html',
      'Sec-CH-UA: "Chromium";v="154"'
    ].join('\r\n');

    const out = httpHeaders.rewriteBlock(block, httpHeaders.headersFor(FINGERPRINT));
    const lines = out.split('\r\n');

    expect(lines[0]).toBe('Host: example.com');
    expect(lines[1]).toBe(`User-Agent: ${FINGERPRINT.userAgent}`);
    expect(lines[2]).toBe('Accept: text/html');
    expect(lines[3]).toContain('"Google Chrome";v="154"');
  });

  it('não acrescenta hints que o cliente não enviou', () => {
    // Um Chrome que não pediu Sec-CH-UA-Arch não deve passar a pedir só porque
    // sabemos o valor — isso seria uma assinatura nova, não um disfarce.
    const block = 'Host: example.com\r\nUser-Agent: Mozilla/5.0 (X11; Linux x86_64)';
    const out = httpHeaders.rewriteBlock(block, httpHeaders.headersFor(FINGERPRINT));

    expect(out).not.toContain('Sec-CH-UA-Arch');
    expect(out).not.toContain('sec-ch-ua-arch');
  });

  it('reescreve a requisição inteira sem tocar na linha de requisição', () => {
    const head = 'GET / HTTP/1.1\r\nHost: example.com\r\nUser-Agent: Mozilla/5.0 (X11; Linux x86_64)\r\n\r\n';
    const out = httpHeaders.rewriteRequestHead(head, httpHeaders.headersFor(FINGERPRINT));

    expect(out.startsWith('GET / HTTP/1.1\r\n')).toBe(true);
    expect(out).toContain(FINGERPRINT.userAgent);
    expect(out).not.toContain('X11; Linux x86_64');
    expect(out.endsWith('\r\n\r\n')).toBe(true);
  });

  it('sem cabeçalhos para reescrever devolve o bloco intacto', () => {
    const head = 'GET / HTTP/1.1\r\nHost: example.com\r\n\r\n';
    expect(httpHeaders.rewriteRequestHead(head, null)).toBe(head);
  });
});
