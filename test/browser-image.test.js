/**
 * Imagem derivada do CloakBrowser (KasmVNC + áudio).
 *
 * O que estes testes protegem: a imagem é construída UMA vez por host, e o build
 * só enxerga o contexto de build — tudo o que precisa estar dentro da imagem
 * tem de estar lá. A impressão da receita (RECIPE_LABEL) é o que faz uma imagem
 * antiga ser reconstruída quando o Dockerfile muda.
 */
const fs = require('fs');
const path = require('path');
const browserImage = require('../src/services/browser-image.service');
const cloakbrowser = require('../src/services/cloakbrowser.service');

const DIR = path.join(__dirname, '..', 'deploy', 'browser-image');
const DOCKERFILE = path.join(DIR, 'Dockerfile');

describe('contexto de build da imagem do navegador', () => {
  it('leva o Dockerfile e o áudio (é só isso que o build enxerga)', () => {
    expect(browserImage.BUILD_CONTEXT).toContain('Dockerfile');

    for (const nome of ['pulse-virtual.pa', 'audio-bridge.py', 'audio-start.sh', 'kasm-audio.js']) {
      expect(browserImage.BUILD_CONTEXT).toContain(nome);
      expect(fs.existsSync(path.join(DIR, nome))).toBe(true);
    }
  });

  it('a receita é estável entre chamadas', () => {
    const primeira = browserImage.recipe();

    expect(primeira).toMatch(/^[0-9a-f]{16}$/);
    expect(browserImage.recipe()).toBe(primeira);
  });

  it('o Dockerfile instala o áudio e injeta o cliente no KasmVNC', () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, 'utf-8');

    expect(dockerfile).toContain('pulseaudio pulseaudio-utils');
    expect(dockerfile).toContain('command -v parec');
    // O áudio sobe ANTES do servidor de tela.
    expect(dockerfile).toContain('/usr/local/bin/audio-start.sh\\nXvnc :99');
    expect(dockerfile).toContain('kasm-audio.js');
    expect(dockerfile).toContain('PULSE_SERVER');
  });

  it('a porta do áudio no Dockerfile é a mesma que o dashboard usa', () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, 'utf-8');
    const achado = /ENV AUDIO_PORT=(\d+)/.exec(dockerfile);

    expect(achado).not.toBeNull();
    expect(Number(achado[1])).toBe(cloakbrowser.AUDIO_PORT_NUMBER);
  });

  it('põe a tela num ritmo de link com latência (FrameRate e qualidade dinâmica)', () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, 'utf-8');
    const linha = dockerfile.split(/\r?\n/).find((l) => l.includes('Xvnc :99')) || '';

    // O padrão do KasmVNC é de rede local: 60 quadros/s com qualidade 7–8. Num
    // link com ~200 ms de ida e volta isso enfileira e a tela "trava". O teto
    // desce e a faixa de qualidade fica ajustável pelo .env (KASM_*).
    expect(linha).toContain('-FrameRate="${KASM_FRAME_RATE:-25}"');
    expect(linha).toContain('-DynamicQualityMin="${KASM_QUALITY_MIN:-3}"');
    expect(linha).toContain('-DynamicQualityMax="${KASM_QUALITY_MAX:-6}"');
    expect(linha).toContain('-CompareFB=1');
    expect(linha).toContain('-WebpVideoQuality="${KASM_VIDEO_QUALITY:-5}"');
  });

  it('a ponte de áudio não ocupa a banda com silêncio', () => {
    const ponte = fs.readFileSync(path.join(DIR, 'audio-bridge.py'), 'utf-8');

    // O fluxo fica aberto enquanto o som está ligado; sem o descarte de blocos
    // só de zero, é banda constante disputando com a tela.
    expect(ponte).toContain("not chunk.strip(b'\\x00')");
  });
});
