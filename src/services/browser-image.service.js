/**
 * BrowserImageService
 *
 * Imagem do navegador CloakBrowser usada pelas instâncias: a imagem oficial
 * com um acréscimo — o Xvfb dá lugar ao KasmVNC, que passa a nascer no tamanho
 * de tela que o perfil declara e já publica o cliente web da tela (ver
 * deploy/browser-image/Dockerfile).
 *
 * Por que isso é um serviço separado da regra do CloakBrowser: aqui mora só o
 * CICLO DE VIDA da imagem (construir quando falta, nomear). As regras do
 * navegador (flags, comando, ambiente) ficam no cloakbrowser.service.
 *
 * A imagem NÃO é publicada em registry: é construída localmente, uma vez por
 * host, na primeira instância CloakBrowser. Como ela deriva da imagem oficial
 * (que já está no host para rodar qualquer perfil), o custo é uma camada.
 */
const fs = require('fs');
const path = require('path');
const Docker = require('dockerode');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const DEFAULT_IMAGE = 'chrome-vpn-dashboard-browser:latest';
// Imagem oficial por baixo (a mesma que o dashboard usaria sem este patch).
const DEFAULT_BASE_IMAGE = 'cloakhq/cloakbrowser:latest';
// Só o Dockerfile entra no contexto de build.
const BUILD_CONTEXT = ['Dockerfile'];

/** Converte CRLF → LF (o repositório é editado no Windows). */
function toLf(content) {
  return content.replace(/\r\n/g, '\n');
}

class BrowserImageService {
  /** Imagem do navegador usada nas instâncias (sobrescrevível por env). */
  image() {
    const configured = String(process.env.BROWSER_IMAGE || '').trim();
    return configured || DEFAULT_IMAGE;
  }

  /** Imagem oficial que serve de base para o build. */
  baseImage() {
    const configured = String(process.env.CLOAKBROWSER_IMAGE || '').trim();
    return configured || DEFAULT_BASE_IMAGE;
  }

  /** Caminho do contexto de build no repositório. */
  sourceDir() {
    return path.join(__dirname, '..', '..', 'deploy', 'browser-image');
  }

  /**
   * Garante a imagem do navegador. Ela é local (não vem de registry), então
   * "não existe" significa "construir", nunca "baixar".
   */
  async ensureImage() {
    const image = this.image();
    try {
      await docker.getImage(image).inspect();
      return image;
    } catch (err) {
      if (err.statusCode !== 404) throw err;
    }

    console.log(`[INFO] [browser-image] Construindo a imagem do navegador (${image})...`);
    await this._buildImage();
    console.log(`[INFO] [browser-image] Imagem do navegador pronta (${image})`);
    return image;
  }

  /**
   * Constrói a partir de uma cópia temporária do contexto, com os arquivos
   * normalizados para LF — o build precisa funcionar mesmo com o repositório
   * editado no Windows.
   */
  async _buildImage() {
    const context = fs.mkdtempSync(path.join(require('os').tmpdir(), 'browser-image-'));

    try {
      for (const name of BUILD_CONTEXT) {
        const file = path.join(this.sourceDir(), name);
        fs.writeFileSync(path.join(context, name), toLf(fs.readFileSync(file, 'utf-8')), 'utf-8');
      }
      const stream = await docker.buildImage(
        { context, src: BUILD_CONTEXT },
        { t: this.image(), buildargs: { BROWSER_BASE_IMAGE: this.baseImage() } }
      );
      await new Promise((resolve, reject) => {
        docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
      });
    } finally {
      fs.rmSync(context, { recursive: true, force: true });
    }
  }
}

module.exports = new BrowserImageService();
module.exports.DEFAULT_IMAGE = DEFAULT_IMAGE;
module.exports.DEFAULT_BASE_IMAGE = DEFAULT_BASE_IMAGE;
module.exports.BUILD_CONTEXT = BUILD_CONTEXT;
module.exports.toLf = toLf;
