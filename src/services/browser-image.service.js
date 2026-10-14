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
  /**
   * Repositório das imagens derivadas (sem tag). `BROWSER_IMAGE` continua a
   * mandar no nome, mas só na parte do repositório: a TAG passa a acompanhar a
   * da imagem base, para a versão antiga e a nova do CloakBrowser poderem
   * coexistir (uma derivada por versão) sem uma sobrescrever a outra.
   */
  repo() {
    const configured = String(process.env.BROWSER_IMAGE || '').trim() || DEFAULT_IMAGE;
    // Tira a tag — mas só quando o que vem depois do último ':' não é a porta
    // de um registry (nesse caso há uma '/' depois).
    const match = configured.match(/^(.*):([^/:]+)$/);
    return match ? match[1] : configured;
  }

  /** Tag de uma imagem de referência ("…:0.5.12" → "0.5.12"). */
  tagOf(reference) {
    const match = String(reference || '').match(/:([^/:]+)$/);
    return match ? match[1] : 'latest';
  }

  /**
   * Imagem derivada de uma base. Base `…:latest` → `…:latest` (o nome
   * histórico, que já existe nos hosts); base `…:0.5.12` → `…:0.5.12`.
   */
  imageFor(baseImage) {
    const base = String(baseImage || this.baseImage());
    return `${this.repo()}:${this.tagOf(base).replace(/[^A-Za-z0-9_.-]/g, '-')}`;
  }

  /** Imagem derivada da base por omissão (assinatura histórica). */
  image(baseImage) {
    return this.imageFor(baseImage || this.baseImage());
  }

  /** Imagem oficial que serve de base para o build (sobrescrevível por env). */
  baseImage() {
    const configured = String(process.env.CLOAKBROWSER_IMAGE || '').trim();
    return configured || DEFAULT_BASE_IMAGE;
  }

  /** Caminho do contexto de build no repositório. */
  sourceDir() {
    return path.join(__dirname, '..', '..', 'deploy', 'browser-image');
  }

  /**
   * Garante a imagem derivada de uma base. Ela é local (não vem de registry),
   * então "não existe" significa "construir", nunca "baixar".
   */
  async ensureImage(baseImage) {
    const base = baseImage || this.baseImage();
    const image = this.imageFor(base);
    try {
      await docker.getImage(image).inspect();
      return image;
    } catch (err) {
      if (err.statusCode !== 404) throw err;
    }

    console.log(`[INFO] [browser-image] Construindo ${image} a partir de ${base}...`);
    await this._buildImage(image, base);
    console.log(`[INFO] [browser-image] Imagem do navegador pronta (${image})`);
    return image;
  }

  /**
   * Constrói a partir de uma cópia temporária do contexto, com os arquivos
   * normalizados para LF — o build precisa de funcionar mesmo com o repositório
   * editado no Windows.
   */
  async _buildImage(image, base) {
    const context = fs.mkdtempSync(path.join(require('os').tmpdir(), 'browser-image-'));

    try {
      for (const name of BUILD_CONTEXT) {
        const file = path.join(this.sourceDir(), name);
        fs.writeFileSync(path.join(context, name), toLf(fs.readFileSync(file, 'utf-8')), 'utf-8');
      }
      const stream = await docker.buildImage(
        { context, src: BUILD_CONTEXT },
        { t: image, buildargs: { BROWSER_BASE_IMAGE: base } }
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
