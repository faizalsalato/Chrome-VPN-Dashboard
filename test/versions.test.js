/**
 * versions.service — o que está instalado e o que existe mais novo.
 *
 * O que estes testes protegem é a HONESTIDADE do dado, não o caminho feliz:
 *   - digest ausente não pode virar "em dia"
 *   - digest igual é "em dia", digest diferente é "atualização"
 *   - multi-arquitetura: compara o linux/amd64, não a lista inteira
 *   - registry fora do ar não derruba a página (vira erro, não exceção)
 */
const path = require('path');

// O serviço usa execFileSync('docker', ...) e https.request. Só essas duas
// funções são substituídas: o resto do módulo fica REAL de propósito, porque o
// ssh2 (que o dockerode carrega) faz "class extends https.Agent" — um mock
// vazio de https derruba o require com "Class extends value undefined".
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return { ...actual, execFileSync: jest.fn() };
});
jest.mock('https', () => {
  const actual = jest.requireActual('https');
  return { ...actual, request: jest.fn() };
});

const { execFileSync } = require('child_process');
const https = require('https');

const versions = require('../src/services/versions.service');

/** Resposta HTTP falsa que devolve um corpo JSON. */
function fakeHttp(body, statusCode = 200) {
  return (options, callback) => {
    const res = {
      statusCode,
      on: (event, handler) => {
        if (event === 'data') handler(JSON.stringify(body));
        if (event === 'end') handler();
        return res;
      }
    };
    setImmediate(() => callback(res));
    return {
      on: () => {},
      end: () => {},
      destroy: () => {}
    };
  };
}

/** Resposta HTTP que falha (sem rede). */
function deadHttp() {
  return (options, callback) => ({
    on: (event, handler) => {
      if (event === 'error') setImmediate(() => handler(new Error('sem rede')));
    },
    end: () => {},
    destroy: () => {}
  });
}

beforeEach(() => {
  versions._clearCache();
  execFileSync.mockReset();
  https.request.mockReset();
});

describe('localDigest', () => {
  it('extrai o sha256 de "repo@sha256:..."', () => {
    execFileSync.mockReturnValue('["lscr.io/linuxserver/chromium@sha256:abc123"]\n');
    expect(versions.localDigest('img')).toBe('sha256:abc123');
  });

  it('lista vazia devolve null', () => {
    execFileSync.mockReturnValue('[]');
    expect(versions.localDigest('img')).toBe(null);
  });

  it('comando falhou devolve null (não lança)', () => {
    execFileSync.mockImplementation(() => { throw new Error('docker fora'); });
    expect(versions.localDigest('img')).toBe(null);
  });

  it('JSON ilegível devolve null', () => {
    execFileSync.mockReturnValue('nao e json');
    expect(versions.localDigest('img')).toBe(null);
  });
});

describe('registryDigest', () => {
  // O digest que o host guarda em RepoDigests e o do INDICE multi-arquitetura.
  // Medido no servidor: RepoDigests=ff6c82ba (indice), manifest amd64=5f4b2b5d
  // (plataforma), Docker-Content-Digest=ff6c82ba (indice). Comparar indice com
  // plataforma daria 'atualizacao disponivel' para sempre.
  it('prefere o digest do INDICE ao da plataforma', () => {
    execFileSync.mockImplementation((cmd, args) => {
      if (args && args[0] === 'buildx') return JSON.stringify({ digest: 'sha256:indice' });
      return JSON.stringify({
        manifests: [
          { digest: 'sha256:arm', platform: { os: 'linux', architecture: 'arm64' } },
          { digest: 'sha256:amd', platform: { os: 'linux', architecture: 'amd64' } }
        ]
      });
    });
    const r = versions.registryDigest('img');
    expect(r.digest).toBe('sha256:indice');
    expect(r.platformDigest).toBe('sha256:amd');
    expect(r.error).toBe(null);
  });

  it('sem digest do indice: usa o da plataforma e avisa do falso positivo', () => {
    execFileSync.mockImplementation((cmd, args) => {
      if (args && args[0] === 'buildx') throw new Error('sem buildx');
      if (args && args.includes('--verbose')) throw new Error('sem verbose');
      return JSON.stringify({ manifests: [{ digest: 'sha256:amd', platform: { os: 'linux', architecture: 'amd64' } }] });
    });
    const r = versions.registryDigest('img');
    expect(r.digest).toBe('sha256:amd');
    expect(r.error).toMatch(/falso positivo/);
  });

  it('manifest unico: usa config.digest nos dois campos', () => {
    execFileSync.mockReturnValue(JSON.stringify({ config: { digest: 'sha256:single' } }));
    const r = versions.registryDigest('img');
    expect(r.digest).toBe('sha256:single');
    expect(r.platformDigest).toBe('sha256:single');
    expect(r.error).toBe(null);
  });

  it('registry fora do ar: digest null e motivo', () => {
    execFileSync.mockImplementation(() => { throw new Error('sem registry'); });
    const r = versions.registryDigest('img');
    expect(r.digest).toBe(null);
    expect(r.platformDigest).toBe(null);
    expect(r.error).toMatch(/registry/);
  });
});

