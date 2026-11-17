/**
 * updateImage — baixa de novo a imagem de um navegador e devolve o que mudou.
 *
 * Por que não é só `docker pull`: nas imagens DERIVADAS (Chromium) o pull é da
 * BASE, e a derivada precisa ser reconstruída em cima dela. Se só puxasse a
 * base, a instância continuaria a subir com a derivada antiga e o operador
 * acharia que atualizou.
 *
 * O que este método garante:
 *   1. puxa a base do registry (sempre, não só quando falta)
 *   2. reconstrói a derivada quando existe (Chromium; o CloakBrowser tem a sua
 *      própria via, que baixa o binário do vendor com a chave)
 *   3. devolve os digests antes/depois, para a página poder dizer se algo mudou
 *      de fato — "atualizado" sem mudança de digest é conversa
 *
 * NÃO recria instâncias: quem decide interromper sessão de usuário é o
 * operador, e isso é uma ação separada e confirmada.
 */
const Docker = require('dockerode');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const PULL_TIMEOUT_MS = 10 * 60 * 1000;

/** Digest local de uma imagem, ou null quando ela não está no host. */
async function digestOf(image, client = docker) {
  try {
    const info = await client.getImage(image).inspect();
    const digests = info.RepoDigests || [];
    if (!digests.length) return null;
    const first = String(digests[0]);
    const at = first.indexOf('@');
    return at === -1 ? first : first.slice(at + 1);
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

/** Puxa uma imagem do registry, sempre (não só quando falta). */
async function pull(image, client = docker) {
  const stream = await client.pull(image);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`pull de ${image} passou de ${PULL_TIMEOUT_MS / 60000} min`)),
      PULL_TIMEOUT_MS
    );
    client.modem.followProgress(
      stream,
      (err) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

/**
 * Atualiza a imagem de um navegador.
 *
 * @param {string} browser 'chromium' | 'brave' | 'firefox' | 'cloakbrowser'
 * @param {object} options client (para testes) e edition (CloakBrowser)
 * @returns {Promise<{browser:string, image:string, baseImage:string|null,
 *   before:string|null, after:string|null, changed:boolean,
 *   rebuilt:boolean, error:string|null}>}
 */
async function updateImage(browser, { client = docker, edition } = {}) {
  // Requires tardios: estes serviços carregam dockerode e criam conexão, e o
  // require no topo deixaria o ciclo de dependências mais apertado.
  const chromeContainer = require('./chrome-container.service');
  const chromiumImage = require('./chromium-image.service');
  const cloakbrowser = require('./cloakbrowser.service');

  const result = {
    browser,
    image: null,
    baseImage: null,
    before: null,
    after: null,
    changed: false,
    rebuilt: false,
    error: null
  };

  try {
    if (cloakbrowser.isCloakBrowser(browser)) {
      // O CloakBrowser não se atualiza por pull: o binário vem do vendor com a
      // chave (POST /api/admin/cloak/update). Dizer isso é melhor do que puxar
      // a imagem e fingir que atualizou o navegador.
      result.image = cloakbrowser.image(edition);
      result.baseImage = cloakbrowser.baseImage(edition);
      result.error =
        'O CloakBrowser atualiza pelo binário do vendor (botão "Atualizar binário Pro"), não por pull de imagem';
      return result;
    }

    if (browser === 'chromium') {
      // Derivada: puxa a base e reconstrói em cima.
      const base = chromiumImage.baseImage();
      const derived = chromiumImage.imageFor(base);
      result.baseImage = base;
      result.image = derived;

      result.before = await digestOf(base, client);
      await pull(base, client);
      result.after = await digestOf(base, client);

      // Reconstrói sempre: a receita pode ter mudado mesmo com a base igual, e
      // o ensureImage já sabe decidir pelo rótulo da receita.
      await chromiumImage.ensureImage(base);
      result.rebuilt = true;
      result.changed = result.before !== result.after || result.before === null;
      return result;
    }

    // Brave / Firefox: imagem oficial direta, sem derivada.
    const image = chromeContainer.imageFor(browser);
    result.image = image;
    result.baseImage = image;

    result.before = await digestOf(image, client);
    await pull(image, client);
    result.after = await digestOf(image, client);
    result.changed = result.before !== result.after || result.before === null;
    return result;
  } catch (err) {
    result.error = err.message || 'falha ao atualizar a imagem';
    return result;
  }
}

module.exports = {
  updateImage,
  digestOf,
  pull,
  PULL_TIMEOUT_MS
};
