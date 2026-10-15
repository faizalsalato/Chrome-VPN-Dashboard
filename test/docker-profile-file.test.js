/**
 * Escrita de ficheiro no container (o caminho do ⬆ Enviar).
 *
 * Já falhou na prática: passar um stream como fonte do `pack.entry` NÃO escreve
 * o conteúdo — a entrada saía com 0 bytes e o envio de 24 MB nunca terminava
 * (ficou pendurado até o nginx responder 504). Este teste lê o tar que vai para
 * o docker e confere os bytes: é o que um `putArchive` falso permite ver, e é o
 * que teria apanhado o bug.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const tar = require('tar-stream');
const dockerService = require('../src/services/docker.service');

/** Cliente falso: guarda tudo o que o serviço mandaria para o docker. */
function fakeClient(coletor) {
  return {
    getContainer: () => ({
      putArchive: async (stream) => {
        await new Promise((resolve, reject) => {
          stream.on('data', (chunk) => coletor.push(chunk));
          stream.on('error', reject);
          stream.on('end', resolve);
        });
      }
    })
  };
}

/** Lê um tar em memória: nome da entrada → conteúdo. */
async function lerTar(buffer) {
  const extract = tar.extract();
  const lidas = {};

  extract.on('entry', (header, entry, next) => {
    const partes = [];
    entry.on('data', (chunk) => partes.push(chunk));
    entry.on('end', () => {
      lidas[header.name] = Buffer.concat(partes);
      next();
    });
  });

  const fim = new Promise((resolve, reject) => {
    extract.on('finish', resolve);
    extract.on('error', reject);
  });

  extract.end(buffer);
  await fim;
  return lidas;
}

describe('writeContainerFile — ficheiro grande vindo do disco', () => {
  const temporarios = [];

  afterEach(() => {
    while (temporarios.length) {
      fs.rmSync(temporarios.pop(), { force: true });
    }
  });

  function arquivo(bytes) {
    const nome = `teste-upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const file = path.join(os.tmpdir(), nome);
    fs.writeFileSync(file, bytes);
    temporarios.push(file);
    return file;
  }

  it('os bytes do disco saem TODOS no tar (e não uma entrada de 0 bytes)', async () => {
    const conteudo = Buffer.alloc(1024 * 1024 + 7, 5);
    const file = arquivo(conteudo);
    const pedacos = [];

    await dockerService.writeContainerFile(1, {
      root: '/profile',
      relativePath: 'Downloads/grande.bin',
      filePath: file,
      bytes: conteudo.length,
      uid: 0,
      gid: 0
    }, fakeClient(pedacos));

    const lidas = await lerTar(Buffer.concat(pedacos));

    expect(Object.keys(lidas)).toContain('Downloads/grande.bin');
    expect(lidas['Downloads/grande.bin'].length).toBe(conteudo.length);
    expect(lidas['Downloads/grande.bin'].equals(conteudo)).toBe(true);
  });

  it('a pasta de destino vai no tar como diretório (o dono nasce certo)', async () => {
    const file = arquivo(Buffer.from('x'));
    const pedacos = [];

    await dockerService.writeContainerFile(7, {
      root: '/config',
      relativePath: 'Downloads/x.txt',
      filePath: file,
      bytes: 1,
      uid: 1000,
      gid: 1000
    }, fakeClient(pedacos));

    const lidas = await lerTar(Buffer.concat(pedacos));

    expect(Object.keys(lidas)).toContain('Downloads');
    expect(lidas['Downloads/x.txt'].toString('utf-8')).toBe('x');
  });

  it('o buffer em memória continua a funcionar (política, marcadores)', async () => {
    const pedacos = [];

    await dockerService.writeContainerFile(3, {
      root: '/config',
      relativePath: 'fp-extension/content.js',
      content: 'console.log("oi");',
      uid: 0,
      gid: 0
    }, fakeClient(pedacos));

    const lidas = await lerTar(Buffer.concat(pedacos));

    expect(lidas['fp-extension/content.js'].toString('utf-8')).toBe('console.log("oi");');
  });
});
