/**
 * MitmCaService
 *
 * Autoridade certificadora local do MITM: gera a chave e o certificado da CA,
 * emite um certificado por host sob demanda, e calcula o pin SPKI.
 *
 * Por que SPKI e não instalar a CA no container: a imagem do Chromium não traz
 * `certutil`, e escrever no store NSS na mão é frágil (o Chrome pode ignorar).
 * Com `--ignore-certificate-errors-spki-list` o Chrome aceita exatamente os
 * certificados cujo SPKI estiver na lista — e só eles. É mais estreito do que
 * confiar numa CA inteira, e não exige mexer no sistema de arquivos do browser.
 *
 * O CA é gerado UMA vez e guardado em disco: se mudasse a cada boot, o pin
 * mudaria e o Chrome recusaria tudo até a instância reiniciar.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Validade dos certificados emitidos. Curta de propósito: são descartáveis.
const LEAF_DAYS = 30;
// Validade da CA raiz.
const CA_DAYS = 3650;
// Quantos certificados de host ficam em memória antes de o cache ser limpo.
const MAX_CACHED_HOSTS = 500;

/** Diretório de dados, o mesmo critério do banco (ver src/database.js). */
function dataDir() {
  if (process.env.MITM_DATA_DIR) return process.env.MITM_DATA_DIR;
  if (process.env.DATABASE_PATH) return path.dirname(process.env.DATABASE_PATH);
  if (process.env.NODE_ENV === 'production') return '/app/data';
  return path.join(__dirname, '..', '..', 'data');
}

class MitmCaService {
  constructor() {
    this.dir = path.join(dataDir(), 'mitm');
    this.keyPath = path.join(this.dir, 'ca.key');
    this.certPath = path.join(this.dir, 'ca.crt');
    // host -> { key, cert, pin } (cert já em PEM)
    this.hosts = new Map();
    this._ca = null;
  }

  /** Caminho do certificado da CA (para diagnóstico e para o README). */
  caCertPath() {
    return this.certPath;
  }

