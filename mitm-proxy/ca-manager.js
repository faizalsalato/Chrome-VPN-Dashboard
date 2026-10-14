/**
 * Gerenciador de CA para MITM.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class CAManager {
  constructor(certPath, keyPath, subject) {
    this.certPath = certPath;
    this.keyPath = keyPath;
    this.subject = subject;
  }

  isReady() {
    try {
      fs.accessSync(this.certPath, fs.constants.R_OK);
      fs.accessSync(this.keyPath, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  async ensure() {
    if (this.isReady()) return true;
    return this.generate();
  }

  async generate() {
    return new Promise((resolve, reject) => {
      const ext =
        'basicConstraints=CA:FALSE,' +
        'keyUsage=digitalSignature,' +
        'subjectAltName=DNS:localhost,DNS:*.localhost';

      crypto.createCertificate({
        serialNumber: crypto.randomBytes(8).toString('hex'),
        validityPeriodDays: 365,
        subject: this.subject || '/C=US/ST=California/L=San Francisco/O=MitmProxy/CN=*.localhost',
        extensions: [ext],
      }).then(({ cert, key }) => {
        this.cert = cert;
        this.key = key;
        if (this.certPath && this.keyPath) {
          fs.mkdirSync(path.dirname(this.certPath), { recursive: true });
          fs.writeFileSync(this.certPath, cert);
          fs.writeFileSync(this.keyPath, key);
        }
        resolve(true);
      }).catch(reject);
    });
  }

  get privateKey() {
    return this.key;
  }

  get certificate() {
    return this.cert;
  }
}

module.exports = CAManager;
