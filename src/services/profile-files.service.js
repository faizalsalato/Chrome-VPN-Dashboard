/**
 * ProfileFilesService — ficheiros que o usuário manda para o perfil do navegador.
 *
 * Por que existe: para publicar nas redes o ficheiro (foto/vídeo) tem de estar
 * DENTRO do perfil — o seletor de ficheiros do site abre o sistema de ficheiros
 * do container, não o computador de quem usa o dashboard. Aqui o dashboard
 * recebe o ficheiro, valida o nome e grava-o na pasta de Downloads do perfil
 * (é o sítio que o seletor abre por omissão).
 */
const bookmarks = require('./bookmarks.service');

// Pasta de Downloads de cada navegador, com a raiz de onde o putArchive extrai
// (tem de ser uma pasta que já exista: /config nas imagens da LinuxServer,
// /profile no CloakBrowser).
const DOWNLOAD_DIRS = {
  chromium: { root: '/config', dir: 'Downloads' },
  brave: { root: '/config', dir: 'Downloads' },
  cloakbrowser: { root: '/profile', dir: 'Downloads' }
};

// Teto por ficheiro, em bytes. Vazio ou 0 = SEM TETO: no caminho de streaming o
// ficheiro vai direto para o disco do servidor, então o único limite passa a ser
// o espaço em disco. A variável existe para travar um envio gigante por engano
// (MAX_UPLOAD_BYTES, no serviço do dashboard), sem mexer no código.
const DEFAULT_MAX_BYTES = 0;

/** Teto por ficheiro, lido do ambiente a cada uso (0 = sem teto). */
function maxBytes() {
  const configured = String(process.env.MAX_UPLOAD_BYTES || '').trim();
  if (!configured) return DEFAULT_MAX_BYTES;

  const value = Number(configured);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Mensagem do teto — a mesma na rota e no serviço, para o erro bater certo. */
function limitMessage() {
  const limite = maxBytes();
  if (!limite) return 'Ficheiro maior que o espaço em disco disponível';
  return `Ficheiro maior que ${Math.round(limite / 1024 / 1024)} MB`;
}

// Nome de recurso quando o ficheiro vem sem nome utilizável.
const FALLBACK_NAME = 'ficheiro';

class ProfileFilesService {
  /** Pasta de Downloads (caminho absoluto) do navegador. */
  downloadsDirFor(browser) {
    const target = DOWNLOAD_DIRS[browser] || DOWNLOAD_DIRS.chromium;
    return `${target.root}/${target.dir}`;
  }

  /**
   * Nome seguro para o ficheiro: fica só o nome (sem caminhos), sem caracteres
   * que o shell ou o site estranhem, e a extensão é preservada mesmo quando o
   * nome tem de ser cortado.
   */
  sanitizeName(name) {
    const base = String(name || '').split(/[\\/]/).pop() || '';
    const clean = base
      .replace(/[^\p{L}\p{N} ._-]/gu, '_')
      .replace(/\s+/g, ' ')
      .replace(/^\.+/, '')
      .trim();

    if (!clean) return FALLBACK_NAME;
    if (clean.length <= 80) return clean;

    const dot = clean.lastIndexOf('.');
    if (dot < 1) return clean.slice(0, 80);
    const ext = clean.slice(dot).slice(0, 10);
    return clean.slice(0, 80 - ext.length) + ext;
  }

  /**
   * Conteúdo em base64 → Buffer, com o teto.
   *
   * É o contrato antigo (corpo JSON com `{name, data}`), mantido para scripts e
   * pedidos à mão. O dashboard usa o caminho de streaming, que não passa por
   * base64 nenhum: o ficheiro vai cru no corpo e direto para o disco.
   *
   * @returns {{buffer: Buffer|null, error: string|null}}
   */
  decode(data) {
    const text = String(data || '');
    if (!text.trim()) return { buffer: null, error: 'Ficheiro vazio' };

    let buffer;
    try {
      buffer = Buffer.from(text, 'base64');
    } catch (err) {
      return { buffer: null, error: 'Conteúdo inválido' };
    }
    if (!buffer.length) return { buffer: null, error: 'Conteúdo inválido' };

    const error = this.checkSize(buffer.length);
    if (error) return { buffer: null, error };
    return { buffer, error: null };
  }

  /** O ficheiro cabe no teto? (0 = sem teto: quem manda é o disco.) */
  checkSize(bytes) {
    const limite = maxBytes();
    if (limite && bytes > limite) return limitMessage();
    return null;
  }

  /**
   * Onde gravar o ficheiro dentro do container.
   *
   * @returns {{root: string, relativePath: string, path: string, uid: number, gid: number}}
   */
  targetFor(browser, name) {
    const target = DOWNLOAD_DIRS[browser] || DOWNLOAD_DIRS.chromium;
    const file = this.sanitizeName(name);
    const owner = bookmarks.ownerFor(browser);

    return {
      root: target.root,
      relativePath: `${target.dir}/${file}`,
      path: `${target.root}/${target.dir}/${file}`,
      uid: owner.uid,
      gid: owner.gid
    };
  }
}

module.exports = new ProfileFilesService();
module.exports.DEFAULT_MAX_BYTES = DEFAULT_MAX_BYTES;
module.exports.maxBytes = maxBytes;
module.exports.limitMessage = limitMessage;
module.exports.DOWNLOAD_DIRS = DOWNLOAD_DIRS;
