/**
 * ChromiumImageService
 *
 * Imagem do Chromium usada pelo dashboard: a oficial da LinuxServer
 * (`lscr.io/linuxserver/chromium`) com UMA alteração — o `--test-type` sai do
 * wrapper `/usr/bin/wrapped-chromium` (ver deploy/chromium-image/Dockerfile).
 *
 * Por que só isso: o `--test-type` marca o navegador como "modo de teste", e
 * alguns serviços de login e detectores de anti-bot conseguem ver esse estado.
 * As outras flags que a imagem embute ficam como estão.
 *
 * O CloakBrowser NÃO passa por aqui: lá o `--test-type` já é opt-in, ligado por
 * CLOAKBROWSER_TEST_TYPE (ver cloakbrowser.service).
 *
 * A imagem NÃO é publicada em registry: é construída localmente, uma vez por
 * host, na primeira instância Chromium. Como deriva da imagem oficial (que já
 * está no host), o custo é uma camada.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Docker = require('dockerode');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// Repositório da imagem derivada. A TAG acompanha a da base, para a versão
// antiga e a nova poderem coexistir sem uma sobrescrever a outra.
const DEFAULT_IMAGE = 'chrome-vpn-dashboard-chromium:latest';
// Imagem oficial por baixo (a mesma que o dashboard usaria sem este patch).
const DEFAULT_BASE_IMAGE = 'lscr.io/linuxserver/chromium:latest';
// O que entra no contexto de build: só o Dockerfile (ele não copia arquivos).
const BUILD_CONTEXT = ['Dockerfile'];
// Etiqueta que guarda a impressão da receita na imagem construída.
const RECIPE_LABEL = 'dashboard.recipe';

/** Converte CRLF → LF (o repositório é editado no Windows). */
function toLf(content) {
  return content.replace(/\r\n/g, '\n');
}

class ChromiumImageService {
  /** Repositório das imagens derivadas (sem tag). */
  repo() {
    const configured = String(process.env.CHROMIUM_IMAGE || '').trim() || DEFAULT_IMAGE;
    const match = configured.match(/^(.*):([^/:]+)$/);
    return match ? match[1] : configured;
  }

  /** Tag de uma imagem de referência ("…:latest" → "latest"). */
  tagOf(reference) {
    const match = String(reference || '').match(/:([^/:]+)$/);
    return match ? match[1] : 'latest';
  }

  /** Imagem derivada de uma base. */
  imageFor(baseImage) {
    const base = String(baseImage || this.baseImage());
    return `${this.repo()}:${this.tagOf(base).replace(/[^A-Za-z0-9_.-]/g, '-')}`;
  }

  /** Imagem derivada da base por omissão (assinatura curta). */
  image(baseImage) {
    return this.imageFor(baseImage || this.baseImage());
  }

  /** Imagem oficial que serve de base para o build (sobrescrevível por env). */
  baseImage() {
    const configured = String(process.env.CHROMIUM_BASE_IMAGE || '').trim();
    return configured || DEFAULT_BASE_IMAGE;
  }

  /** Caminho do contexto de build no repositório. */
  sourceDir() {
    return path.join(__dirname, '..', '..', 'deploy', 'chromium-image');
  }

  /**
   * Impressão da RECEITA da imagem: o Dockerfile, com o mesmo fim de linha que
   * o build usa.
   *
   * Por que existe: a imagem é construída UMA vez por host e nunca mais. Sem
   * esta impressão, mudar o Dockerfile não teria efeito nenhum nos hosts que já
   * têm a imagem antiga — a instância continuaria a subir com o `--test-type`.
   */
  recipe() {
    const hash = crypto.createHash('sha256');
    for (const name of BUILD_CONTEXT) {
      hash.update(name);
      hash.update(toLf(fs.readFileSync(path.join(this.sourceDir(), name), 'utf-8')));
    }
    return hash.digest('hex').slice(0, 16);
  }

  /**
   * Garante a imagem derivada de uma base. Ela é local (não vem de registry),
   * então "não existe" significa "construir", nunca "baixar".
   */
  async ensureImage(baseImage) {
    const base = baseImage || this.baseImage();
    const image = this.imageFor(base);
    const recipe = this.recipe();
    try {
      const info = await docker.getImage(image).inspect();
      // A etiqueta diz de que receita a imagem veio: sem ela (imagem de antes
      // desta marcação) ou com impressão diferente, a imagem não serve.
      if (((info.Config || {}).Labels || {})[RECIPE_LABEL] === recipe) return image;
      console.log(`[INFO] [chromium-image] ${image} veio de uma receita antiga — reconstruindo...`);
    } catch (err) {
      if (err.statusCode !== 404) throw err;
    }

    console.log(`[INFO] [chromium-image] Construindo ${image} a partir de ${base}...`);
    await this._buildImage(image, base, recipe);
    console.log(`[INFO] [chromium-image] Imagem do Chromium pronta (${image})`);
    return image;
  }

  /**
   * Constrói a partir de uma cópia temporária do contexto, com o Dockerfile
   * normalizado para LF — o build precisa de funcionar mesmo com o repositório
   * editado no Windows.
   */
  async _buildImage(image, base, recipe) {
    const context = fs.mkdtempSync(path.join(require('os').tmpdir(), 'chromium-image-'));

    try {
      for (const name of BUILD_CONTEXT) {
        const file = path.join(this.sourceDir(), name);
        fs.writeFileSync(path.join(context, name), toLf(fs.readFileSync(file, 'utf-8')), 'utf-8');
      }
      const stream = await docker.buildImage(
        { context, src: BUILD_CONTEXT },
        {
          t: image,
          buildargs: { CHROMIUM_BASE_IMAGE: base, DASHBOARD_RECIPE: recipe },
          labels: { [RECIPE_LABEL]: recipe }
        }
      );
      await new Promise((resolve, reject) => {
        docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
      });
    } finally {
      fs.rmSync(context, { recursive: true, force: true });
    }
  }
}

module.exports = new ChromiumImageService();
module.exports.DEFAULT_IMAGE = DEFAULT_IMAGE;
module.exports.DEFAULT_BASE_IMAGE = DEFAULT_BASE_IMAGE;
module.exports.BUILD_CONTEXT = BUILD_CONTEXT;
module.exports.RECIPE_LABEL = RECIPE_LABEL;
module.exports.toLf = toLf;