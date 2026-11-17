/**
 * firefox.service — a politica gerida que faz o Firefox obedecer ao perfil.
 *
 * O que estes testes protegem:
 *   - proxy autenticado chega ao policies.json (sem isso a instancia vazaria o
 *     IP do servidor, que e o pior defeito possivel aqui)
 *   - no modo VPN nao se configura proxy (seria contradicao com o gluetun)
 *   - DoH desligado e update do app desligado
 *   - o comando escreve o JSON com heredoc, sem o shell interpretar
 */
const firefox = require('../src/services/firefox.service');

const baseConfig = (over = {}) => ({
  id: 9,
  type: 'proxy',
  browser: 'firefox',
  proxy: { host: '10.0.0.1', port: 8080, scheme: 'http', auth: false },
  fingerprint: { timezone: 'Europe/Berlin', language: 'de-DE' },
  ...over
});

describe('firefox.service — politica gerida', () => {
  it('reconhece o proprio navegador', () => {
    expect(firefox.isFirefox('firefox')).toBe(true);
    expect(firefox.isFirefox('chromium')).toBe(false);
    expect(firefox.isFirefox(undefined)).toBe(false);
  });

  it('proxy sem auth entra como HTTPProxy/SSLProxy', () => {
    const p = firefox.policy(baseConfig());
    expect(p.policies.Proxy.Mode).toBe('manual');
    expect(p.policies.Proxy.HTTPProxy).toBe('10.0.0.1:8080');
    expect(p.policies.Proxy.SSLProxy).toBe('10.0.0.1:8080');
    expect(p.policies.Proxy.ProxyUsername).toBeUndefined();
  });

  // O schema de politicas do Firefox NAO tem ProxyUsername/ProxyPassword: as
  // chaves eram ignoradas e o Firefox abria um dialogo de credencial na tela.
  // Com auth, a politica aponta para o forwarder local, que injeta o cabecalho.
  it('proxy com auth aponta para o forwarder (sem chaves de credencial)', () => {
    const p = firefox.policy(baseConfig({
      proxy: { host: 'rp.example.com', port: 6060, scheme: 'http', auth: true, user: 'u1', pass: 'p1' },
      forwarderPort: 8155
    }));
    expect(p.policies.Proxy.HTTPProxy).toBe('host.docker.internal:8155');
    expect(p.policies.Proxy.SSLProxy).toBe('host.docker.internal:8155');
    expect(p.policies.Proxy.ProxyUsername).toBeUndefined();
    expect(p.policies.Proxy.ProxyPassword).toBeUndefined();
    expect(p.policies.Proxy.ProxyAuthMethod).toBeUndefined();
  });

  it('proxy sem auth vai direto ao upstream', () => {
    const p = firefox.policy(baseConfig({
      proxy: { host: 'rp.example.com', port: 6060, scheme: 'http', auth: false }
    }));
    expect(p.policies.Proxy.HTTPProxy).toBe('rp.example.com:6060');
  });

  // SOCKS5 existe por um motivo medido: com proxy HTTP o Firefox entrega o NOME
  // ao proxy no CONNECT e nunca resolve DNS (about:networking#dns ficava sem o
  // dominio visitado). O resolver que o whoer via era o do proxy, noutro pais, e
  // a nota caia para 70%. Com SOCKS5 + resolucao local + resolver do pais, a
  // mesma instancia passou a 100%.
  // Caso real da instancia 6: proxy HTTP + resolvedor do pais no container.
  // Sem UseProxyForDNS o nome ia no CONNECT e o whoer via o DNS do proxy.
  it('http com dnsLocal pede resolucao local no resolvedor do pais', () => {
    const p = firefox.policy(baseConfig({ dnsLocal: true }));
    expect(p.policies.Proxy.HTTPProxy).toBe('10.0.0.1:8080');
    expect(p.policies.Proxy.UseProxyForDNS).toBe(true);
  });

  it('http sem dnsLocal mantem comportamento antigo (sem UseProxyForDNS)', () => {
    const p = firefox.policy(baseConfig());
    expect(p.policies.Proxy.UseProxyForDNS).toBeUndefined();
  });

  it('socks5 com auth aponta para o relay e resolve nomes localmente', () => {
    const p = firefox.policy(baseConfig({
      proxy: { host: '65.111.20.169', port: 1080, scheme: 'socks5', auth: true, user: 'u1', pass: 'p1' },
      relayPort: 18106
    }));
    expect(p.policies.Proxy.Mode).toBe('manual');
    expect(p.policies.Proxy.SOCKSProxy).toBe('host.docker.internal:18106');
    expect(p.policies.Proxy.SOCKSVersion).toBe(5);
    // O ponto de tudo: resolucao LOCAL, senao o DNS volta a ser o do proxy.
    expect(p.policies.Proxy.UseProxyForDNS).toBe(false);
    // Nao pode cair no caminho HTTP.
    expect(p.policies.Proxy.HTTPProxy).toBeUndefined();
    expect(p.policies.Proxy.UseHTTPProxyForAllProtocols).toBeUndefined();
  });

  it('socks5 sem auth vai direto ao upstream', () => {
    const p = firefox.policy(baseConfig({
      proxy: { host: '65.111.20.169', port: 1080, scheme: 'socks5', auth: false }
    }));
    expect(p.policies.Proxy.SOCKSProxy).toBe('65.111.20.169:1080');
    expect(p.policies.Proxy.UseProxyForDNS).toBe(false);
  });

  it('socks5 com auth sem relayPort nao inventa endereco local', () => {
    const p = firefox.policy(baseConfig({
      proxy: { host: '65.111.20.169', port: 1080, scheme: 'socks5', auth: true, user: 'u1', pass: 'p1' }
    }));
    // Sem relay nao ha como autenticar: aponta ao upstream e nao a um
    // host.docker.internal que nao existe.
    expect(p.policies.Proxy.SOCKSProxy).toBe('65.111.20.169:1080');
  });

  it('modo VPN nao configura proxy', () => {
    const p = firefox.policy(baseConfig({ type: 'vpn', proxy: null }));
    expect(p.policies.Proxy).toBeUndefined();
  });

  it('DoH desligado e travado', () => {
    const p = firefox.policy(baseConfig());
    expect(p.policies.DNSOverHTTPS.Enabled).toBe(false);
    expect(p.policies.DNSOverHTTPS.Locked).toBe(true);
  });

  it('auto-update do app desligado (a imagem e que manda na versao)', () => {
    expect(firefox.policy(baseConfig()).policies.DisableAppUpdate).toBe(true);
  });

  it('idioma vira Preferencia travada', () => {
    const p = firefox.policy(baseConfig());
    expect(p.policies.Preferences['intl.locale.requested'].Value).toBe('de-DE');
    expect(p.policies.Preferences['intl.locale.requested'].Status).toBe('locked');
  });

  it('sem idioma no perfil, nao inventa Preferencia', () => {
    const p = firefox.policy(baseConfig({ fingerprint: { timezone: 'Etc/UTC' } }));
    expect(p.policies.Preferences).toBeUndefined();
  });

  it('pagina inicial e a mesma das outras imagens', () => {
    const p = firefox.policy(baseConfig());
    expect(p.policies.Homepage.URL).toMatch(/^https:\/\//);
    expect(p.policies.Homepage.Locked).toBe(true);
  });
});

describe('firefox.service — comando do container', () => {
  it('escreve o JSON com heredoc e marcador', () => {
    const cmd = firefox.policyCommand(baseConfig());
    expect(cmd).toContain('<<\'FIREFOX_POLICY_EOF\'');
    expect(cmd).toContain(firefox.POLICY_FILE);
    // O marcador fecha o heredoc: sem ele o shell engoliria o resto.
    expect(cmd.split('FIREFOX_POLICY_EOF').length - 1).toBe(2);
  });

  it('o JSON escrito e valido', () => {
    const cmd = firefox.policyCommand(baseConfig());
    const start = cmd.indexOf('{');
    const end = cmd.lastIndexOf('}');
    const json = cmd.slice(start, end + 1);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(JSON.parse(json).policies.Proxy.Mode).toBe('manual');
  });

  it('serveCommand escreve a politica e entrega ao init da imagem', () => {
    const cmd = firefox.serveCommand(baseConfig());
    expect(cmd[0]).toBe('/bin/sh');
    expect(cmd[1]).toBe('-c');
    expect(cmd[2]).toContain('FIREFOX_POLICY_EOF');
    expect(cmd[2]).toContain('exec /init');
  });

  it('ambiente leva TZ e LANG do perfil', () => {
    const env = firefox.containerEnv(baseConfig());
    expect(env).toContain('TZ=Europe/Berlin');
    expect(env).toContain('LANG=de_DE.UTF-8');
  });

  it('sem fuso no perfil cai em UTC', () => {
    const env = firefox.containerEnv(baseConfig({ fingerprint: {} }));
    expect(env).toContain('TZ=Etc/UTC');
  });
});
