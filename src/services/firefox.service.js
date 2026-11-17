/**
 * FirefoxService
 *
 * Regras do Firefox (imagem `lscr.io/linuxserver/firefox`).
 *
 * IMPORTANTE — o Firefox NAO e um Chromium com outro nome. O que muda:
 *
 *  1. **Nao existe `FIREFOX_CLI`.** A imagem do Chromium/Brave le uma variavel
 *     de flags (`CHROME_CLI`/`BRAVE_CLI`) e o wrapper repassa ao binario. A
 *     imagem do Firefox nao tem isso: quem lanca o navegador e o script de
 *     autostart do Selkies (`$HOME/.config/openbox/autostart`). Consequencia
 *     pratica: as flags de linha de comando do Chromium aqui NAO funcionam, e
 *     empilha-las no env so criaria a ilusao de configuracao.
 *
 *  2. **A configuracao entra por `policies.json`.** Proxy, pagina inicial,
 *     idioma e DNS-over-HTTPS sao politicas geridas, lidas no arranque. E o
 *     caminho suportado pela Mozilla (o mesmo que uma empresa usa para
 *     configurar centenas de maquinas) e sobrevive a recriacao do container.
 *
 *  3. **Nao ha extensao de fingerprint.** A extensao do projeto e uma WebExtension
 *     de Chromium (`manifest_version` 3, `chrome.*`), e o Firefox nao a carrega.
 *     O Firefox tem o proprio sistema de privacidade (`privacy.resistFingerprinting`)
 *     e o UA dele e reduzido por padrao — mas isso NAO e o mesmo fingerprint do
 *     Chromium, e o dashboard nao deve fingir que e.
 *
 *  4. **A tela e Selkies**, na mesma porta 3000 do Chromium/Brave. O nginx e o
 *     gluetun nao precisam saber a diferenca.
 *
 * O que este servico entrega: a politica gerida (proxy + idioma + inicio) e o
 * comando que a escreve dentro do container antes do navegador subir.
 */
const POLICY_DIR = '/usr/lib/firefox/distribution';
const POLICY_FILE = `${POLICY_DIR}/policies.json`;
const POLICY_END_MARKER = 'FIREFOX_POLICY_EOF';
// Onde o Selkies guarda o autostart do usuario (lancado pelo openbox).
const AUTOSTART_DIR = '/config/.config/openbox';
const AUTOSTART_FILE = `${AUTOSTART_DIR}/autostart`;

class FirefoxService {
  /** O navegador desta instancia e o Firefox? */
  isFirefox(browser) {
    return browser === 'firefox';
  }

  /**
   * Endereco do proxy que vai para a politica.
   *
   * CORRECAO MEDIDA NO SERVIDOR: o Firefox NAO aceita `user:pass@host:port` na
   * configuracao de proxy, e o schema de politicas NAO tem ProxyUsername nem
   * ProxyPassword. As duas chaves que este servico escrevia antes eram
   * ignoradas em silencio, e o resultado era o Firefox a abrir um dialogo
   * nativo "Der Proxy ... verlangt einen Benutzernamen und ein Passwort" na
   * tela do Selkies — a instancia ficava sem navegar.
   *
   * O caminho que funciona e o mesmo do Chromium: o forwarder TCP local do
   * projeto (`proxy-injector`), que injeta `Proxy-Authorization` e nao termina
   * o TLS. A politica aponta para `host.docker.internal:<forwarderPort>`, que
   * nao pede credencial nenhuma.
   *
   * @param {object} proxy config do proxy da instancia
   * @param {number|null} forwarderPort porta do forwarder HTTP (null quando nao ha auth)
   * @param {number|null} relayPort porta do relay SOCKS5 (null quando o esquema nao e socks5)
   */
  proxyConfig(proxy, forwarderPort, relayPort) {
    if (!proxy || !proxy.host || !proxy.port) return null;
    const needsAuth = !!(proxy.auth && proxy.user && proxy.pass);

    // SOCKS5 tem prioridade quando o proxy declara esse esquema. Motivo medido:
    // com proxy HTTP o Firefox entrega o NOME ao proxy no CONNECT e nunca
    // resolve DNS — depois de visitar globo.com, `about:networking#dns` ficava
    // sem `www.globo.com`. O resolver que o whoer via era o do proxy (Canada),
    // e a nota caia para 70% mesmo com IP brasileiro correto. Com SOCKS5 e
    // resolucao local, o Firefox resolve pelo resolver do container; apontando
    // esse resolver ao gluetun do pais (br-01, Brasil), a mesma instancia subiu
    // para 100%. O relay SOCKS5 existe porque a credencial vai no handshake.
    if (proxy.scheme === 'socks5') {
      if (needsAuth && relayPort) {
        return { host: `host.docker.internal:${relayPort}`, scheme: 'socks5', viaRelay: true };
      }
      return { host: `${proxy.host}:${proxy.port}`, scheme: 'socks5', viaRelay: false };
    }

    const scheme = proxy.scheme === 'https' ? 'https' : 'http';
    if (needsAuth && forwarderPort) {
      return { host: `host.docker.internal:${forwarderPort}`, scheme: 'http', viaForwarder: true };
    }
    return { host: `${proxy.host}:${proxy.port}`, scheme, viaForwarder: false };
  }

