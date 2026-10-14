/**
 * Especificação do container do navegador: TZ, --lang/--accept-lang, proxy e
 * extensão de fingerprint. É aqui que o fuso/idioma do perfil chegam ao Chrome.
 */
const chromeContainer = require('../src/services/chrome-container.service');
const cloakbrowser = require('../src/services/cloakbrowser.service');
const fingerprintService = require('../src/services/fingerprint.service');

const FINGERPRINT = {
  seed: 'chrome3',
  language: 'de-DE',
  languages: ['de-DE', 'de', 'en-US', 'en'],
  timezone: 'Europe/Berlin',
  geo: { country: 'Germany', countryCode: 'DE', timezone: 'Europe/Berlin' }
};

function vpnConfig(overrides) {
  return Object.assign({
    id: 3,
    port: 4003,
    type: 'vpn',
    browser: 'chromium',
    gluetunName: 'gluetun3',
    proxy: null,
    forwarderPort: null,
    fingerprint: FINGERPRINT
  }, overrides);
}

function proxyConfig(overrides) {
  return vpnConfig(Object.assign({
    type: 'proxy',
    proxy: { host: '1.2.3.4', port: 8080, scheme: 'http', auth: false }
  }, overrides));
}

function cliOf(env) {
  const entry = env.find((item) => item.startsWith('CHROME_CLI=') || item.startsWith('BRAVE_CLI='));
  return entry ? entry.slice(entry.indexOf('=') + 1) : '';
}

describe('buildEnv — fuso e idioma vêm do perfil', () => {
  it('exporta o TZ e as flags de idioma do fingerprint', () => {
    const env = chromeContainer.buildEnv(vpnConfig());
    expect(env).toContain('TZ=Europe/Berlin');
    expect(env).toContain('PUID=1000');
    expect(env).toContain('PGID=1000');

    const cli = cliOf(env);
    expect(cli).toContain('--lang=de-DE');
    expect(cli).toContain('--accept-lang=de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7');
    expect(cli).toContain('--load-extension=/config/fp-extension');
    expect(cli).toContain('--no-sandbox');
    expect(cli).not.toContain('--proxy-server');
  });

  it('abre o Google como página inicial (o mesmo padrão do CloakBrowser)', () => {
    const cli = cliOf(chromeContainer.buildEnv(vpnConfig()));

    expect(cli).toContain(cloakbrowser.HOME_URL);
    // A URL vai por ÚLTIMO: é uma URL solta no fim do CHROME_CLI/BRAVE_CLI que
    // o wrapper da LinuxServer manda o binário abrir.
    expect(cli.endsWith(cloakbrowser.HOME_URL)).toBe(true);
  });

  it('Brave usa BRAVE_CLI e a imagem do Brave', () => {
    const config = vpnConfig({ browser: 'brave' });
    const env = chromeContainer.buildEnv(config);
    expect(env.some((item) => item.startsWith('BRAVE_CLI='))).toBe(true);
    expect(env.some((item) => item.startsWith('CHROME_CLI='))).toBe(false);
    expect(chromeContainer.buildCreateOptions(config).Image).toBe(chromeContainer.BRAVE_IMAGE);
  });

  it('sem fingerprint cai no TZ neutro e não carrega extensão', () => {
    const env = chromeContainer.buildEnv(vpnConfig({ fingerprint: null }));
    expect(env).toContain('TZ=Etc/UTC');
    const cli = cliOf(env);
    expect(cli).not.toContain('--lang');
    expect(cli).not.toContain('--load-extension');
  });

  it('a lista de idiomas vira --accept-lang', () => {
    const config = vpnConfig({
      fingerprint: Object.assign({}, FINGERPRINT, { language: 'pt-BR', languages: ['pt-BR', 'en-US'] })
    });
    expect(cliOf(chromeContainer.buildEnv(config))).toContain('--accept-lang=pt-BR,en-US;q=0.9');
  });
});