  /**
   * Garante que a CA existe. Idempotente: se os arquivos já estão lá, reusa.
   * @returns {{key: string, cert: string}} PEM da CA
   */
  ensureCa() {
    if (this._ca) return this._ca;

    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(this.keyPath) || !fs.existsSync(this.certPath)) {
      this._generateCa();
    }
    this._ca = {
      key: fs.readFileSync(this.keyPath, 'utf-8'),
      cert: fs.readFileSync(this.certPath, 'utf-8')
    };
    return this._ca;
  }

  /** Gera a CA raiz (chave EC + certificado autoassinado). */
  _generateCa() {
    const key = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const keyPem = key.privateKey.export({ type: 'pkcs8', format: 'pem' });

    // O certificado é montado via openssl: gerar X.509 à mão em JS puro exigiria
    // uma dependência só para isto.
    const tmpKey = path.join(this.dir, '.ca.key.tmp');
    const tmpCnf = path.join(this.dir, '.ca.cnf.tmp');
    fs.writeFileSync(tmpKey, keyPem, { mode: 0o600 });
    fs.writeFileSync(tmpCnf, [
      '[req]',
      'distinguished_name=dn',
      'x509_extensions=v3',
      'prompt=no',
      '[dn]',
      'CN=Chrome VPN Dashboard Local CA',
      'O=Chrome VPN Dashboard',
      '[v3]',
      'basicConstraints=critical,CA:TRUE',
      'keyUsage=critical,keyCertSign,cRLSign',
      'subjectKeyIdentifier=hash'
    ].join('\n'), 'utf-8');

    try {
      execFileSync('openssl', [
        'req', '-x509', '-new', '-key', tmpKey,
        '-days', String(CA_DAYS), '-sha256',
        '-config', tmpCnf,
        '-out', this.certPath
      ], { stdio: 'pipe' });
    } finally {
      fs.rmSync(tmpKey, { force: true });
      fs.rmSync(tmpCnf, { force: true });
    }

    fs.writeFileSync(this.keyPath, keyPem, { mode: 0o600 });
    console.log(`[INFO] [mitm] CA local gerada em ${this.certPath}`);
  }

  /**
   * Certificado para um host, emitido sob demanda e cacheado.
   * @param {string} host nome do servidor de destino
   * @returns {{key: string, cert: string, pin: string}}
   */
  certificateFor(host) {
    const name = String(host || '').toLowerCase();
    if (!name) throw new Error('host obrigatório');
    const cached = this.hosts.get(name);
    if (cached) return cached;

    const ca = this.ensureCa();
    // Chave do host DETERMINÍSTICA: derivada da chave da CA + nome do host.
    //
    // Por que não aleatória: o pin SPKI é o que vai no CHROME_CLI do Chrome. Se
    // a chave mudasse a cada processo, o pin mudaria e o Chrome passaria a
    // recusar o certificado depois de qualquer reinício do dashboard — o perfil
    // ficaria sem abrir nenhuma página HTTPS até a instância ser recriada.
    const keyPem = this._hostKey(ca.key, name);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mitm-leaf-'));
    const tmpKey = path.join(tmpDir, 'leaf.key');
    const tmpCsr = path.join(tmpDir, 'leaf.csr');
    const tmpCrt = path.join(tmpDir, 'leaf.crt');
    const tmpCaKey = path.join(tmpDir, 'ca.key');
    const tmpCaCrt = path.join(tmpDir, 'ca.crt');
    const tmpExt = path.join(tmpDir, 'leaf.ext');

    fs.writeFileSync(tmpKey, keyPem, { mode: 0o600 });
    fs.writeFileSync(tmpCaKey, ca.key, { mode: 0o600 });
    fs.writeFileSync(tmpCaCrt, ca.cert, 'utf-8');
    // SAN obrigatório: o Chrome ignora o CN e valida só pelos nomes alternativos.
    fs.writeFileSync(tmpExt, [
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      `subjectAltName=DNS:${name}`
    ].join('\n'), 'utf-8');

    try {
      execFileSync('openssl', [
        'req', '-new', '-key', tmpKey, '-subj', `/CN=${name}`, '-out', tmpCsr
      ], { stdio: 'pipe' });
      execFileSync('openssl', [
        'x509', '-req', '-in', tmpCsr,
        '-CA', tmpCaCrt, '-CAkey', tmpCaKey,
        '-set_serial', '0x' + this._hostSerial(name),
        '-days', String(LEAF_DAYS), '-sha256',
        '-extfile', tmpExt,
        '-out', tmpCrt
      ], { stdio: 'pipe' });

      const cert = fs.readFileSync(tmpCrt, 'utf-8');
      const entry = { key: keyPem, cert, pin: this.pinFor(cert) };

      // Cache limitado: um perfil que navega muito não pode crescer sem fim.
      if (this.hosts.size >= MAX_CACHED_HOSTS) {
        this.hosts.clear();
      }
      this.hosts.set(name, entry);
      return entry;
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  /**
   * Chave privada do certificado de um host, derivada da chave da CA.
   *
   * HKDF(chave da CA, host) -> 32 bytes -> chave EC P-256. Determinística de
   * propósito: o pin SPKI tem de ser o mesmo em todo boot, senão o Chrome
   * recusa o certificado depois de qualquer reinício do dashboard.
   */
  _hostKey(caKeyPem, host) {
    const ikm = this._pemToDer(caKeyPem);
    const seed = Buffer.from(
      crypto.hkdfSync('sha256', ikm, Buffer.from('mitm-host-key'), Buffer.from(host), 32)
    );
    // O escalar privado do P-256 tem de ser menor que a ordem da curva. Zerar o
    // primeiro byte deixa o valor com folga confortável abaixo de n.
    const scalar = Buffer.from(seed);
    scalar[0] = 0;
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(scalar);
    return this._ecPrivateKeyPem(ecdh);
  }

  /** Empacota a chave privada EC de volta em PEM PKCS#8. */
  _ecPrivateKeyPem(ecdh) {
    const pub = ecdh.getPublicKey();
    const keyObject = crypto.createPrivateKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        d: ecdh.getPrivateKey().toString('base64url'),
        x: pub.subarray(1, 33).toString('base64url'),
        y: pub.subarray(33, 65).toString('base64url')
      },
      format: 'jwk'
    });
    return keyObject.export({ type: 'pkcs8', format: 'pem' });
  }

  /** Serial determinístico do certificado de um host. */
  _hostSerial(host) {
    return crypto.createHash('sha256').update(`serial:${host}`).digest('hex').slice(0, 32);
  }

  /**
   * Pin SPKI no formato que `--ignore-certificate-errors-spki-list` espera:
   * base64 do SHA-256 da chave pública (SubjectPublicKeyInfo) do certificado.
   *
   * @param {string} certPem certificado em PEM
   * @returns {string} pin em base64
   */
  pinFor(certPem) {
    const der = this._pemToDer(certPem);
    // Extrai o SPKI do DER sem depender de openssl: percorre a estrutura.
    const spki = this._spkiFromDer(der);
    return crypto.createHash('sha256').update(spki).digest('base64');
  }

  /** PEM (certificado ou chave) -> DER. */
  _pemToDer(pem) {
    const match = String(pem).match(/-----BEGIN [^-]+-----([\s\S]*?)-----END [^-]+-----/);
    if (!match) throw new Error('PEM inválido');
    return Buffer.from(match[1].replace(/\s+/g, ''), 'base64');
  }

  /**
   * Extrai o SubjectPublicKeyInfo de um certificado DER.
   *
   * Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signature }
   * tbsCertificate ::= SEQUENCE { [0] version, serial, signature, issuer,
   *                                validity, subject, subjectPublicKeyInfo, ... }
   *
   * Lê os comprimentos TLV na mão: é pouca coisa e evita uma dependência ASN.1.
   */
  _spkiFromDer(der) {
    const readTlv = (buf, offset) => {
      const tag = buf[offset];
      let len = buf[offset + 1];
      let headerLen = 2;
      if (len & 0x80) {
        const bytes = len & 0x7f;
        len = 0;
        for (let i = 0; i < bytes; i += 1) {
          len = (len << 8) | buf[offset + 2 + i];
        }
        headerLen = 2 + bytes;
      }
      return { tag, start: offset + headerLen, length: len, end: offset + headerLen + len };
    };

    const cert = readTlv(der, 0);
    if (cert.tag !== 0x30) throw new Error('certificado não é SEQUENCE');
    const tbs = readTlv(der, cert.start);
    if (tbs.tag !== 0x30) throw new Error('tbsCertificate não é SEQUENCE');

    let cursor = tbs.start;
    // [0] version (opcional)
    const first = readTlv(der, cursor);
    if (first.tag === 0xa0) cursor = first.end;

    // serial, signature, issuer, validity, subject
    for (let i = 0; i < 5; i += 1) {
      cursor = readTlv(der, cursor).end;
    }
    // O próximo elemento é o subjectPublicKeyInfo.
    const spki = readTlv(der, cursor);
    if (spki.tag !== 0x30) throw new Error('subjectPublicKeyInfo não é SEQUENCE');
    return der.subarray(cursor, spki.end);
  }

  /** Limpa o cache de certificados de host (usado em testes). */
  reset() {
    this.hosts.clear();
    this._ca = null;
  }
}

module.exports = new MitmCaService();
module.exports.dataDir = dataDir;
module.exports.LEAF_DAYS = LEAF_DAYS;
module.exports.CA_DAYS = CA_DAYS;
