/**
 * InstanceService
 *
 * Orquestra o ciclo de vida de um perfil: containers (Docker), nginx do
 * subdomínio e o fingerprint alinhado à localização da conexão.
 *
 * Regra central: sempre que a instância vai subir, a localização real da saída
 * (país/cidade/fuso da VPN ou do proxy) é resolvida e o fingerprint é
 * re-alinhado a ela. O navegador nunca marca um fuso/idioma diferente do IP.
 */
const dockerService = require('./docker.service');
const instanceDiscovery = require('./instance-discovery.service');
const nginxService = require('./nginx.service');
const vpnService = require('./vpn.service');
const proxyInjector = require('./proxy-injector.service');
const fingerprintService = require('./fingerprint.service');
const profileFingerprint = require('./profile-fingerprint.service');
const locationResolver = require('./location-resolver.service');
const chromeContainer = require('./chrome-container.service');
const cloakbrowser = require('./cloakbrowser.service');
const proxiesService = require('./proxies.service');
const { getDb } = require('../database');
const crypto = require('crypto');

const BASE_PORT = parseInt(process.env.BASE_PORT || '3001', 10);
const MAX_INSTANCES = parseInt(process.env.MAX_INSTANCES || '20', 10);
const DOMAIN = process.env.DOMAIN || 'sakr.ath.cx';
const CONTAINER_SETTLE_MS = 2000;
// O túnel leva dezenas de segundos para revelar o IP de saída. O alinhamento
// insiste por ~21s e, se ainda não houver IP real, agenda tentativas mais tarde
// (senão o perfil fica preso no fuso do PAÍS, sem cidade e sem IP).
const EXIT_ALIGN_ATTEMPTS = 4;
const EXIT_ALIGN_RETRY_MS = 7000;
const EXIT_ALIGN_LATE_DELAYS_MS = [45000, 120000];
// A VPN pode trocar de cidade sozinha numa reconexão. Sem uma checagem
// periódica o perfil continua marcando o fuso da cidade antiga (o card da
// instância sinaliza isso como "DIVERGENTE" da saída real). O vigilante só
// re-injeta a extensão — nunca recria o container — então não derruba a
// sessão de quem está usando o navegador.
const EXIT_WATCH_INTERVAL_MS = parseInt(process.env.EXIT_WATCH_INTERVAL_MS || '120000', 10);
const ROW_COLUMNS =
  'id, port, subdomain, type, proxy_host, proxy_port, proxy_user, proxy_pass, ' +
  'proxy_scheme, proxy_auth, fingerprint, browser, vpn_provider';

class InstanceService {
  constructor() {
    this._aligning = new Set();   // ids com alinhamento em andamento
    this._exitWatcher = null;
  }

  async getAll() {
    let dockerConnected = true;
    let instances = [];

    try {
      instances = await instanceDiscovery.list();
    } catch (err) {
      dockerConnected = false;
      console.error('[ERROR] [instance-service] Docker inacessível:', err.message);
    }

    const dbMeta = this._readMetadata();

    const enriched = await Promise.all(
      instances.map(async (instance) => {
        const meta = dbMeta[instance.id];
        const type = instance.type || (meta && meta.type) || 'vpn';
        let vpnInfo = null;
        const healthStatus = { gluetun: 'unknown', chrome: 'unknown' };

        if (instance.status === 'running') {
          if (type === 'vpn' && instance.gluetunContainer) {
            try {
              vpnInfo = await vpnService.getVPNStatus(instance.gluetunContainer);
            } catch (err) {
              vpnInfo = { publicIP: null, country: null, connected: false, lastChecked: new Date().toISOString() };
            }
            healthStatus.gluetun = await dockerService.getContainerHealth(instance.gluetunContainer);
          }
          healthStatus.chrome = await dockerService.getContainerHealth(instance.chromeContainer);
        } else {
          healthStatus.gluetun = instance.status === 'stopped' ? 'stopped' : 'unknown';
          healthStatus.chrome = instance.status === 'stopped' ? 'stopped' : 'unknown';
        }

        return {
          ...instance,
          type,
          browser: (meta && meta.browser) || 'chromium',
          cdp: this._cdpFor(instance, meta),
          vnc: this._vncFor(instance, meta),
          vpnProvider: (meta && meta.vpn_provider) || 'surfshark',
          proxyInfo: type === 'proxy' && meta ? this._proxyInfoFromRow(meta) : null,
          fingerprint: this._parseJson(meta && meta.fingerprint),
          vpnInfo,
          healthStatus
        };
      })
    );

    return { instances: enriched, dockerConnected, lastUpdated: new Date().toISOString() };
  }