describe('rede do container', () => {
  it('modo VPN compartilha o namespace do gluetun e não publica porta', () => {
    const host = chromeContainer.buildHostConfig(vpnConfig());
    expect(host.NetworkMode).toBe('container:gluetun3');
    expect(host.PortBindings).toBeUndefined();
    expect(host.ShmSize).toBe(chromeContainer.SHM_SIZE.chromium);

    const options = chromeContainer.buildCreateOptions(vpnConfig());
    expect(options.name).toBe('chrome3');
    expect(options.ExposedPorts).toBeUndefined();
  });

  it('modo proxy publica a porta e alcança o host', () => {
    const host = chromeContainer.buildHostConfig(proxyConfig());
    expect(host.NetworkMode).toBeUndefined();
    expect(host.PortBindings['3000/tcp']).toEqual([{ HostPort: '4003' }]);
    expect(host.ExtraHosts).toContain('host.docker.internal:host-gateway');

    const options = chromeContainer.buildCreateOptions(proxyConfig());
    expect(options.ExposedPorts).toEqual({ '3000/tcp': {} });
    expect(options.Image).toBe(chromeContainer.CHROME_IMAGE);
  });

  it('proxy sem autenticação aponta direto para o host:porta', () => {
    const cli = cliOf(chromeContainer.buildEnv(proxyConfig()));
    expect(cli).toContain('--proxy-server=http://1.2.3.4:8080');
  });

  it('proxy autenticado passa pelo forwarder local', () => {
    const config = proxyConfig({
      forwarderPort: 8153,
      proxy: { host: 'brd.superproxy.io', port: 44445, scheme: 'http', auth: true, user: 'u', pass: 'p' }
    });
    const cli = cliOf(chromeContainer.buildEnv(config));
    expect(cli).toContain('--proxy-server=http://host.docker.internal:8153');
    expect(cli).not.toContain('superproxy.io');
  });

  it('respeita o esquema https do proxy', () => {
    const config = proxyConfig({ proxy: { host: 'p.example', port: 443, scheme: 'https', auth: false } });
    expect(cliOf(chromeContainer.buildEnv(config))).toContain('--proxy-server=https://p.example:443');
  });
});

describe('matchesSpec — quando recriar o container', () => {
  function inspectFor(config) {
    const options = chromeContainer.buildCreateOptions(config);
    return {
      // Cmd entra porque o Docker devolve o comando no inspect — e no
      // CloakBrowser é ele que carrega o proxy.
      Config: { Image: options.Image, Cmd: options.Cmd, Env: options.Env.concat(['PATH=/usr/bin']) },
      HostConfig: options.HostConfig
    };
  }

  it('spec igual não recria', () => {
    const config = vpnConfig();
    expect(chromeContainer.matchesSpec(inspectFor(config), config)).toBe(true);
  });

  it('fuso diferente (VPN reconectou em outro país) recria', () => {
    const config = vpnConfig();
    const info = inspectFor(config);
    const moved = vpnConfig({
      fingerprint: Object.assign({}, FINGERPRINT, { timezone: 'America/Sao_Paulo' })
    });
    expect(chromeContainer.matchesSpec(info, moved)).toBe(false);
  });

  it('idioma diferente recria', () => {
    const config = vpnConfig();
    const info = inspectFor(config);
    const other = vpnConfig({
      fingerprint: Object.assign({}, FINGERPRINT, { language: 'pt-BR', languages: ['pt-BR'] })
    });
    expect(chromeContainer.matchesSpec(info, other)).toBe(false);
  });

  it('imagem diferente recria (chromium <-> brave)', () => {
    const config = vpnConfig();
    const info = inspectFor(config);
    expect(chromeContainer.matchesSpec(info, vpnConfig({ browser: 'brave' }))).toBe(false);
  });

  it('mudança de VPN para proxy (ou o contrário) recria', () => {
    const info = inspectFor(vpnConfig());
    expect(chromeContainer.matchesSpec(info, proxyConfig())).toBe(false);
    expect(chromeContainer.matchesSpec(inspectFor(proxyConfig()), vpnConfig())).toBe(false);
  });

  it('sem container devolve false', () => {
    expect(chromeContainer.matchesSpec(null, vpnConfig())).toBe(false);
  });
});

