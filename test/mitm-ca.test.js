/**
 * MITM: CA local e certificados por host.
 *
 * Estes testes precisam de `openssl` no PATH (é o que emite os certificados).
 * Sem ele, são pulados em vez de falharem — o alvo real é o servidor Linux, e
 * uma máquina Windows de desenvolvimento não deve marcar a suíte como quebrada.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function hasOpenssl() {
  try {
    execFileSync('openssl', ['version'], { stdio: 'pipe' });
    return true;
  } catch (_) {
    return false;
  }
}

const describeWithOpenssl = hasOpenssl() ? describe : describe.skip;

describeWithOpenssl('CA local do MITM', () => {
  let mitmCa;
  let tmpDir;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mitm-ca-test-'));
    process.env.MITM_DATA_DIR = tmpDir;
    // Recarrega o módulo para ele pegar o diretório temporário.
    jest.resetModules();
    mitmCa = require('../src/services/mitm-ca.service');
  });

  afterAll(() => {
    delete process.env.MITM_DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('gera a CA uma vez e reusa', () => {
    const first = mitmCa.ensureCa();
    const second = mitmCa.ensureCa();

    expect(first.cert).toContain('BEGIN CERTIFICATE');
    expect(first.key).toContain('PRIVATE KEY');
    // Reusar é obrigatório: se a CA mudasse, todo pin já entregue ao Chrome
    // deixaria de valer e o navegador recusaria tudo.
    expect(second.cert).toBe(first.cert);
    expect(fs.existsSync(mitmCa.caCertPath())).toBe(true);
  });

  it('emite certificado por host com SAN', () => {
    const leaf = mitmCa.certificateFor('example.com');

    expect(leaf.cert).toContain('BEGIN CERTIFICATE');
    expect(leaf.key).toContain('PRIVATE KEY');
    expect(leaf.pin).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it('o certificado do host é assinado pela CA local', () => {
    const leaf = mitmCa.certificateFor('example.com');
    const caCert = mitmCa.ensureCa().cert;

    const leafFile = path.join(tmpDir, 'leaf.pem');
    const caFile = path.join(tmpDir, 'ca.pem');
    fs.writeFileSync(leafFile, leaf.cert);
    fs.writeFileSync(caFile, caCert);

    // verify devolve 0 e imprime "OK" quando a cadeia fecha.
    const out = execFileSync('openssl', ['verify', '-CAfile', caFile, leafFile], { stdio: 'pipe' });
    expect(out.toString()).toContain('OK');
  });

  it('o pin é o SHA-256 do SPKI, no formato do Chrome', () => {
    const leaf = mitmCa.certificateFor('example.com');

    // Caminho independente: extrai a chave pública com openssl e hasheia.
    const leafFile = path.join(tmpDir, 'pin-leaf.pem');
    fs.writeFileSync(leafFile, leaf.cert);
    const pubPem = execFileSync('openssl', ['x509', '-in', leafFile, '-pubkey', '-noout'], { stdio: 'pipe' });
    const pubDer = execFileSync('openssl', ['pkey', '-pubin', '-outform', 'der'], { input: pubPem, stdio: 'pipe' });
    const digest = require('crypto').createHash('sha256').update(pubDer).digest('base64');

    expect(leaf.pin).toBe(digest);
  });

  it('cacheia o certificado do mesmo host', () => {
    const a = mitmCa.certificateFor('cache.example');
    const b = mitmCa.certificateFor('cache.example');

    expect(b).toBe(a);
  });

  it('hosts diferentes recebem certificados diferentes', () => {
    const a = mitmCa.certificateFor('um.example');
    const b = mitmCa.certificateFor('dois.example');

    expect(a.cert).not.toBe(b.cert);
    expect(a.pin).not.toBe(b.pin);
  });

  it('recusa host vazio', () => {
    expect(() => mitmCa.certificateFor('')).toThrow();
  });
});
