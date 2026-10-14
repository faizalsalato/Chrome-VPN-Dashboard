/**
 * Marcadores semeados no perfil de cada navegador.
 *
 * O que estes testes protegem:
 *  - os atalhos pedidos estão lá (verificação de IP, webmail, rubilax e redes
 *    sociais), nos três navegadores;
 *  - marcadores do usuário nunca são apagados nem duplicados;
 *  - um arquivo ilegível não é tocado (não se adivinha o que estava lá).
 */
const tar = require('tar-stream');
const bookmarks = require('../src/services/bookmarks.service');

// URLs que têm de estar na barra (ou numa pasta dela).
const REQUIRED = [
  'https://ipinfo.io/what-is-my-ip',
  'https://whoer.net/',
  'https://mail.rota.ath.cx/',
  'https://rubilax.com/',
  'https://www.facebook.com/',
  'https://www.instagram.com/',
  'https://x.com/',
  'https://www.youtube.com/',
  'https://www.tiktok.com/',
  'https://web.whatsapp.com/',
  'https://web.telegram.org/',
  'https://www.linkedin.com/',
  'https://www.reddit.com/',
  'https://www.pinterest.com/'
];

/** Todos os URLs (itens) da barra, em qualquer pasta. */
function urlsOf(node, found = []) {
  for (const child of (node && node.children) || []) {
    if (child.type === 'url') found.push(child.url);
    if (child.type === 'folder') urlsOf(child, found);
  }
  return found;
}

function folderNamed(bar, name) {
  return (bar.children || []).find((child) => child.type === 'folder' && child.name === name);
}