  async create(options = {}) {
    const type = options.type === 'proxy' ? 'proxy' : 'vpn';
    const browser = chromeContainer.normalizeBrowser(options.browser);
    const vpnProvider = options.vpnProvider === 'expressvpn' ? 'expressvpn' : 'surfshark';
    const port = await this.getNextAvailablePort();
    const id = port - BASE_PORT + 1;

    const config = { id, port, domain: DOMAIN, type, browser };

    if (type === 'proxy') {
      config.proxy = {
        host: options.proxy.host,
        port: options.proxy.port,
        user: options.proxy.user || '',
        pass: options.proxy.pass || '',
        scheme: options.proxy.scheme || 'http',
        auth: !!options.proxy.auth
      };
    } else {
      config.vpnProvider = vpnProvider;
      config.vpnType = 'openvpn';
      config.serverCountries = options.country || 'United States';
    }

    // Fingerprint já nasce alinhado à localização de saída (país escolhido na
    // VPN ou geo real do proxy).
    //
    // A semente é ALEATÓRIA e única (não "chrome<id>"): se ela ficasse presa ao
    // id, o sorteio de plataforma do gerador — que é determinístico por semente
    // — repetiria o mesmo resultado a cada recriação do mesmo id. Recriar a
    // instância #1 daria SEMPRE a mesma plataforma (foi o que fazia "aparecer
    // sempre macOS"). Com uma semente nova a cada create, cada instância sorteia
    // a sua identidade ao acaso e as recriações variam. Ela fica gravada no
    // campo `seed` do fingerprint (persistido na coluna da instância), então a
    // identidade continua estável enquanto a instância existir — restarts,
    // relocate e troca de país preservam o `seed` guardado e não re-sorteiam.
    // `options.fingerprint` (redefinição manual pelo usuário) segue tendo
    // precedência sobre a semente gerada aqui.
    const location = await this._resolveCreateLocation(config);
    const fingerprint = profileFingerprint.generate(this._randomSeed(), location, options.fingerprint);
    config.fingerprint = fingerprint;

    let instance = await dockerService.createInstance(config);

    try {
      await nginxService.addServerBlock(instance);
    } catch (err) {
      await dockerService.removeInstance(id).catch((removeErr) => {
        console.error('[ERROR] Rollback falhou:', removeErr.message);
      });
      throw new Error(`Falha ao configurar Nginx: ${err.message}`);
    }

    try {
      this._insertRow(id, port, type, config, fingerprint, browser, vpnProvider);
    } catch (err) {
      await nginxService.removeServerBlock(id).catch(() => { /* ignore */ });
      await dockerService.removeInstance(id).catch(() => { /* ignore */ });
      throw new Error(`Falha ao registrar instância: ${err.message}`);
    }

    // Antes de iniciar, confirma a localização real e ajusta o container
    // (TZ/idioma) para casar com ela.
    const prepared = await this._prepareInstance(id, { location });

    try {
      await dockerService.startInstance(id);
      instance.status = 'running';
    } catch (err) {
      console.warn(`[WARN] Instância criada mas não iniciada: ${err.message}`);
      instance.status = 'stopped';
    }

    // O túnel acabou de subir: agora dá para resolver a cidade/fuso REAIS da
    // saída e refinar o perfil. Neste momento o navegador ainda não tem sessão
    // para perder, então recriar o container é barato.
    const aligned = await this._alignToExit(id, true).catch((err) => {
      console.warn(`[WARN] [instance-service] Falha ao alinhar a instância ${id} à saída real:`, err.message);
      return null;
    });

    // VPN lenta: o perfil ainda está no fuso do país, sem cidade e sem IP.
    // Agenda novas tentativas para quando o túnel finalmente conectar.
    if (!aligned || !aligned.geo || !aligned.geo.ip) {
      this._scheduleExitAlignment(id);
    }

    console.log(`[${new Date().toISOString()}] [INFO] [instance-service] Instância ${id} criada na porta ${port}`);
    return this._decorateCreated(instance, config, browser, vpnProvider, aligned || prepared);
  }

  async remove(id) {
    await this._stopForwarder(id);

    try {
      await dockerService.removeInstance(id);
    } catch (err) {
      console.warn(`[WARN] Erro ao remover containers da instância ${id}:`, err.message);
    }

    try {
      await nginxService.removeServerBlock(id);
    } catch (err) {
      console.warn(`[WARN] Erro ao remover config nginx da instância ${id}:`, err.message);
    }

    getDb().prepare('DELETE FROM instances WHERE id = ?').run(id);
    console.log(`[${new Date().toISOString()}] [INFO] [instance-service] Instância ${id} removida`);
  }

  async start(id) {
    await this._ensureForwarder(id);
    await this._prepareInstance(id);
    await dockerService.startInstance(id);
    console.log(`[${new Date().toISOString()}] [INFO] [instance-service] Instância ${id} iniciada`);
  }