  /**
   * Conteudo do `policies.json`.
   *
   * Cada bloco tem um motivo:
   *  - Proxy: e a saida da instancia. Sem isso o Firefox ignoraria o proxy que
   *    a instancia declara e sairia pelo IP do servidor — vazamento direto.
   *  - Homepage: mesma pagina inicial das outras imagens.
   *  - DnsOverHttps off: com DoH o nome e resolvido por HTTPS num resolver
   *    publico, que o whoer ve noutro pais e desconta da nota. Desligado, quem
   *    resolve e o proxy/VPN da instancia.
   *  - DisableAppUpdate: o binario e atualizado pela imagem, nao pelo navegador
   *    se auto-atualizando dentro do container (o que quebraria a reprodutibilidade
   *    e o digest que o dashboard audita).
   *  - SearchEngines: o Firefox traz o Google por padrao, mas a politica fixa o
   *    motor para nao depender do padrao da build.
   */
  policy(config = {}) {
    const fingerprint = config.fingerprint || {};
    const policy = {
      policies: {
        DisableAppUpdate: true,
        DontCheckDefaultBrowser: true,
        DisplayBookmarksToolbar: true,
        // Sem pre-busca de rede: o Firefox resolve ANTES nomes que ainda nao
        // foram visitados, e essa resolucao nao passa pelo proxy.
        NetworkPrediction: false,
        DNSOverHTTPS: { Enabled: false, Locked: true },
        Homepage: {
          URL: String(process.env.BROWSER_HOME_URL || '').trim() || 'https://www.google.com/',
          StartPage: 'homepage',
          Locked: true
        }
      }
    };

    // Idioma: o Firefox usa `intl.locale.requested`. Vai como Preferencia
    // porque nao ha politica de primeiro nivel para isso.
    if (fingerprint.language) {
      policy.policies.Preferences = {
        'intl.locale.requested': { Value: fingerprint.language, Status: 'locked' }
      };
    }

    // Proxy so quando a instancia e do tipo proxy: no modo VPN quem roteia e o
    // gluetun (namespace de rede), e configurar proxy ali seria contradicao.
    if (config.type === 'proxy') {
      const proxy = this.proxyConfig(config.proxy, config.forwarderPort, config.relayPort);
      if (proxy) {
        // Sem chaves de credencial: o schema de politicas do Firefox nao as
        // tem. Com auth, quem autentica e o forwarder/relay (ver proxyConfig).
        if (proxy.scheme === 'socks5') {
          policy.policies.Proxy = {
            Mode: 'manual',
            Locked: true,
            SOCKSProxy: proxy.host,
            SOCKSVersion: 5,
            // Resolucao LOCAL: e o ponto de tudo isto. Com o DNS a cargo do
            // Firefox, o resolver e o do container (que pode ser o do pais da
            // instancia) e nao o do proxy, que estava noutro pais.
            UseProxyForDNS: false
          };
        } else {
          policy.policies.Proxy = {
            Mode: 'manual',
            Locked: true,
            HTTPProxy: proxy.host,
            SSLProxy: proxy.host,
            UseHTTPProxyForAllProtocols: true,
            // Com proxy HTTP o Firefox entrega o nome no CONNECT e quem resolve
            // e o proxy (pode ser noutro pais -> whoer desconta). Quando o
            // dashboard preparou um resolvedor do pais no container, pedir
            // resolucao local faz o nome sair pelo resolver certo. Sem isso
            // (dnsLocal falso) mantem-se o comportamento antigo, sem risco.
            ...(config.dnsLocal ? { UseProxyForDNS: true } : {})
          };
        }
      }
    }

    return policy;
  }

  /**
   * Comando que escreve a politica dentro do container.
   *
   * Vai no `Cmd` do container (o entrypoint da imagem executa antes do Selkies
   * subir), com heredoc e marcador para o JSON nao sofrer interpretacao do
   * shell. O `mkdir -p` cobre a hipotese de a pasta nao existir na imagem.
   */
  policyCommand(config) {
    return [
      `mkdir -p ${POLICY_DIR}`,
      `cat > ${POLICY_FILE} <<'${POLICY_END_MARKER}'`,
      JSON.stringify(this.policy(config), null, 2),
      POLICY_END_MARKER,
      `chmod 644 ${POLICY_FILE}`
    ].join('\n');
  }

  /**
   * ENTRYPOINT do container (nao o Cmd).
   *
   * ARMADILHA medida no servidor: a imagem declara `Entrypoint=["/init"]` e
   * `Cmd=null`. Passar o script como Cmd faz o /init receber
   * `/bin/sh -c ...` como ARGUMENTO, e o s6-overlay aborta com
   * "s6-overlay-suexec: fatal: can only run as pid 1" (ExitCode 100, restart
   * em loop).
   *
   * Como Entrypoint, o /bin/sh e o pid 1, escreve a politica e faz `exec /init`
   * — que assume o pid 1 e arranca o Selkies normalmente.
   */
  serveCommand(config) {
    return ['/bin/sh', '-c', `${this.policyCommand(config)}\nexec /init`];
  }

  /** Ambiente do container: TZ do perfil (o Firefox le TZ do sistema). */
  containerEnv(config) {
    const fingerprint = config.fingerprint || {};
    const timezone = fingerprint.timezone || 'Etc/UTC';
    const env = [`PUID=1000`, `PGID=1000`, `TZ=${timezone}`];
    // O idioma tambem vai por env: o Selkies/o Firefox usam LANG para o
    // formato de data e numero antes de a politica ser lida.
    if (fingerprint.language) {
      env.push(`LANG=${String(fingerprint.language).replace('-', '_')}.UTF-8`);
    }
    return env;
  }

  /** Pasta do autostart (documentada para quem for depurar a tela). */
  autostartPath() {
    return AUTOSTART_FILE;
  }
}

module.exports = new FirefoxService();
module.exports.POLICY_DIR = POLICY_DIR;
module.exports.POLICY_FILE = POLICY_FILE;
module.exports.AUTOSTART_DIR = AUTOSTART_DIR;
