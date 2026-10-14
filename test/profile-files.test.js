/**
 * Ficheiros que o usuário manda para o perfil do navegador.
 *
 * É o que permite publicar nas redes: o seletor de ficheiros do site abre o
 * sistema de ficheiros do CONTAINER, então o ficheiro tem de estar lá dentro
 * (pasta Downloads do perfil). O nome é saneado e há um teto de tamanho.
 */
const profileFiles = require('../src/services/profile-files.service');

describe('profile-files.service — destino no perfil', () => {
  it('grava na pasta Downloads do perfil de cada navegador', () => {
    expect(profileFiles.targetFor('cloakbrowser', 'foto.png')).toEqual({
      root: '/profile',
      relativePath: 'Downloads/foto.png',
      path: '/profile/Downloads/foto.png',
      uid: 0,
      gid: 0
    });

    // Nas imagens da LinuxServer o navegador corre como PUID/PGID: o ficheiro
    // tem de nascer com esse dono, senão fica só de leitura para ele.
    const chromium = profileFiles.targetFor('chromium', 'video.mp4');
    expect(chromium.root).toBe('/config');
    expect(chromium.path).toBe('/config/Downloads/video.mp4');
    expect(chromium.uid).toBe(1000);
    expect(chromium.gid).toBe(1000);

    expect(profileFiles.targetFor('brave', 'x.jpg').path).toBe('/config/Downloads/x.jpg');
  });

  it('navegador desconhecido cai no Chromium', () => {
    expect(profileFiles.targetFor('netscape', 'a.png').path)
      .toBe(profileFiles.targetFor('chromium', 'a.png').path);
  });
});

describe('profile-files.service — nome do ficheiro', () => {
  it('tira caminhos e caracteres perigosos, mantendo a extensão', () => {
    expect(profileFiles.sanitizeName('../../etc/passwd')).toBe('passwd');
    expect(profileFiles.sanitizeName('C:\\Users\\eu\\foto da praia.jpg')).toBe('foto da praia.jpg');
    // Aspas, ponto e vírgula e asterisco viram underscore.
    expect(profileFiles.sanitizeName('foto";rm -rf *.png')).toBe('foto__rm -rf _.png');
    expect(profileFiles.sanitizeName('  nome   com   espacos.png ')).toBe('nome com espacos.png');
  });

  it('corta nomes compridos sem perder a extensão', () => {
    const nome = `${'a'.repeat(120)}.jpeg`;
    const cortado = profileFiles.sanitizeName(nome);

    expect(cortado.length).toBeLessThanOrEqual(80);
    expect(cortado.endsWith('.jpeg')).toBe(true);
  });

  it('nome vazio ou só pontos cai num nome genérico', () => {
    expect(profileFiles.sanitizeName('')).toBe('ficheiro');
    expect(profileFiles.sanitizeName('...')).toBe('ficheiro');
    expect(profileFiles.sanitizeName(null)).toBe('ficheiro');
  });
});

describe('profile-files.service — conteúdo', () => {
  it('aceita base64 e devolve os bytes certos', () => {
    const { buffer, error } = profileFiles.decode(Buffer.from('ola mundo').toString('base64'));

    expect(error).toBeNull();
    expect(buffer.toString('utf-8')).toBe('ola mundo');
  });

  it('recusa vazio, lixo e ficheiro acima do teto', () => {
    expect(profileFiles.decode('').error).toMatch(/vazio/i);
    expect(profileFiles.decode(null).error).toMatch(/vazio/i);

    const grande = Buffer.alloc(profileFiles.MAX_BYTES + 1).toString('base64');
    expect(profileFiles.decode(grande).error).toMatch(/maior que/i);
  });
});