describe('bookmarks.service — lista de atalhos', () => {
  it('cria o arquivo do zero com os atalhos e as pastas', () => {
    const { bookmarks: root, added, skipped } = bookmarks.build(null);

    expect(skipped).toBe(false);
    expect(added).toBe(REQUIRED.length);
    expect(root.version).toBe(1);

    const bar = root.roots.bookmark_bar;
    const urls = urlsOf(bar);
    for (const url of REQUIRED) expect(urls).toContain(url);

    // Webmail e Rubilax ficam direto na barra; o resto em pastas.
    expect(bar.children.filter((c) => c.type === 'url').map((c) => c.url))
      .toEqual(['https://mail.rota.ath.cx/', 'https://rubilax.com/']);
    expect(folderNamed(bar, 'Verificação')).toBeTruthy();
    expect(urlsOf(folderNamed(bar, 'Redes sociais')).length).toBe(10);
  });

  it('os ids são únicos no arquivo todo e as datas no formato do Chromium', () => {
    const { bookmarks: root } = bookmarks.build(null);
    const ids = [];
    const walk = (node) => {
      if (node && node.id) ids.push(node.id);
      for (const child of (node && node.children) || []) walk(child);
    };
    // As pastas fixas contam: barra (1), "outros" (2) e "celular" (3).
    walk(root.roots.bookmark_bar);
    walk(root.roots.other);
    walk(root.roots.synced);

    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^\d+$/);
    expect(ids).toContain('1');
    expect(ids).toContain('3');

    // Os marcadores começam depois das pastas fixas.
    expect(Number(root.roots.bookmark_bar.children[0].id)).toBeGreaterThan(3);

    const item = root.roots.bookmark_bar.children[0];
    expect(item.date_added).toMatch(/^\d{17}$/);
    expect(item.guid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

/** Perfil que já tem marcadores do usuário (barra + pasta própria). */
function userProfile() {
  return {
    checksum: '',
    roots: {
      bookmark_bar: {
        children: [
          {
            date_added: '13300000000000000', guid: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
            id: '7', name: 'Meu banco', type: 'url', url: 'https://meu-banco.example/'
          },
          {
            children: [{
              date_added: '13300000000000000', guid: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',
              id: '9', name: 'Notícias', type: 'url', url: 'https://news.example/'
            }],
            date_added: '13300000000000000', date_last_used: '0', date_modified: '13300000000000000',
            guid: 'cccccccc-1111-4111-8111-cccccccccccc', id: '8', name: 'Trabalho', type: 'folder'
          }
        ],
        date_added: '13300000000000000', date_last_used: '0', date_modified: '13300000000000000',
        guid: 'dddddddd-1111-4111-8111-dddddddddddd', id: '1', name: 'Bookmarks bar', type: 'folder'
      }
    },
    version: 1
  };
}

describe('bookmarks.service — merge com o que o usuário já tem', () => {
  it('não apaga nem duplica marcadores do usuário', () => {
    const { bookmarks: root, added } = bookmarks.build(userProfile());

    expect(added).toBe(REQUIRED.length);

    const bar = root.roots.bookmark_bar;
    const urls = urlsOf(bar);
    expect(urls).toContain('https://meu-banco.example/');
    expect(urls).toContain('https://news.example/');
    expect(folderNamed(bar, 'Trabalho').children[0].name).toBe('Notícias');
    expect(urls.length).toBe(new Set(urls).size);

    // Os ids novos não colidem com os que o usuário já tinha (7, 8 e 9).
    const ids = [];
    const walk = (node) => {
      for (const child of (node && node.children) || []) {
        ids.push(child.id);
        if (child.type === 'folder') walk(child);
      }
    };
    walk(bar);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => ['7', '8', '9'].includes(id)).length).toBe(3);
  });

  it('é idempotente: correr outra vez não acrescenta nada', () => {
    const first = bookmarks.build(null).bookmarks;
    const second = bookmarks.build(JSON.parse(JSON.stringify(first)));

    expect(second.added).toBe(0);
    expect(urlsOf(second.bookmarks.roots.bookmark_bar).length).toBe(REQUIRED.length);
  });

  it('reaproveita a pasta com o mesmo nome em vez de criar outra', () => {
    const existing = bookmarks.build(null).bookmarks;
    const bar = existing.roots.bookmark_bar;

    // O usuário mexeu na pasta: continua lá, mas com um item dele e sem os
    // nossos. O merge tem de a reaproveitar (não criar uma segunda).
    const folder = bar.children.find((c) => c.name === 'Redes sociais');
    folder.children = [{
      date_added: '1', guid: 'ffffffff-1111-4111-8111-ffffffffffff', id: '99',
      name: 'Meu perfil', type: 'url', url: 'https://meu-perfil.example/'
    }];

    const result = bookmarks.build(existing);
    const folders = result.bookmarks.roots.bookmark_bar.children.filter((c) => c.name === 'Redes sociais');

    expect(folders.length).toBe(1);
    expect(result.added).toBe(10);
    expect(folders[0].children.map((c) => c.name)).toContain('Meu perfil');
    expect(folders[0].children.map((c) => c.name)).toContain('Facebook');
  });

  it('arquivo ilegível não é tocado', () => {
    const result = bookmarks.build('isto não é json');

    expect(result.skipped).toBe(true);
    expect(result.bookmarks).toBeNull();
    expect(result.added).toBe(0);
  });

  it('arquivo vazio conta como perfil novo', () => {
    expect(bookmarks.build('').added).toBe(REQUIRED.length);
    expect(bookmarks.build('   ').added).toBe(REQUIRED.length);
  });
});

describe('bookmarks.service — onde fica o arquivo', () => {
  it('cada navegador tem a sua pasta de perfil, com o dono certo', () => {
    expect(bookmarks.fileFor('cloakbrowser')).toBe('/profile/Default/Bookmarks');
    expect(bookmarks.fileFor('chromium')).toBe('/config/.config/chromium/Default/Bookmarks');
    expect(bookmarks.fileFor('brave')).toBe('/config/.config/BraveSoftware/Brave-Browser/Default/Bookmarks');

    // A raiz do putArchive tem de ser uma pasta que existe sempre.
    expect(bookmarks.rootFor('cloakbrowser')).toBe('/profile');
    expect(bookmarks.rootFor('brave')).toBe('/config');

    // O navegador da LinuxServer corre como PUID/PGID (1000) e precisa de
    // escrever no arquivo; o CloakBrowser corre como root.
    expect(bookmarks.ownerFor('chromium')).toEqual({ uid: 1000, gid: 1000 });
    expect(bookmarks.ownerFor('cloakbrowser')).toEqual({ uid: 0, gid: 0 });
  });

  it('navegador desconhecido cai no Chromium', () => {
    expect(bookmarks.fileFor('netscape')).toBe(bookmarks.fileFor('chromium'));
  });
});

/**
 * Duplo do dockerode: na leitura devolve um tar (ou 404, quando o perfil ainda
 * não tem o arquivo) e na escrita guarda o tar recebido, já desmontado.
 */
function fakeDocker({ current = null } = {}) {
  const written = [];
  const client = {
    getContainer: () => ({
      getArchive: async () => {
        if (current === null) {
          const err = new Error('no such file or directory');
          err.statusCode = 404;
          throw err;
        }
        const pack = tar.pack();
        const body = Buffer.from(current, 'utf-8');
        pack.entry({ name: 'Bookmarks', size: body.length }, body);
        pack.finalize();
        return pack;
      },
      putArchive: async (stream, options) => {
        const entries = [];
        await new Promise((resolve, reject) => {
          const extract = tar.extract();
          extract.on('entry', (header, entry, next) => {
            const parts = [];
            entry.on('data', (chunk) => parts.push(chunk));
            entry.on('end', () => {
              entries.push({ header, body: Buffer.concat(parts).toString('utf-8') });
              next();
            });
          });
          extract.on('error', reject);
          extract.on('finish', resolve);
          stream.pipe(extract);
        });
        written.push({ options, entries });
      }
    })
  };
  return { client, written };
}

describe('docker.service — semear os marcadores no container', () => {
  const dockerService = require('../src/services/docker.service');

  it('cria o perfil do CloakBrowser com o ficheiro e o dono do navegador', async () => {
    const { client, written } = fakeDocker();

    const result = await dockerService.seedBookmarks(1, 'cloakbrowser', client);

    expect(result.path).toBe('/profile/Default/Bookmarks');
    expect(result.added).toBe(REQUIRED.length);
    expect(written.length).toBe(1);
    expect(written[0].options.path).toBe('/profile');

    // A pasta do perfil vem antes do ficheiro (é o que a faz nascer).
    expect(written[0].entries.map((e) => e.header.name)).toEqual(['Default', 'Default/Bookmarks']);

    const file = written[0].entries[1];
    expect(file.header.uid).toBe(0);
    expect(file.header.gid).toBe(0);
    expect(JSON.parse(file.body).roots.bookmark_bar).toBeTruthy();
  });

  it('no Brave escreve como PUID/PGID e cria as pastas em falta', async () => {
    const { client, written } = fakeDocker();

    await dockerService.seedBookmarks(2, 'brave', client);

    expect(written[0].options.path).toBe('/config');
    expect(written[0].entries.map((e) => e.header.name)).toEqual([
      '.config',
      '.config/BraveSoftware',
      '.config/BraveSoftware/Brave-Browser',
      '.config/BraveSoftware/Brave-Browser/Default',
      '.config/BraveSoftware/Brave-Browser/Default/Bookmarks'
    ]);
    for (const entry of written[0].entries) {
      expect(entry.header.uid).toBe(1000);
      expect(entry.header.gid).toBe(1000);
    }
  });

  it('com o arquivo já completo não reescreve nada', async () => {
    const complete = JSON.stringify(bookmarks.build(null).bookmarks);
    const { client, written } = fakeDocker({ current: complete });

    const result = await dockerService.seedBookmarks(1, 'cloakbrowser', client);

    expect(result.added).toBe(0);
    expect(written.length).toBe(0);
  });

  it('acrescenta o que falta a um perfil que já tem marcadores', async () => {
    const { client, written } = fakeDocker({ current: JSON.stringify(userProfile()) });

    const result = await dockerService.seedBookmarks(1, 'cloakbrowser', client);

    expect(result.added).toBe(REQUIRED.length);
    expect(written.length).toBe(1);

    const saved = JSON.parse(written[0].entries[written[0].entries.length - 1].body);
    const urls = urlsOf(saved.roots.bookmark_bar);
    expect(urls).toContain('https://meu-banco.example/');
    expect(urls).toContain('https://rubilax.com/');
  });

  it('arquivo ilegível fica como está', async () => {
    const { client, written } = fakeDocker({ current: 'isto não é json' });

    const result = await dockerService.seedBookmarks(1, 'cloakbrowser', client);

    expect(result.skipped).toBe(true);
    expect(written.length).toBe(0);
  });
});