  async stop(id) {
    await dockerService.stopInstance(id);
    await this._stopForwarder(id);
    console.log(`[${new Date().toISOString()}] [INFO] [instance-service] Instância ${id} parada`);
  }

  async restart(id) {
    await dockerService.stopInstance(id);
    await new Promise((resolve) => setTimeout(resolve, CONTAINER_SETTLE_MS));
    await this._ensureForwarder(id);
    await this._prepareInstance(id);
    await dockerService.startInstance(id);
    // O túnel pode ter subido noutra cidade: re-alinha. Aqui a sessão do
    // usuário é preservada (sem recriar o browser); a extensão re-injetada já
    // corrige o fuso e o idioma que a página enxerga.
    await this._alignToExit(id, false).catch((err) => {
      console.warn(`[WARN] [instance-service] Falha ao re-alinhar a instância ${id}:`, err.message);
    });
    console.log(`[${new Date().toISOString()}] [INFO] [instance-service] Instância ${id} reiniciada`);
  }

  /**
   * Troca o país da VPN: recria os containers já com o fingerprint do novo
   * país e, depois de conectar, re-alinha à cidade/fuso reais da saída.
   */
  async changeCountry(id, country) {
    const row = this._rowFor(id);
    if (!row) {
      throw Object.assign(new Error(`Instância ${id} não encontrada`), { status: 404 });
    }
    if ((row.type || 'vpn') !== 'vpn') {
      throw Object.assign(new Error('Troca de país disponível apenas para instâncias VPN'), { status: 400 });
    }

    // Só os CONTAINERS caem: o volume do perfil (cookies/login) fica. Trocar de
    // país não pode apagar a sessão do usuário.
    await dockerService.removeContainers(id);
    await new Promise((resolve) => setTimeout(resolve, CONTAINER_SETTLE_MS));

    const location = await locationResolver.forVpn(country, null);
    // Relocaliza o perfil que já existe em vez de sortear uma identidade nova:
    // trocar de país muda idioma/fuso/geo, não a persona (plataforma, tela, GPU).
    const fingerprint = this._relocatedFingerprint(row, location);
    this._persistFingerprint(id, fingerprint);

    await dockerService.createInstance({
      id,
      port: row.port,
      domain: DOMAIN,
      type: 'vpn',
      browser: chromeContainer.normalizeBrowser(row.browser),
      vpnProvider: row.vpn_provider || 'surfshark',
      vpnType: 'openvpn',
      serverCountries: country,
      fingerprint
    });

    await this._prepareInstance(id, { country });
    await dockerService.startInstance(id);
    // Containers recém-criados: dá para aplicar o fuso exato da saída.
    const aligned = await this._alignToExit(id, true).catch((err) => {
      console.warn(`[WARN] [instance-service] Falha ao alinhar a instância ${id} após trocar de país:`, err.message);
      return null;
    });

    // Mesmo caso da criação: se o túnel ainda não deu IP, tenta de novo depois.
    if (!aligned || !aligned.geo || !aligned.geo.ip) {
      this._scheduleExitAlignment(id);
    }

    console.log(`[${new Date().toISOString()}] [INFO] [instance-service] Instância ${id} país alterado para ${country}`);
  }

  /**
   * Troca o proxy de uma instância: recria os containers com o proxy escolhido
   * na biblioteca e re-alinha o perfil à geo do novo IP de saída.
   *
   * É o equivalente do `changeCountry` para instâncias do tipo proxy. A
   * diferença é que a "localização" de um proxy não se escolhe: é o país de
   * onde ele sai. Por isso a troca é feita POR PROXY (a UI lista a biblioteca
   * rotulada pelo país do último teste), e não por um nome de país solto —
   * dois proxies do mesmo país não saem necessariamente pelo mesmo lugar.
   */
  async changeProxy(id, proxyId) {
    const row = this._rowFor(id);
    if (!row) {
      throw Object.assign(new Error(`Instância ${id} não encontrada`), { status: 404 });
    }
    if ((row.type || 'vpn') !== 'proxy') {
      throw Object.assign(new Error('Troca de proxy disponível apenas para instâncias Proxy'), { status: 400 });
    }

    // Credenciais vêm da biblioteca: a senha nunca passa pelo navegador.
    const proxy = proxiesService.getWithSecrets(proxyId);

    // O forwarder de autenticação segura o proxy ANTIGO; derruba antes de mexer.
    await this._stopForwarder(id);
    await dockerService.removeContainers(id);
    await new Promise((resolve) => setTimeout(resolve, CONTAINER_SETTLE_MS));

    const config = {
      id,
      port: row.port,
      domain: DOMAIN,
      type: 'proxy',
      browser: chromeContainer.normalizeBrowser(row.browser),
      proxy: {
        host: proxy.host,
        port: proxy.port,
        user: proxy.user || '',
        pass: proxy.pass || '',
        scheme: proxy.scheme || 'http',
        auth: !!proxy.auth
      }
    };

    const location = await this._resolveCreateLocation(config);
    const fingerprint = this._relocatedFingerprint(row, location);
    config.fingerprint = fingerprint;

    await dockerService.createInstance(config);
    // A linha precisa já ter o proxy NOVO: `_prepareInstance` e `_ensureForwarder`
    // montam o container e o forwarder a partir dela.
    this._updateProxyRow(id, config.proxy, fingerprint);
    await this._ensureForwarder(id);
    await this._prepareInstance(id, { location });
    await dockerService.startInstance(id);

    const aligned = await this._alignToExit(id, true).catch((err) => {
      console.warn(`[WARN] [instance-service] Falha ao alinhar a instância ${id} após trocar o proxy:`, err.message);
      return null;
    });

    // Proxy lento: o perfil ainda está sem cidade/IP. Tenta de novo depois.
    if (!aligned || !aligned.geo || !aligned.geo.ip) {
      this._scheduleExitAlignment(id);
    }

    console.log(`[${new Date().toISOString()}] [INFO] [instance-service] Instância ${id} proxy alterado para #${proxy.id}`);
  }

