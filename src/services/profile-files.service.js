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

// Teto por ficheiro. Igual ao limite do corpo aceite na API (express.json), para
// a mensagem de erro ser a mesma dos dois lados.
const MAX_BYTES = 24 * 1024 * 1024;

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
   * Conteúdo em base64 → Buffer, com o teto de tamanho.
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
    if (buffer.length > MAX_BYTES) {
      return { buffer: null, error: `Ficheiro maior que ${Math.round(MAX_BYTES / 1024 / 1024)} MB` };
    }
    return { buffer, error: null };
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
module.exports.MAX_BYTES = MAX_BYTES;
module.exports.DOWNLOAD_DIRS = DOWNLOAD_DIRS;
