/**
 * BookmarksService — marcadores semeados no perfil de cada navegador.
 *
 * Por que existe: um perfil novo deve abrir com os mesmos atalhos de trabalho
 * (verificação de IP, webmail, rubilax e as redes sociais), nos três
 * navegadores. O arquivo `Bookmarks` é o formato do Chromium — o Brave e o
 * CloakBrowser usam exatamente o mesmo.
 *
 * Regras que evitam estragar o perfil do usuário:
 *  - nunca apaga nem reordena marcadores que já existem (os nossos entram no
 *    fim, e só se faltarem pelo URL);
 *  - é idempotente: correr de novo não duplica nada;
 *  - um arquivo ilegível não é tocado: devolve `null` em vez de adivinhar.
 */
const cloakbrowser = require('./cloakbrowser.service');

// Atalhos que ficam direto na barra de marcadores.
const BAR_ENTRIES = [
  { name: 'Webmail', url: 'https://mail.rota.ath.cx/' },
  { name: 'Rubilax', url: 'https://rubilax.com/' }
];

// Pastas da barra de marcadores.
const FOLDERS = [
  {
    name: 'Verificação',
    items: [
      { name: 'IPinfo — qual é o meu IP', url: 'https://ipinfo.io/what-is-my-ip' },
      { name: 'Whoer — fingerprint', url: 'https://whoer.net/' }
    ]
  },
  {
    name: 'Redes sociais',
    items: [
      { name: 'Facebook', url: 'https://www.facebook.com/' },
      { name: 'Instagram', url: 'https://www.instagram.com/' },
      { name: 'X (Twitter)', url: 'https://x.com/' },
      { name: 'YouTube', url: 'https://www.youtube.com/' },
      { name: 'TikTok', url: 'https://www.tiktok.com/' },
      { name: 'WhatsApp Web', url: 'https://web.whatsapp.com/' },
      { name: 'Telegram Web', url: 'https://web.telegram.org/' },
      { name: 'LinkedIn', url: 'https://www.linkedin.com/' },
      { name: 'Reddit', url: 'https://www.reddit.com/' },
      { name: 'Pinterest', url: 'https://www.pinterest.com/' }
    ]
  }
];

/**
 * Perfil de cada navegador DENTRO do container.
 *
 * `root` é a pasta que existe sempre (o `putArchive` extrai a partir dela e
 * cria as subpastas que faltam); `dir` é o caminho relativo da pasta do perfil.
 * O Chromium/Brave da LinuxServer não recebe `--user-data-dir`: usam o padrão do
 * `HOME` (`/config`). O CloakBrowser recebe `--user-data-dir=/profile`.
 *
 * `uid`/`gid`: o CloakBrowser corre como root; nas imagens da LinuxServer o
 * usuário `abc` é remapeado para `PUID`/`PGID` (1000:1000) — um arquivo de root
 * ficaria só de leitura para o navegador.
 */
const PROFILES = {
  chromium: { root: '/config', dir: '.config/chromium/Default', uid: 1000, gid: 1000 },
  brave: { root: '/config', dir: '.config/BraveSoftware/Brave-Browser/Default', uid: 1000, gid: 1000 },
  cloakbrowser: { root: cloakbrowser.PROFILE_DIR, dir: 'Default', uid: 0, gid: 0 }
};

class BookmarksService {
  /** Dados do perfil (raiz, pasta relativa e dono) do navegador. */
  profileFor(browser) {
    return PROFILES[browser] || PROFILES.chromium;
  }

  /** Raiz de onde o `putArchive` extrai (pasta que existe sempre). */
  rootFor(browser) {
    return this.profileFor(browser).root;
  }

  /** Caminho relativo do arquivo dentro da raiz. */
  relativeFileFor(browser) {
    return `${this.profileFor(browser).dir}/Bookmarks`;
  }

  /** Caminho absoluto do arquivo de marcadores dentro do container. */
  fileFor(browser) {
    return `${this.rootFor(browser)}/${this.relativeFileFor(browser)}`;
  }

  /** uid/gid com que o arquivo tem de ficar no container. */
  ownerFor(browser) {
    const profile = this.profileFor(browser);
    return { uid: profile.uid, gid: profile.gid };
  }

  /**
   * Marcadores com os nossos atalhos garantidos.
   *
   * @param {string|object|null} existing conteúdo atual do arquivo (texto cru ou
   *   já convertido); null quando o perfil ainda não tem marcadores
   * @returns {{bookmarks: object|null, added: number, skipped: boolean}}
   *   `bookmarks` é o JSON a gravar; `null` com `skipped` quando o arquivo
   *   existente não é JSON válido — nesse caso não se toca nele.
   */
  build(existing) {
    let root = null;
    if (existing && typeof existing === 'object') {
      root = existing;
    } else if (typeof existing === 'string' && existing.trim()) {
      try {
        root = JSON.parse(existing);
      } catch (err) {
        return { bookmarks: null, added: 0, skipped: true };
      }
    }
    if (!root || typeof root !== 'object') root = this._emptyRoot();

    const bar = this._bookmarkBar(root);
    const state = { nextId: this._nextId(root), added: 0 };

    for (const item of BAR_ENTRIES) {
      if (this._contains(bar, item.url)) continue;
      bar.children.push(this._url(state, item.name, item.url));
    }
    for (const folder of FOLDERS) {
      const target = this._folderFor(bar, folder.name, state);
      for (const item of folder.items) {
        if (this._contains(bar, item.url)) continue;
        target.children.push(this._url(state, item.name, item.url));
      }
    }

    if (typeof root.checksum !== 'string') root.checksum = '';
    return { bookmarks: root, added: state.added, skipped: false };
  }