describe('integração com o fingerprint.service', () => {
  it('o caminho da extensão no container bate com o do injetor', () => {
    expect(chromeContainer.EXTENSION_CONTAINER_PATH).toBe(fingerprintService.CONTAINER_EXT_PATH);
  });
});
/**
 * CloakBrowser: o navegador antidetect fala CDP, não área de trabalho.
 *
 * Quatro diferenças que este bloco trava: a porta PUBLICADA é a do roteador
 * (9223 — o DevTools em 9222 e a tela do KasmVNC em 9225 ficam no loopback), o
 * comando é o binário do CloakBrowser lançado no X do container (não o
 * CHROME_CLI nem o cloakserve), o proxy vai inline na URL (sem o forwarder
 * local) e o perfil sobrevive à recriação.
 */
describe('CloakBrowser (antidetect por CDP)', () => {
  function cloakConfig(overrides) {
    return vpnConfig(Object.assign({ browser: 'cloakbrowser' }, overrides));
  }

  function cloakProxy(overrides) {
    return cloakConfig(Object.assign({
      type: 'proxy',
      proxy: { host: 'brd.superproxy.io', port: 44445, scheme: 'http', auth: false }
    }, overrides));
  }

  function inspectFor(config) {
    const options = chromeContainer.buildCreateOptions(config);
    return {
      Config: { Image: options.Image, Cmd: options.Cmd, Env: options.Env.concat(['PATH=/usr/bin']) },
      HostConfig: options.HostConfig
    };
  }

  describe('imagem, porta e comando', () => {
    it('usa a imagem do CloakBrowser e publica o roteador do CDP/tela', () => {
      const config = cloakConfig();
      expect(chromeContainer.imageFor(config)).toBe('chrome-vpn-dashboard-browser:latest');
      // DevTools (9222) e tela (9225) só escutam no loopback: quem expõe os
      // dois numa porta só é o roteador (9223).
      expect(chromeContainer.internalPortFor('cloakbrowser')).toBe('9223/tcp');
      expect(chromeContainer.internalPortFor('chromium')).toBe('3000/tcp');
      expect(chromeContainer.internalPortFor('brave')).toBe('3000/tcp');

      const options = chromeContainer.buildCreateOptions(config);
      const line = options.Cmd.join(' ');

      expect(options.Image).toBe('chrome-vpn-dashboard-browser:latest');
      // O binário é lançado direto no X do container (o cloakserve não abre janela).
      expect(options.Cmd[0]).toBe('/bin/sh');
      expect(line).toContain('/root/.cloakbrowser/chromium-*/chrome');
      expect(line).not.toContain('cloakserve');
      expect(line).toContain('--remote-debugging-port=9222');
      expect(line).toContain('--listen 9223 --cdp 9222 --screen 9225');
    });

    it('a imagem e a chave seguem a edição do CloakBrowser', () => {
      const previous = process.env.CLOAKBROWSER_IMAGE_PRO;
      process.env.CLOAKBROWSER_IMAGE_PRO = 'cloakhq/cloakbrowser:0.6.2';
      try {
        const pro = Object.assign(cloakConfig(), {
          cloakEdition: 'pro',
          cloakLicenseKey: 'chave-da-instancia'
        });
        const options = chromeContainer.buildCreateOptions(pro);

        // Imagem da versão nova (tag própria) e a chave da biblioteca no env.
        expect(options.Image).toBe('chrome-vpn-dashboard-browser:0.6.2');
        expect(options.Env).toContain('CLOAKBROWSER_LICENSE_KEY=chave-da-instancia');

        // A edição antiga fica na imagem por omissão e sem chave.
        const free = Object.assign(cloakConfig(), { cloakEdition: 'free', cloakLicenseKey: null });
        expect(chromeContainer.buildCreateOptions(free).Image).toBe('chrome-vpn-dashboard-browser:latest');
        expect(chromeContainer.buildCreateOptions(free).Env)
          .not.toContain('CLOAKBROWSER_LICENSE_KEY=chave-da-instancia');
      } finally {
        if (previous === undefined) delete process.env.CLOAKBROWSER_IMAGE_PRO;
        else process.env.CLOAKBROWSER_IMAGE_PRO = previous;
      }
    });

    it('a edição "nova" monta o volume do cache de binários', () => {
      const pro = Object.assign(cloakConfig(), { cloakEdition: 'pro', cloakLicenseKey: 'chave' });
      const binds = chromeContainer.buildHostConfig(pro).Binds;

      expect(binds).toContain(cloakbrowser.profileBind(pro.id));
      expect(binds).toContain(cloakbrowser.cacheBind());

      const free = Object.assign(cloakConfig(), { cloakEdition: 'free' });
      expect(chromeContainer.buildHostConfig(free).Binds).not.toContain(cloakbrowser.cacheBind());
    });

    it('pede o /dev/shm folgado que o KasmVNC + Chrome exigem', () => {
      expect(chromeContainer.SHM_SIZE.cloakbrowser).toBe(1073741824);
      expect(chromeContainer.buildHostConfig(cloakConfig()).ShmSize).toBe(1073741824);
    });

    it('normaliza o navegador: desconhecido vira chromium', () => {
      expect(chromeContainer.normalizeBrowser('cloakbrowser')).toBe('cloakbrowser');
      expect(chromeContainer.normalizeBrowser('brave')).toBe('brave');
      expect(chromeContainer.normalizeBrowser('firefox')).toBe('chromium');
      expect(chromeContainer.normalizeBrowser(undefined)).toBe('chromium');
    });
  });

  describe('ambiente: só o fuso, nada de CHROME_CLI', () => {
    it('exporta o TZ do perfil e nenhuma variável de flags', () => {
      const env = chromeContainer.buildEnv(cloakConfig());
      expect(env).toContain('TZ=Europe/Berlin');
      expect(env.some((item) => item.startsWith('CHROME_CLI='))).toBe(false);
      expect(env.some((item) => item.startsWith('BRAVE_CLI='))).toBe(false);
    });

    it('cai no TZ neutro sem perfil', () => {
      expect(chromeContainer.buildEnv(cloakConfig({ fingerprint: null }))).toContain('TZ=Etc/UTC');
    });

    it('a extensão de fingerprint não é injetada neste navegador', () => {
      const env = chromeContainer.buildEnv(cloakConfig());
      expect(env.some((item) => item.includes('--load-extension'))).toBe(false);
    });
  });

  describe('rede', () => {
    it('no modo VPN compartilha o namespace do gluetun (o gluetun publica o roteador)', () => {
      const host = chromeContainer.buildHostConfig(cloakConfig());
      expect(host.NetworkMode).toBe('container:gluetun3');
      expect(host.PortBindings).toBeUndefined();
      expect(chromeContainer.buildCreateOptions(cloakConfig()).ExposedPorts).toBeUndefined();
    });

    it('no modo proxy publica a porta do túnel — e não a 3000 nem a 9222', () => {
      const host = chromeContainer.buildHostConfig(cloakProxy());
      expect(host.PortBindings['9223/tcp']).toEqual([{ HostPort: '4003' }]);
      expect(host.PortBindings['9222/tcp']).toBeUndefined();
      expect(host.PortBindings['3000/tcp']).toBeUndefined();
      expect(chromeContainer.buildCreateOptions(cloakProxy()).ExposedPorts).toEqual({ '9223/tcp': {} });
    });

    it('não precisa do host.docker.internal: o proxy vai inline no comando', () => {
      const host = chromeContainer.buildHostConfig(cloakProxy());
      expect(host.ExtraHosts).toBeUndefined();

      const cmd = chromeContainer.buildCreateOptions(cloakProxy()).Cmd.join(' ');
      expect(cmd).toContain('--proxy-server=http://brd.superproxy.io:44445');
    });

    it('aceita credenciais na própria URL do proxy (sem forwarder)', () => {
      const config = cloakProxy({
        forwarderPort: 8153,
        proxy: { host: 'brd.superproxy.io', port: 44445, scheme: 'http', auth: true, user: 'u', pass: 'p' }
      });
      const cmd = chromeContainer.buildCreateOptions(config).Cmd.join(' ');
      expect(cmd).toContain('--proxy-server=http://u:p@brd.superproxy.io:44445');
      expect(cmd).not.toContain('host.docker.internal');
    });
  });

  describe('matchesSpec', () => {
    it('spec igual não recria', () => {
      const config = cloakConfig();
      expect(chromeContainer.matchesSpec(inspectFor(config), config)).toBe(true);
    });

    it('trocar de proxy recria (o proxy vive no comando)', () => {
      const info = inspectFor(cloakProxy());
      const outro = cloakProxy({ proxy: { host: '10.0.0.1', port: 3128, scheme: 'http', auth: false } });
      expect(chromeContainer.matchesSpec(info, outro)).toBe(false);
    });

    it('fuso diferente recria', () => {
      const info = inspectFor(cloakConfig());
      const movido = cloakConfig({
        fingerprint: Object.assign({}, FINGERPRINT, { timezone: 'America/Sao_Paulo' })
      });
      expect(chromeContainer.matchesSpec(info, movido)).toBe(false);
    });

    it('trocar para Chromium recria (imagem e comando diferentes)', () => {
      const info = inspectFor(cloakConfig());
      expect(chromeContainer.matchesSpec(info, vpnConfig())).toBe(false);
    });
  });
});
/**
 * CloakBrowser: o volume do perfil.
 *
 * A tela não precisa de nada compartilhado: quem a serve é o KasmVNC dentro do
 * próprio container do navegador. O que precisa sobreviver à recriação é o
 * perfil (`cloakbrowser-profile-<id>`), onde ficam cookies e login.
 */
