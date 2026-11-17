/**
 * Imagem derivada do Chromium (chromium-image.service).
 *
 * A imagem oficial da LinuxServer embute o `--test-type` no wrapper
 * /usr/bin/wrapped-chromium, e o dashboard não tem como desligá-lo pelo
 * CHROME_CLI (que só acrescenta). A derivada remove SÓ essa linha — daí estes
 * testes travarem duas coisas: que a receita existe, e que ela mexe apenas no
 * --test-type, deixando o resto do wrapper intacto.
 *
 * O CloakBrowser não usa esta imagem: lá o --test-type é opt-in
 * (CLOAKBROWSER_TEST_TYPE), e isso é coberto em cloakbrowser.test.js.
 */
const fs = require('fs');
const path = require('path');

const chromiumImage = require('../src/services/chromium-image.service');

const SOURCE_DIR = path.join(__dirname, '..', 'deploy', 'chromium-image');

function dockerfile() {
  return fs.readFileSync(path.join(SOURCE_DIR, 'Dockerfile'), 'utf-8').replace(/\r\n/g, '\n');
}

describe('receita da imagem derivada do Chromium', () => {
  it('o contexto de build é só o Dockerfile', () => {
    expect(chromiumImage.BUILD_CONTEXT).toEqual(['Dockerfile']);
    expect(fs.existsSync(path.join(SOURCE_DIR, 'Dockerfile'))).toBe(true);
  });

  it('o Dockerfile deriva da imagem oficial da LinuxServer', () => {
    const texto = dockerfile();

    expect(texto).toContain('ARG CHROMIUM_BASE_IMAGE=lscr.io/linuxserver/chromium:latest');
    expect(texto).toContain('FROM ${CHROMIUM_BASE_IMAGE}');
  });

  it('remove a linha do --test-type do wrapper', () => {
    const texto = dockerfile();

    expect(texto).toContain("sed -i '/--test-type/d' /usr/bin/wrapped-chromium");
    // Guarda de build: falha se a flag sobreviver ou se o wrapper for truncado.
    expect(texto).toContain("! grep -q -- '--test-type' /usr/bin/wrapped-chromium");
    expect(texto).toContain("grep -q -- '--no-sandbox' /usr/bin/wrapped-chromium");
  });

  it('não mexe em nenhuma outra flag da imagem', () => {
    // O pedido foi tirar o modo de teste, não reescrever o wrapper: as outras
    // flags da LinuxServer continuam como estão.
    const texto = dockerfile();

    for (const flag of ['--password-store', '--simulate-outdated-no-au', '--start-maximized', '--user-data-dir']) {
      expect(texto).not.toContain(`sed -i '/${flag}`);
    }
  });

  it('a imagem derivada não é publicada em registry (nome local)', () => {
    expect(chromiumImage.DEFAULT_IMAGE).toBe('chrome-vpn-dashboard-chromium:latest');
    expect(chromiumImage.DEFAULT_BASE_IMAGE).toBe('lscr.io/linuxserver/chromium:latest');
    // A tag acompanha a da base, para duas versões coexistirem.
    expect(chromiumImage.imageFor('lscr.io/linuxserver/chromium:latest'))
      .toBe('chrome-vpn-dashboard-chromium:latest');
    expect(chromiumImage.imageFor('lscr.io/linuxserver/chromium:1.2.3'))
      .toBe('chrome-vpn-dashboard-chromium:1.2.3');
  });

  it('a receita é estável e serve de impressão digital', () => {
    // A impressão é o que faz uma mudança no Dockerfile chegar aos hosts que já
    // têm a imagem antiga — sem ela, a instância continuaria com o --test-type.
    const antes = chromiumImage.recipe();
    expect(antes).toMatch(/^[0-9a-f]{16}$/);
    expect(chromiumImage.recipe()).toBe(antes);
  });
});