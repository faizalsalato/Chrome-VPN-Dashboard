/**
 * Instances - Rendering and control of instance cards
 */
const Instances = {
  instances: [],
  dockerConnected: true,
  // Lista de países da VPN, guardada na 1ª abertura do diálogo de troca (o
  // mesmo <select> é reaproveitado no modo proxy, com a biblioteca de proxies).
  _vpnCountries: null,

  renderAll(data) {
    this.instances = data.instances || [];
    this.dockerConnected = data.dockerConnected !== false;

    const grid = document.getElementById('instance-grid');
    const loading = document.getElementById('loading-state');
    const empty = document.getElementById('empty-state');
    const banner = document.getElementById('connection-banner');
    const countEl = document.getElementById('instance-count');

    // Hide loading
    loading.classList.add('hidden');

    // Connection banner
    if (!this.dockerConnected) {
      banner.classList.remove('hidden');
      this.disableControls(true);
    } else {
      banner.classList.add('hidden');
      this.disableControls(false);
    }

    // Instance count
    if (countEl) {
      countEl.textContent = `${this.instances.length} instância(s)`;
    }

    // Empty state
    if (this.instances.length === 0) {
      empty.classList.remove('hidden');
      grid.classList.add('hidden');
      return;
    }

    empty.classList.add('hidden');
    grid.classList.remove('hidden');

    // Render cards
    grid.innerHTML = this.instances.map(inst => this.renderCard(inst)).join('');

    // Attach event listeners
    this.attachListeners();
  },

  renderCard(instance) {
    const domain = instance.subdomain || `chrome${instance.id}.sakr.ath.cx`;
    const url = `https://${domain}`;
    const type = instance.type || 'vpn';
    const proxy = instance.proxyInfo;
    const vpn = instance.vpnInfo;

    const typeBadge = type === 'proxy'
      ? `<span class="type-badge proxy">🌐 Proxy</span>`
      : `<span class="type-badge vpn">🔒 VPN</span>`;

    // Badge do navegador do perfil (Chromium, Brave ou CloakBrowser).
    const browserBadge = this.browserBadge(instance.browser);

    // Badge do provedor VPN (Surfshark ou ExpressVPN) — só para instâncias VPN.
    const vpnProviderBadge = type !== 'proxy'
      ? (instance.vpnProvider === 'expressvpn'
          ? `<span class="type-badge expressvpn" title="Provedor VPN: ExpressVPN">🛡️ ExpressVPN</span>`
          : `<span class="type-badge surfshark" title="Provedor VPN: Surfshark">🦈 Surfshark</span>`)
      : '';

    // Seção de conexão: Proxy (mutuamente exclusivo com VPN).
    let connSection = '';
    if (type === 'proxy') {
      const target = proxy ? `${proxy.scheme || 'http'}://${proxy.host}:${proxy.port}` : 'N/A';
      const authLabel = proxy ? (proxy.auth ? 'Sim' : 'Não') : 'N/A';
      connSection = `
          <div class="proxy-info">
            <div class="info-row">
              <span class="info-label">Conexão</span>
              <span class="info-value">Proxy</span>
            </div>
            <div class="info-row">
              <span class="info-label">Endereço</span>
              <span class="info-value">${target}</span>
            </div>
            <div class="info-row">
              <span class="info-label">Autenticação</span>
              <span class="info-value">${authLabel}</span>
            </div>
          </div>`;
    }

    let vpnSection = '';
    if (type !== 'proxy' && instance.status === 'running') {
      if (vpn && vpn.connected) {
        vpnSection = `
          <div class="vpn-info">
            <div class="info-row">
              <span class="info-label">VPN</span>
              <span class="vpn-status connected">● Conectada</span>
            </div>
            <div class="info-row">
              <span class="info-label">País</span>
              <span class="info-value">${vpn.country || 'N/A'}</span>
            </div>
            <div class="info-row">
              <span class="info-label">IP</span>
              <span class="info-value">${vpn.publicIP || 'N/A'}</span>
            </div>
          </div>`;
      } else if (vpn && !vpn.connected) {
        vpnSection = `
          <div class="vpn-info">
            <div class="info-row">
              <span class="info-label">VPN</span>
              <span class="vpn-status disconnected">● VPN Desconectada</span>
            </div>
          </div>`;
      } else {
        vpnSection = `
          <div class="vpn-info">
            <div class="info-row">
              <span class="info-label">VPN</span>
              <span class="vpn-status loading">⟳ Obtendo dados VPN...</span>
            </div>
          </div>`;
      }
    }

    // Seção de fingerprint (identidade antidetect + localização do perfil).
    const fpSection = FingerprintCard.render(instance);

    const startStopBtn = instance.status === 'running'
      ? `<button class="btn btn-secondary btn-sm action-stop" data-id="${instance.id}">
           <span class="btn-text">⏹ Parar</span>
           <span class="btn-loading"><span class="spinner"></span></span>
         </button>`
      : `<button class="btn btn-success btn-sm action-start" data-id="${instance.id}">
           <span class="btn-text">▶ Iniciar</span>
           <span class="btn-loading"><span class="spinner"></span></span>
         </button>`;

    return `
      <div class="instance-card" data-instance-id="${instance.id}">
        <div class="card-header">
          <div class="card-title">
            <span class="status-dot ${instance.status}"></span>
            Chrome ${instance.id}
            ${typeBadge}
            ${browserBadge}
            ${vpnProviderBadge}
          </div>
          <span class="card-status ${instance.status}">${this.statusLabel(instance.status)}</span>
        </div>
        <div class="card-body">
          <div class="card-info">
            <div class="info-row">
              <span class="info-label">Porta</span>
              <span class="info-value">${instance.port}</span>
            </div>
            ${this.accessRow(instance, url, domain)}
          </div>
          ${connSection}${vpnSection}${fpSection}
        </div>
        <div class="card-actions">
          ${this.desktopButton(instance)}
          ${startStopBtn}
          <button class="btn btn-secondary btn-sm action-restart" data-id="${instance.id}">
            <span class="btn-text">🔄 Restart</span>
            <span class="btn-loading"><span class="spinner"></span></span>
          </button>
          <button class="btn btn-secondary btn-sm action-country" data-id="${instance.id}" data-type="${type}"
                  title="${type === 'proxy' ? 'Trocar o proxy (escolha pelo país de saída)' : 'Trocar o país da VPN'}">
            <span class="btn-text">🌍 País</span>
            <span class="btn-loading"><span class="spinner"></span></span>
          </button>
          <button class="btn btn-danger btn-sm action-remove" data-id="${instance.id}">
            <span class="btn-text">🗑 Remover</span>
            <span class="btn-loading"><span class="spinner"></span></span>
          </button>
        </div>
      </div>`;
  },

  /**
   * Linhas de acesso do cartão.
   *
   * Chromium/Brave: uma URL só, a área de trabalho deles.
   *
   * CloakBrowser: a "Tela" é o cliente do KasmVNC servido pelo próprio
   * container do navegador (o endereço é limpo, sem query string: parâmetros
   * de resize encolhiam a janela do navegador).
   */
  accessRow(instance, url, domain) {
    if (!instance.vnc) {
      return `<div class="info-row">
              <span class="info-label">URL</span>
              <div class="url-row">
                <a href="${url}" target="_blank" rel="noopener" class="info-value">${domain}</a>
                <button class="copy-btn" data-url="${url}" title="Copiar URL">📋</button>
              </div>
            </div>`;
    }

    const vncUrl = instance.vnc.url;

    return `<div class="info-row">
              <span class="info-label">Tela</span>
              <div class="url-row">
                <a href="${vncUrl}" target="_blank" rel="noopener" class="info-value">${domain}</a>
                <button class="copy-btn" data-url="${vncUrl}" title="Copiar URL da tela">📋</button>
              </div>
            </div>`;
  },

  /** Botão de abrir a tela no card (só o CloakBrowser tem tela própria). */
  desktopButton(instance) {
    if (!instance.vnc) return '';
    if (instance.status !== 'running') return '';

    return `<a class="btn btn-secondary btn-sm" href="${instance.vnc.url}"
               target="_blank" rel="noopener">
              <span class="btn-text">🖥 Abrir tela</span>
            </a>`;
  },

  /** Selo do navegador do perfil. */
  browserBadge(browser) {
    if (browser === 'brave') {
      return `<span class="type-badge brave" title="Navegador: Brave">🦁 Brave</span>`;
    }
    if (browser === 'cloakbrowser') {
      return `<span class="type-badge cloakbrowser" title="Navegador: CloakBrowser (antidetect)">` +
        `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ` +
        `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
        `<path d="M12 3a7 7 0 0 0-7 7v10l2.5-2L10 20l2-2 2 2 2.5-2L19 20V10a7 7 0 0 0-7-7z"/>` +
        `<circle cx="9.5" cy="10.5" r="1"/><circle cx="14.5" cy="10.5" r="1"/></svg>` +
        `CloakBrowser</span>`;
    }
    return `<span class="type-badge chromium" title="Navegador: Chromium">🌀 Chromium</span>`;
  },

  statusLabel(status) {
    switch (status) {
      case 'running': return 'ATIVO';
      case 'stopped': return 'PARADO';
      case 'error': return 'ERRO';
      default: return status.toUpperCase();
    }
  },

  attachListeners() {
    // Start buttons
    document.querySelectorAll('.action-start').forEach(btn => {
      btn.addEventListener('click', (e) => this.handleStart(e));
    });

    // Stop buttons
    document.querySelectorAll('.action-stop').forEach(btn => {
      btn.addEventListener('click', (e) => this.handleStop(e));
    });

    // Restart buttons
    document.querySelectorAll('.action-restart').forEach(btn => {
      btn.addEventListener('click', (e) => this.handleRestart(e));
    });

    // Change country buttons
    document.querySelectorAll('.action-country').forEach(btn => {
      btn.addEventListener('click', (e) => this.handleChangeCountry(e));
    });

    // Remove buttons
    document.querySelectorAll('.action-remove').forEach(btn => {
      btn.addEventListener('click', (e) => this.handleRemove(e));
    });

    // Copy buttons
    document.querySelectorAll('.copy-btn').forEach(btn => {
      btn.addEventListener('click', (e) => this.handleCopy(e));
    });
  },

  async handleStart(e) {
    const btn = e.currentTarget;
    const id = btn.dataset.id;

    btn.classList.add('loading');
    btn.disabled = true;

    try {
      await API.post(`/instances/${id}/start`);
      App.showToast('Instância iniciada com sucesso', 'success');
      await Polling.fetchNow();
    } catch (err) {
      App.showToast(err.message || 'Erro ao iniciar instância', 'error');
    } finally {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  },

  async handleStop(e) {
    const btn = e.currentTarget;
    const id = btn.dataset.id;

    btn.classList.add('loading');
    btn.disabled = true;

    try {
      await API.post(`/instances/${id}/stop`);
      App.showToast('Instância parada com sucesso', 'success');
      await Polling.fetchNow();
    } catch (err) {
      App.showToast(err.message || 'Erro ao parar instância', 'error');
    } finally {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  },

  async handleRestart(e) {
    const btn = e.currentTarget;
    const id = btn.dataset.id;

    btn.classList.add('loading');
    btn.disabled = true;

    try {
      await API.post(`/instances/${id}/restart`);
      App.showToast('Instância reiniciada com sucesso', 'success');
      await Polling.fetchNow();
    } catch (err) {
      App.showToast(err.message || 'Erro ao reiniciar instância', 'error');
    } finally {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  },

  /**
   * Abre o diálogo de troca de saída da instância.
   *
   * VPN: escolhe-se o PAÍS do túnel (`POST /instances/:id/country`).
   * Proxy: não há país a escolher — o país é onde o proxy sai —, então a mesma
   * tela lista a biblioteca de proxies rotulada pelo país do último teste
   * (`POST /instances/:id/proxy`). É o "trocar o proxy pelo país".
   */
  async handleChangeCountry(e) {
    const id = e.currentTarget.dataset.id;
    const isProxy = e.currentTarget.dataset.type === 'proxy';

    const dialog = document.getElementById('country-dialog');
    const select = document.getElementById('change-country-select');
    const title = document.getElementById('country-dialog-title');
    const label = document.getElementById('country-dialog-label');
    const hint = document.getElementById('country-dialog-hint');

    // A lista de países da VPN nasce no HTML; guardada na primeira abertura,
    // volta sempre que o diálogo abre em modo VPN (senão ficava com os proxies).
    if (!this._vpnCountries) {
      this._vpnCountries = Array.from(select.options).map(o => ({ value: o.value, text: o.textContent }));
    }

    if (isProxy) {
      let proxies = [];
      try {
        const data = await API.get('/proxies');
        proxies = data.proxies || [];
      } catch (err) {
        App.showToast(err.message || 'Erro ao carregar a biblioteca de proxies', 'error');
        return;
      }
      if (!proxies.length) {
        App.showToast('Nenhum proxy cadastrado — adicione no menu Proxies', 'error');
        return;
      }
      this._fillSelect(select, proxies.map(p => ({
        value: String(p.id),
        text: typeof ProxyLabel !== 'undefined' ? ProxyLabel.forPick(p) : `#${p.id}`
      })));
    } else {
      this._fillSelect(select, this._vpnCountries);
    }

    if (title) title.textContent = isProxy ? 'Trocar Proxy' : 'Trocar País da VPN';
    if (label) label.textContent = isProxy ? 'Proxy (pelo país de saída)' : 'Novo País';
    if (hint) hint.classList.toggle('hidden', !isProxy);

    dialog.classList.remove('hidden');

    const cancelBtn = document.getElementById('country-cancel');
    const confirmBtn = document.getElementById('country-confirm');

    const newCancel = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);
    const newConfirm = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirm, confirmBtn);

    newCancel.addEventListener('click', () => dialog.classList.add('hidden'));
    newConfirm.addEventListener('click', async () => {
      const value = select.value;
      if (!value) {
        App.showToast('Escolha uma opção para continuar', 'error');
        return;
      }
      const chosen = select.options[select.selectedIndex];
      const chosenText = chosen ? chosen.textContent : value;
      newConfirm.classList.add('loading');
      newConfirm.disabled = true;

      try {
        if (isProxy) {
          await API.post(`/instances/${id}/proxy`, { proxyId: value });
          App.showToast(`Proxy alterado para ${chosenText}. Reiniciando...`, 'success');
        } else {
          await API.post(`/instances/${id}/country`, { country: value });
          App.showToast(`País alterado para ${value}. Reiniciando...`, 'success');
        }
        await Polling.fetchNow();
      } catch (err) {
        App.showToast(err.message || 'Erro ao trocar a saída da instância', 'error');
      } finally {
        dialog.classList.add('hidden');
        newConfirm.classList.remove('loading');
        newConfirm.disabled = false;
      }
    });
  },

  /** Troca todas as opções de um <select> de uma vez. */
  _fillSelect(select, options) {
    select.textContent = '';
    options.forEach((o) => {
      const option = document.createElement('option');
      option.value = o.value;
      option.textContent = o.text;
      select.append(option);
    });
  },

  handleRemove(e) {
    const id = e.currentTarget.dataset.id;
    App.showConfirmDialog(
      'Confirmar Remoção',
      `Tem certeza que deseja remover a instância Chrome ${id}? Esta ação não pode ser desfeita.`,
      async () => {
        try {
          await API.delete(`/instances/${id}`);
          App.showToast('Instância removida com sucesso', 'success');
          await Polling.fetchNow();
        } catch (err) {
          App.showToast(err.message || 'Erro ao remover instância', 'error');
        }
      }
    );
  },

  async handleCopy(e) {
    const btn = e.currentTarget;
    const url = btn.dataset.url;

    try {
      await navigator.clipboard.writeText(url);
      btn.textContent = '✓';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = '📋';
        btn.classList.remove('copied');
      }, 3000);
    } catch (err) {
      App.showToast('Não foi possível copiar a URL', 'error');
    }
  },

  disableControls(disabled) {
    const createBtn = document.getElementById('create-btn');
    if (createBtn) createBtn.disabled = disabled;

    document.querySelectorAll('.action-start, .action-stop, .action-remove').forEach(btn => {
      btn.disabled = disabled;
    });
  }
};