  async getVPNInfo(id) {
    return vpnService.getVPNStatus(`gluetun${id}`);
  }

  async getNextAvailablePort() {
    const db = getDb();
    const countResult = db.prepare('SELECT COUNT(*) as count FROM instances').get();
    if (countResult.count >= MAX_INSTANCES) {
      throw Object.assign(new Error(`Limite máximo de ${MAX_INSTANCES} instâncias atingido`), { status: 400 });
    }

    const usedPorts = db.prepare('SELECT port FROM instances ORDER BY port').all().map((r) => r.port);

    try {
      const dockerInstances = await instanceDiscovery.list();
      for (const inst of dockerInstances) {
        if (inst.port && !usedPorts.includes(inst.port)) usedPorts.push(inst.port);
      }
    } catch (err) {
      // Docker indisponível: decide só com o banco.
    }

    // Portas já publicadas por QUALQUER container do host — inclusive de outros
    // apps. Sem isso o dashboard escolhe uma porta ocupada e o Docker falha ao
    // subir o túnel ("address already in use"), deixando a instância pela metade.
    try {
      const published = await dockerService.listPublishedPorts();
      for (const port of published) {
        if (!usedPorts.includes(port)) usedPorts.push(port);
      }
    } catch (err) {
      // Sem Docker não há como checar; segue com o que o banco sabe.
    }

    for (let port = BASE_PORT; port < BASE_PORT + 100; port++) {
      if (!usedPorts.includes(port)) return port;
    }
    throw Object.assign(new Error('Nenhuma porta disponível no intervalo configurado'), { status: 400 });
  }

  /**
   * Antes de subir: resolve a localização real de saída, re-alinha o
   * fingerprint e garante que o container do Chrome tem o TZ/idioma do perfil.
   *
   * @param {number} id
   * @param {object} [hints] { location, country } para evitar trabalho repetido
   * @returns {Promise<object|null>} fingerprint em uso
   */
  async _prepareInstance(id, hints = {}) {
    const row = this._rowFor(id);
    if (!row) return null;

    if (row.type !== 'proxy') {
      // O túnel precisa estar de pé para revelar o IP de saída real.
      await dockerService.startVpnContainer(id).catch((err) => {
        console.warn(`[WARN] [instance-service] Falha ao subir gluetun${id}:`, err.message);
      });
    }

    // Sem localização já resolvida: espera o túnel revelar o IP real, senão o
    // perfil ficaria preso no fuso do país (sem cidade e sem IP).
    const location = hints.location || (await this._resolveExitWhenReady(row, hints.country));
    const stored = this._parseJson(row.fingerprint);
    const { fingerprint, changed } = profileFingerprint.sync(stored, this._seed(id), location);

    if (changed && fingerprint) {
      this._persistFingerprint(id, fingerprint);
      console.log(
        `[INFO] [fingerprint] chrome${id} alinhado a ${fingerprint.geo.country}` +
        `${fingerprint.geo.city ? '/' + fingerprint.geo.city : ''} (${fingerprint.timezone}, ${fingerprint.language})`
      );
    }

    if (!fingerprint) return null;

    // O vhost do CloakBrowser é o que separa o CDP (WebSocket) da tela no mesmo
    // subdomínio: garanti-lo aqui conserta sozinha a instância cujo vhost foi
    // escrito por uma versão anterior. É idempotente — arquivo igual não é
    // reescrito nem recarregado.
    if (cloakbrowser.isCloakBrowser(chromeContainer.normalizeBrowser(row.browser))) {
      try {
        await nginxService.addServerBlock({ id: row.id, port: row.port, browser: row.browser });
      } catch (err) {
        console.warn(`[WARN] [instance-service] Falha ao garantir o vhost da instância ${id}:`, err.message);
      }
    }

    if (!(await dockerService.isChromeRunning(id))) {
      const config = this._containerConfig(row, fingerprint);
      const result = await dockerService.ensureChromeContainer(config);
      if (result.recreated) {
        console.log(`[INFO] [instance-service] Container chrome${id} recriado (TZ/idioma do perfil mudaram)`);
      }
      // A extensão vive no /config do container: re-injeta sempre antes de subir.
      await this._injectFingerprint(id, fingerprint);
    } else if (changed) {
      // O container está no ar e o Docker não troca TZ/idioma sem recriá-lo.
      // A extensão cobre o que a página enxerga (fuso, idioma, tela), então
      // re-injetar resolve o alinhamento sem derrubar a sessão do usuário.
      await this._injectFingerprint(id, fingerprint);
    }

    return fingerprint;
  }