describe('chromeState — a regra de honestidade', () => {
  it('digests iguais: em dia (updateAvailable false)', async () => {
    https.request.mockImplementation(fakeHttp({ versions: [{ version: '154.0.1.2' }] }));
    execFileSync.mockImplementation((cmd, args) => {
      if (args && args[0] === 'image') return '["repo@sha256:igual"]';
      return JSON.stringify({ manifests: [{ digest: 'sha256:igual', platform: { os: 'linux', architecture: 'amd64' } }] });
    });

    const state = await versions.chromeState('chromium');
    expect(state.registry.updateAvailable).toBe(false);
    expect(state.registry.localDigest).toBe('sha256:igual');
    expect(state.registry.remoteDigest).toBe('sha256:igual');
  });

  it('digests diferentes: atualização disponível', async () => {
    https.request.mockImplementation(fakeHttp({ versions: [{ version: '154.0.1.2' }] }));
    execFileSync.mockImplementation((cmd, args) => {
      if (args && args[0] === 'image') return '["repo@sha256:velho"]';
      return JSON.stringify({ manifests: [{ digest: 'sha256:novo', platform: { os: 'linux', architecture: 'amd64' } }] });
    });

    const state = await versions.chromeState('chromium');
    expect(state.registry.updateAvailable).toBe(true);
  });

  it('SEM digest local: updateAvailable é null, não false', async () => {
    https.request.mockImplementation(fakeHttp({ versions: [{ version: '154.0.1.2' }] }));
    execFileSync.mockImplementation((cmd, args) => {
      if (args && args[0] === 'image') throw new Error('imagem nao existe');
      return JSON.stringify({ manifests: [{ digest: 'sha256:x', platform: { os: 'linux', architecture: 'amd64' } }] });
    });

    const state = await versions.chromeState('chromium');
    // Este é o ponto: não saber NÃO é o mesmo que estar em dia.
    expect(state.registry.updateAvailable).toBe(null);
    expect(state.registry.error).toMatch(/não está no host/);
  });

  it('SEM digest remoto: updateAvailable é null', async () => {
    https.request.mockImplementation(fakeHttp({ versions: [{ version: '154.0.1.2' }] }));
    execFileSync.mockImplementation((cmd, args) => {
      if (args && args[0] === 'image') return '["repo@sha256:local"]';
      throw new Error('registry fora');
    });

    const state = await versions.chromeState('chromium');
    expect(state.registry.updateAvailable).toBe(null);
  });

  it('Google fora do ar: upstream.version null e motivo, sem lançar', async () => {
    https.request.mockImplementation(deadHttp());
    execFileSync.mockImplementation((cmd, args) => {
      if (args && args[0] === 'image') return '["repo@sha256:a"]';
      return JSON.stringify({ manifests: [{ digest: 'sha256:a', platform: { os: 'linux', architecture: 'amd64' } }] });
    });

    const state = await versions.chromeState('chromium');
    expect(state.upstream.version).toBe(null);
    expect(state.upstream.error).toMatch(/Google/);
    expect(state.upstream.majorsBehind).toBe(null);
  });

  it('calcula quantas majors está atrás do stable', async () => {
    https.request.mockImplementation(fakeHttp({ versions: [{ version: '160.0.1.2' }] }));
    execFileSync.mockImplementation((cmd, args) => {
      if (args && args[0] === 'image') return '["repo@sha256:a"]';
      return JSON.stringify({ manifests: [{ digest: 'sha256:a', platform: { os: 'linux', architecture: 'amd64' } }] });
    });

    const state = await versions.chromeState('chromium');
    // O instalado vem do chrome-version.service (fallback 154 sem Docker).
    expect(state.installed.major).toBe(154);
    expect(state.upstream.majorsBehind).toBe(6);
  });
});

describe('snapshot', () => {
  it('cacheia por 5 min e marca cached', async () => {
    https.request.mockImplementation(fakeHttp({ versions: [{ version: '154.0.1.2' }] }));
    execFileSync.mockImplementation((cmd, args) => {
      if (args && args[0] === 'image') return '["repo@sha256:a"]';
      return JSON.stringify({ manifests: [{ digest: 'sha256:a', platform: { os: 'linux', architecture: 'amd64' } }] });
    });

    const first = await versions.snapshot();
    expect(first.cached).toBe(false);

    const second = await versions.snapshot();
    expect(second.cached).toBe(true);

    const forced = await versions.snapshot({ force: true });
    expect(forced.cached).toBe(false);
  });

  it('traz chromium, brave e cloak', async () => {
    https.request.mockImplementation(fakeHttp({ versions: [{ version: '154.0.1.2' }] }));
    execFileSync.mockImplementation((cmd, args) => {
      if (args && args[0] === 'image') return '["repo@sha256:a"]';
      return JSON.stringify({ manifests: [{ digest: 'sha256:a', platform: { os: 'linux', architecture: 'amd64' } }] });
    });

    const snap = await versions.snapshot();
    expect(snap.chromium).toBeDefined();
    expect(snap.brave).toBeDefined();
    expect(snap.cloak).toBeDefined();
    expect(snap.cloak.free).toBeDefined();
    expect(snap.cloak.pro).toBeDefined();
  });
});