  /** Esqueleto de um arquivo novo (barra, "outros" e "celular"). */
  _emptyRoot() {
    const bar = this._emptyBar();
    const stub = (id, name, guidSeed) => ({
      children: [],
      date_added: bar.date_added,
      date_last_used: '0',
      date_modified: bar.date_modified,
      guid: this._guid(guidSeed),
      id,
      name,
      type: 'folder'
    });

    return {
      checksum: '',
      roots: {
        bookmark_bar: bar,
        other: stub('2', 'Other bookmarks', 'other'),
        synced: stub('3', 'Mobile bookmarks', 'synced')
      },
      version: 1
    };
  }

  _emptyBar() {
    const now = this._chromeTime();
    return {
      children: [],
      date_added: now,
      date_last_used: '0',
      date_modified: now,
      guid: this._guid('bookmark_bar'),
      id: '1',
      name: 'Bookmarks bar',
      type: 'folder'
    };
  }

  /** Nó da barra (cria o esqueleto quando o arquivo vem sem ele). */
  _bookmarkBar(root) {
    if (!root.roots || typeof root.roots !== 'object') root.roots = {};
    const bar = root.roots.bookmark_bar;
    if (!bar || typeof bar !== 'object') {
      root.roots.bookmark_bar = this._emptyBar();
    } else if (!Array.isArray(root.roots.bookmark_bar.children)) {
      root.roots.bookmark_bar.children = [];
    }
    return root.roots.bookmark_bar;
  }

  /** Já existe um marcador com este URL (em qualquer nível da barra)? */
  _contains(node, url) {
    for (const child of (node && node.children) || []) {
      if (!child) continue;
      if (child.type === 'url' && child.url === url) return true;
      if (child.type === 'folder' && this._contains(child, url)) return true;
    }
    return false;
  }

  /** Pasta pelo nome; cria no fim da barra quando ainda não existe. */
  _folderFor(bar, name, state) {
    for (const child of bar.children) {
      if (child && child.type === 'folder' && child.name === name) {
        if (!Array.isArray(child.children)) child.children = [];
        return child;
      }
    }
    const folder = this._folder(state, name);
    bar.children.push(folder);
    return folder;
  }

  /** Item de URL no formato do Chromium. */
  _url(state, name, url) {
    state.added++;
    const now = this._chromeTime();
    return {
      date_added: now,
      date_last_used: '0',
      guid: this._guid(url),
      id: String(state.nextId++),
      name,
      type: 'url',
      url
    };
  }

  /** Pasta no formato do Chromium. */
  _folder(state, name) {
    const now = this._chromeTime();
    return {
      children: [],
      date_added: now,
      date_last_used: '0',
      date_modified: now,
      guid: this._guid(`folder:${name}`),
      id: String(state.nextId++),
      name,
      type: 'folder'
    };
  }

  /**
   * Próximo id livre. Os ids são números (em texto) e têm de ser únicos no
   * arquivo TODO — as pastas fixas (barra = 1, "outros" = 2, "celular" = 3)
   * também contam: reaproveitar um id confundiria o Chromium.
   */
  _nextId(root) {
    let max = 0;
    const visit = (node) => {
      const id = parseInt(node && node.id, 10);
      if (Number.isFinite(id) && id > max) max = id;
      for (const child of (node && node.children) || []) visit(child);
    };

    const roots = root && root.roots;
    if (roots && typeof roots === 'object') {
      for (const value of Object.values(roots)) visit(value);
    } else {
      visit(root);
    }
    return max + 1;
  }

  /** Microssegundos desde 1601-01-01, o relógio que o Chromium usa em datas. */
  _chromeTime() {
    return String((BigInt(Date.now()) + 11644473600000n) * 1000n);
  }

  /** GUID determinístico (mesmo URL → mesmo GUID) no formato do Chromium. */
  _guid(seed) {
    const text = String(seed);
    let h1 = 0x9e3779b9;
    let h2 = 0x85ebca6b;
    for (let i = 0; i < text.length; i++) {
      h1 = Math.imul(h1 ^ text.charCodeAt(i), 0x01000193) >>> 0;
      h2 = Math.imul(h2 + text.charCodeAt(i), 0x27d4eb2d) >>> 0;
    }
    const part = (value) => value.toString(16).padStart(8, '0');
    return [
      part(h1),
      part(h2).slice(0, 4),
      `4${part(h2).slice(0, 3)}`,
      `8${part(h1).slice(0, 3)}`,
      `${part(h1)}${part(h2).slice(0, 4)}`
    ].join('-');
  }
}

module.exports = new BookmarksService();
module.exports.BAR_ENTRIES = BAR_ENTRIES;
module.exports.FOLDERS = FOLDERS;
module.exports.PROFILES = PROFILES;