  /**
   * Re-alinha o perfil à localização REAL da saída depois que o túnel subiu.
   *
   * É o passo que refina o fuso do país para o fuso da cidade (ex.: um IP em
   * Vancouver não pode deixar o navegador marcando o horário de Toronto).
   *
   * @param {number} id
   * @param {boolean} recreateIfRunning quando true e o perfil mudou, o
   *   container do browser é recriado para o TZ/idioma exatos. Só use quando
   *   não há sessão para perder (instância recém-criada ou país trocado).
   * @param {object} [locationHint] localização já resolvida pelo chamador
   * @returns {Promise<object|null>} fingerprint alinhado
   */
  async _alignToExit(id, recreateIfRunning = false, locationHint = null) {
    const row = this._rowFor(id);
    if (!row) return null;

    const location = locationHint || (await this._resolveExitWhenReady(row));
    const stored = this._parseJson(row.fingerprint);
    const synced = profileFingerprint.sync(stored, this._seed(id), location);
    if (!synced.fingerprint) return null;
    const changed = synced.changed;

    // O IP de saída também é impressão digital quando ela viaja nas flags do
    // container (CloakBrowser: `--fingerprint-webrtc-ip`): um IP novo exige
    // recriar o container, mesmo que a cidade continue a mesma. No Chromium/Brave
    // quem cobre isso é a extensão, re-injetada sem derrubar a sessão.
    const ipChanged = this._fingerprintLivesInLaunchFlags(row)
      && !!location.ip
      && (stored && stored.geo ? stored.geo.ip : null) !== location.ip;

    if (!changed && !ipChanged) return synced.fingerprint;

    // O `sync` só relocaliza quando país/cidade/fuso mudam: com o MESMO lugar,
    // um IP novo não passaria por lá — e é ele que alimenta o WebRTC.
    const fingerprint = (ipChanged && !changed)
      ? fingerprintService.relocate(synced.fingerprint, location)
      : synced.fingerprint;

    this._persistFingerprint(id, fingerprint);
    console.log(
      `[INFO] [fingerprint] chrome${id} re-alinhado à saída real: ` +
      `${fingerprint.geo.country}${fingerprint.geo.city ? '/' + fingerprint.geo.city : ''} ` +
      `(${fingerprint.timezone}, ${fingerprint.language}, ip ${fingerprint.geo.ip || '-'})`
    );

    if (!(await dockerService.isChromeRunning(id))) {
      const config = this._containerConfig(row, fingerprint);
      await dockerService.ensureChromeContainer(config);
      await this._injectFingerprint(id, fingerprint);
      return fingerprint;
    }

    if (recreateIfRunning) {
      // Sem sessão para preservar: recria para o TZ e o --lang ficarem exatos.
      await dockerService.recreateChromeContainer(this._containerConfig(row, fingerprint));
      await dockerService.startInstance(id);
    } else if (this._fingerprintLivesInLaunchFlags(row)) {
      // O CloakBrowser não lê extensão: a impressão digital dele vai nas FLAGS
      // do comando (`--fingerprint-timezone`, `--fingerprint-webrtc-ip`...), que
      // só mudam recriando o container. Sem isto o perfil seguia com o fuso e o
      // WebRTC da saída ANTIGA enquanto o IP já era outro — o card mostrava uma
      // cidade e o navegador anunciava a anterior.
      await this._recreateForLaunchFlags(id, row, fingerprint);
    }

    await this._injectFingerprint(id, fingerprint);
    return fingerprint;
  }