describe('CloakBrowser — volume do perfil', () => {
  const cloakbrowser = require('../src/services/cloakbrowser.service');

  function cloakConfig(overrides) {
    return vpnConfig(Object.assign({ browser: 'cloakbrowser' }, overrides));
  }

  it('monta o volume do perfil nos dois modos (VPN e proxy)', () => {
    for (const config of [cloakConfig(), cloakConfig({ type: 'proxy', proxy: { host: '1.2.3.4', port: 80 } })]) {
      expect(chromeContainer.buildHostConfig(config).Binds).toContain(cloakbrowser.profileBind(config.id));
    }
  });

  it('não monta socket X nenhum: a tela é servida dentro do próprio container', () => {
    expect(chromeContainer.buildHostConfig(cloakConfig()).Binds)
      .toEqual([cloakbrowser.profileBind(3)]);
  });

  it('instância antiga (sem o volume do perfil) é recriada', () => {
    const config = cloakConfig();
    const options = chromeContainer.buildCreateOptions(config);
    const antiga = {
      Config: { Image: options.Image, Cmd: options.Cmd, Env: options.Env },
      HostConfig: Object.assign({}, options.HostConfig, { Binds: undefined })
    };

    expect(chromeContainer.matchesSpec(antiga, config)).toBe(false);
    expect(chromeContainer.matchesSpec({
      Config: { Image: options.Image, Cmd: options.Cmd, Env: options.Env },
      HostConfig: options.HostConfig
    }, config)).toBe(true);
  });

  it('Chromium/Brave não montam volume nenhum', () => {
    expect(chromeContainer.buildHostConfig(vpnConfig()).Binds).toBeUndefined();
    expect(chromeContainer.buildHostConfig(vpnConfig({ browser: 'brave' })).Binds).toBeUndefined();
  });
});