  /**
   * A impressão digital deste perfil vive nas flags de lançamento do container?
   * Só o CloakBrowser é assim: nele não há extensão para re-injetar, então a
   * única forma de aplicar um alinhamento é recriar o container.
   */
  _fingerprintLivesInLaunchFlags(row) {
    return cloakbrowser.isCloakBrowser(chromeContainer.normalizeBrowser(row.browser));
  }

  /**
   * Recria o container para as flags refletirem o perfil atual — mas só quando a
   * spec mudou de facto (o `ensure` compara comando/ambiente/imagem/rede). Um
   * alinhamento que não muda nada (mesma cidade, mesmo IP) não reinicia nada.
   * O volume do perfil fica montado: a sessão (cookies/login) sobrevive; só as
   * abas abertas caem.
   *
   * @returns {Promise<boolean>} true quando o container foi mesmo recriado
   */
  async _recreateForLaunchFlags(id, row, fingerprint) {
    const result = await dockerService.ensureChromeContainer(this._containerConfig(row, fingerprint));
    if (!result || !result.recreated) return false;

    console.log(`[INFO] [instance-service] Container chrome${id} recriado para a impressão digital seguir o IP atual`);
    await dockerService.startInstance(id);
    return true;
  }

  /** A localização veio do IP de saída real, e não só do país escolhido? */
  _isResolvedExit(location) {
    return !!(location && location.ip);
  }

  /**
   * Insiste até o túnel revelar o IP de saída. Enquanto não revelar, a
   * localização é só o país escolhido (sem cidade e sem IP) e o perfil sairia
   * preso no fuso do país — foi assim que a cidade/IP ficaram nulos na UI.
   */
  async _resolveExitWhenReady(row, countryHint, attempts = EXIT_ALIGN_ATTEMPTS, waitMs = EXIT_ALIGN_RETRY_MS) {
    let location = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      location = await this._resolveCurrentLocation(row, countryHint);
      if (this._isResolvedExit(location)) return location;
      if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    return location;
  }

  /**
   * Agenda re-alinhamentos tardios para quando a VPN conecta depois do create
   * responder. Re-injeta a extensão sem recriar o container, para não derrubar
   * uma sessão que o usuário já tenha aberto.
   */
  _scheduleExitAlignment(id, delaysMs = EXIT_ALIGN_LATE_DELAYS_MS) {
    for (const delay of delaysMs) {
      const timer = setTimeout(() => {
        this._alignToExit(id, false).catch((err) => {
          console.warn(`[WARN] [instance-service] Re-alinhamento tardio da instância ${id} falhou:`, err.message);
        });
      }, delay);
      if (timer.unref) timer.unref();
    }
  }

  /**
   * Vigia a saída das instâncias em execução: a VPN pode reconectar sozinha
   * noutra cidade e o perfil ficaria marcando o fuso antigo (é o que o card
   * sinaliza como "DIVERGENTE"). A checagem só re-injeta a extensão, nunca
   * recria o container, então não derruba a sessão de quem está navegando.
   */
  startExitWatcher(intervalMs = EXIT_WATCH_INTERVAL_MS) {
    if (this._exitWatcher) return this._exitWatcher;

    const timer = setInterval(() => { this._checkExits(); }, intervalMs);
    if (timer.unref) timer.unref();
    this._exitWatcher = timer;
    return timer;
  }

  stopExitWatcher() {
    if (this._exitWatcher) clearInterval(this._exitWatcher);
    this._exitWatcher = null;
  }

  /** Uma passada do vigilante: alinha só o que está no ar e tem IP real. */
  async _checkExits() {
    let rows = [];
    try {
      rows = getDb().prepare('SELECT id FROM instances').all();
    } catch (err) {
      return; // banco indisponível: tenta no próximo ciclo
    }

    for (const row of rows) {
      if (this._aligning.has(row.id)) continue; // ciclo anterior ainda rodando

      this._aligning.add(row.id);
      try {
        if (!(await dockerService.isChromeRunning(row.id))) continue;

        const current = this._rowFor(row.id);
        if (!current) continue;

        const location = await this._resolveCurrentLocation(current);
        // Sem IP real não dá para saber a cidade: não mexe no perfil.
        if (!this._isResolvedExit(location)) continue;

        await this._alignToExit(row.id, false, location);
      } catch (err) {
        console.warn(`[WARN] [instance-service] Verificação da instância ${row.id} falhou:`, err.message);
      } finally {
        this._aligning.delete(row.id);
      }
    }
  }

  /**
   * Injeta a extensão de fingerprint; falha aqui não derruba a operação.
   * O CloakBrowser não usa extensão — a impressão digital dele é compilada no
   * binário e chega pela query da conexão CDP —, então nada é injetado.
   */
  async _injectFingerprint(id, fingerprint) {
    const row = this._rowFor(id);
    if (row && cloakbrowser.isCloakBrowser(row.browser)) return;

    try {
      await fingerprintService.inject(`chrome${id}`, fingerprint);
    } catch (err) {
      console.warn(`[WARN] [fingerprint] Falha ao injetar em chrome${id}:`, err.message);
    }
  }

  /** Localização para uma criação nova. */
  async _resolveCreateLocation(config) {
    if (config.type === 'proxy') {
      const { location, error } = await locationResolver.forProxy(config.proxy);
      if (error) {
        console.warn(`[WARN] [instance-service] Proxy sem geo (${error}); perfil neutro`);
      }
      return location;
    }
    return locationResolver.forVpn(config.serverCountries, null);
  }

  /** Localização atual de uma instância já existente. */
  async _resolveCurrentLocation(row, countryHint) {
    if (row.type === 'proxy') {
      const { location, error } = await locationResolver.forProxy(this._proxyConfigFromRow(row));
      if (error) {
        console.warn(`[WARN] [instance-service] Proxy ${row.id} sem geo (${error}); mantendo perfil`);
      }
      return location;
    }

    const country = countryHint || (await dockerService.getVpnCountry(row.id)) || 'United States';
    return locationResolver.forVpnConnected(country, `gluetun${row.id}`);
  }

  /** Config de instância (para o docker.service) a partir da linha do banco. */
  _containerConfig(row, fingerprint) {
    return {
      id: row.id,
      port: row.port,
      type: row.type || 'vpn',
      browser: chromeContainer.normalizeBrowser(row.browser),
      fingerprint,
      proxy: row.type === 'proxy' ? this._proxyConfigFromRow(row) : null
    };
  }

  _proxyConfigFromRow(row) {
    return {
      host: row.proxy_host,
      port: row.proxy_port,
      user: row.proxy_user,
      pass: row.proxy_pass,
      scheme: row.proxy_scheme || 'http',
      auth: !!row.proxy_auth
    };
  }

  _proxyInfoFromRow(row) {
    return {
      host: row.proxy_host,
      port: row.proxy_port,
      user: row.proxy_user,
      scheme: row.proxy_scheme || 'http',
      auth: !!row.proxy_auth
    };
  }

  /**
   * Bloco CDP das instâncias CloakBrowser (null nos outros navegadores).
   * É o que o cartão mostra no lugar da URL da área de trabalho: a conexão
   * Playwright/Puppeteer já com o fingerprint alinhado embutido.
   */
  _cdpFor(instance, meta) {
    const browser = (meta && meta.browser) || 'chromium';
    if (!cloakbrowser.isCloakBrowser(browser)) return null;
    const subdomain = instance.subdomain || `chrome${instance.id}.${DOMAIN}`;
    return cloakbrowser.describe(subdomain, this._parseJson(meta && meta.fingerprint));
  }

  /**
   * Bloco da TELA das instâncias CloakBrowser (null nos outros navegadores):
   * o cliente web do KasmVNC, servido na raiz do MESMO subdomínio — o nginx
   * separa o que é CDP (que vai para o Chrome) do que é tela.
   */
  _vncFor(instance, meta) {
    const browser = (meta && meta.browser) || 'chromium';
    if (!cloakbrowser.isCloakBrowser(browser)) return null;
    const subdomain = instance.subdomain || `chrome${instance.id}.${DOMAIN}`;
    return { url: cloakbrowser.desktopUrl(subdomain) };
  }

  /** Inicia o forwarder de autenticação de proxy, se a instância precisar. */
  async _ensureForwarder(id) {
    try {
      const row = this._rowFor(id);
      if (row && row.type === 'proxy' && row.proxy_auth) {
        await proxyInjector.start(id, this._proxyConfigFromRow(row));
      }
    } catch (err) {
      console.warn(`[WARN] [instance-service] Falha ao preparar forwarder da instância ${id}:`, err.message);
    }
  }

  async _stopForwarder(id) {
    try {
      if (proxyInjector.isRunning(id)) await proxyInjector.stop(id);
    } catch (err) {
      console.warn(`[WARN] [instance-service] Falha ao parar forwarder da instância ${id}:`, err.message);
    }
  }

  _rowFor(id) {
    try {
      return getDb().prepare(`SELECT ${ROW_COLUMNS} FROM instances WHERE id = ?`).get(id) || null;
    } catch (err) {
      return null;
    }
  }

  _readMetadata() {
    const meta = {};
    try {
      const rows = getDb()
        .prepare(`SELECT ${ROW_COLUMNS} FROM instances`)
        .all();
      for (const row of rows) meta[row.id] = row;
    } catch (err) {
      // Banco pode não estar pronto; segue só com os dados do Docker.
    }
    return meta;
  }

  _insertRow(id, port, type, config, fingerprint, browser, vpnProvider) {
    getDb().prepare(
      `INSERT OR REPLACE INTO instances
       (id, port, subdomain, type, proxy_host, proxy_port, proxy_user, proxy_pass, proxy_scheme, proxy_auth, fingerprint, browser, vpn_provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      port,
      `chrome${id}.${DOMAIN}`,
      type,
      type === 'proxy' ? config.proxy.host : null,
      type === 'proxy' ? config.proxy.port : null,
      type === 'proxy' ? config.proxy.user : null,
      type === 'proxy' ? config.proxy.pass : null,
      type === 'proxy' ? config.proxy.scheme : 'http',
      type === 'proxy' && config.proxy.auth ? 1 : 0,
      JSON.stringify(fingerprint),
      browser,
      type === 'vpn' ? vpnProvider : null
    );
  }

  /** Troca o proxy (e o fingerprint) de uma instância já registrada. */
  _updateProxyRow(id, proxy, fingerprint) {
    getDb().prepare(
      `UPDATE instances
       SET proxy_host = ?, proxy_port = ?, proxy_user = ?, proxy_pass = ?,
           proxy_scheme = ?, proxy_auth = ?, fingerprint = ?
       WHERE id = ?`
    ).run(
      proxy.host,
      proxy.port,
      proxy.user || '',
      proxy.pass || '',
      proxy.scheme || 'http',
      proxy.auth ? 1 : 0,
      JSON.stringify(fingerprint),
      id
    );
  }

  _persistFingerprint(id, fingerprint) {
    try {
      getDb().prepare('UPDATE instances SET fingerprint = ? WHERE id = ?').run(JSON.stringify(fingerprint), id);
    } catch (err) {
      console.warn(`[WARN] [instance-service] Falha ao salvar fingerprint da instância ${id}:`, err.message);
    }
  }

  /**
   * Fingerprint do perfil relocalizado para uma saída nova, preservando a
   * identidade (seed, plataforma, tela, GPU): trocar de país/proxy muda idioma,
   * fuso e geo — nunca a persona. Sem fingerprint guardado, gera um novo.
   *
   * @param {object} row linha da instância (com `fingerprint` e `id`)
   * @param {object} location localização normalizada da nova saída
   */
  _relocatedFingerprint(row, location) {
    const stored = this._parseJson(row.fingerprint);
    const synced = profileFingerprint.sync(stored, this._seed(row.id), location);
    return synced.fingerprint || profileFingerprint.generate(this._seed(row.id), location);
  }

  _decorateCreated(instance, config, browser, vpnProvider, fingerprint) {
    const decorated = Object.assign({}, instance, {
      browser,
      vpnProvider,
      fingerprint: fingerprint || config.fingerprint || null
    });

    // O CloakBrowser responde por dois caminhos: a tela (VNC, no mesmo
    // subdomínio) e a conexão CDP com o fingerprint alinhado.
    if (cloakbrowser.isCloakBrowser(browser)) {
      const subdomain = instance.subdomain || `chrome${config.id}.${DOMAIN}`;
      decorated.cdp = cloakbrowser.describe(subdomain, decorated.fingerprint);
      decorated.vnc = { url: cloakbrowser.desktopUrl(subdomain) };
    }

    if (config.type === 'proxy') {
      decorated.type = 'proxy';
      decorated.proxyInfo = {
        host: config.proxy.host,
        port: config.proxy.port,
        user: config.proxy.user,
        scheme: config.proxy.scheme,
        auth: config.proxy.auth
      };
    }
    return decorated;
  }

  _parseJson(value) {
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch (err) {
      return null;
    }
  }

  _seed(id) {
    return `chrome${id}`;
  }

  /**
   * Semente aleatória e única para o fingerprint de uma instância nova.
   *
   * Usa `crypto.randomBytes` (não `Math.random`): o sorteio precisa ser
   * imprevisível, não reproduzível. O formato (`p-<hex>`) é só um rótulo — o
   * gerador determinístico por semente (`fingerprint.service`) converte qualquer
   * string em plataforma/tela/GPU, e o binário do CloakBrowser converte a mesma
   * semente no `--fingerprint=<seedNumber>`. Guardada em `fingerprint.seed`, é o
   * que mantém a identidade estável entre reinícios da MESMA instância — mas,
   * ao contrário de `chrome<id>`, ela muda a cada create, então recriar uma
   * instância apagada volta a sortear a plataforma em vez de repetir a anterior.
   */
  _randomSeed() {
    return `p-${crypto.randomBytes(6).toString('hex')}`;
  }
}

module.exports = new InstanceService();
