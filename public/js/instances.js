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
    const vpn = instance.vpnInfo;

    // Só o CloakBrowser tem duas versões: antiga (sem chave) e nova (com licença).
    const isCloak = instance.browser === 'cloakbrowser';
    const cloakEdition = instance.cloakEdition === 'pro' ? 'pro' : 'free';

    // Selos CURTOS: cabem todos na mesma linha do título (separados por |).
    const typeBadge = type === 'proxy'
      ? `<span class="type-badge proxy">Proxy</span>`
      : `<span class="type-badge vpn">VPN</span>`;

    // Badge do navegador do perfil (Chromium, Brave ou CloakBrowser).
    const browserBadge = this.browserBadge(instance.browser);

    // Badge do provedor VPN (Surfshark ou ExpressVPN) — só para instâncias VPN.
    const vpnProviderBadge = type !== 'proxy'
      ? (instance.vpnProvider === 'expressvpn'
          ? `<span class="type-badge expressvpn" title="Provedor VPN: ExpressVPN">Expr</span>`
          : `<span class="type-badge surfshark" title="Provedor VPN: Surfshark">Surf</span>`)
      : '';

    // Título = número da instância + selos, separados por "|".
    const titleHtml = [String(instance.id), typeBadge, browserBadge, vpnProviderBadge]
      .filter(Boolean)
      .join(' <span class="title-sep">|</span> ');

    // Seção de conexão (proxy): mostra ONDE o proxy sai — geo do último teste
    // guardado na biblioteca (IP, cidade/país, fuso e ISP) — e não o endereço.
    // Sem geo na biblioteca, cai na geo do perfil.
    let connSection = '';
    if (type === 'proxy') {
      const geo = instance.proxyGeo || (instance.fingerprint && instance.fingerprint.geo) || {};
      const local = [geo.city, geo.country].filter(Boolean).join(', ') || 'N/A';
      connSection = `
          <div class="proxy-info">
            <div class="info-row">
              <span class="info-label">IP</span>
              <span class="info-value">${geo.ip || 'N/A'}</span>
            </div>
            <div class="info-row">
              <span class="info-label">Local</span>
              <span class="info-value">${local}</span>
            </div>
            <div class="info-row">
              <span class="info-label">Fuso</span>
              <span class="info-value">${geo.timezone || 'N/A'}</span>
            </div>
            <div class="info-row">
              <span class="info-label">ISP</span>
              <span class="info-value">${geo.isp || 'N/A'}</span>
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
            <div class="info-row">
              <span class="info-label">Timezone</span>
              <span class="info-value" title="Fuso do IP de saída">${vpn.timezone || 'N/A'}</span>
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
            ${titleHtml}
            <span class="title-sep">|</span>
            <span class="card-status ${instance.status}">${this.statusLabel(instance.status)}</span>
          </div>
        </div>
        <div class="card-body">
          ${connSection}${vpnSection}${fpSection}
        </div>
        <div class="card-actions">
          ${this.desktopButton(instance, url)}
          <button class="btn btn-secondary btn-sm action-upload" data-id="${instance.id}"
                  title="Enviar um ficheiro do seu computador para a pasta Downloads do perfil (para publicar nas redes)">
            <span class="btn-text">⬆ Enviar</span>
            <span class="btn-loading"><span class="spinner"></span></span>
          </button>
          ${startStopBtn}
          <button class="btn btn-secondary btn-sm action-restart" data-id="${instance.id}">
            <span class="btn-text">🔄 Restart</span>
            <span class="btn-loading"><span class="spinner"></span></span>
          </button>
          ${isCloak ? `<button class="btn btn-secondary btn-sm action-cloak-edition" data-id="${instance.id}" data-edition="${cloakEdition}"
                  title="${cloakEdition === 'pro' ? 'Versão nova do CloakBrowser (com licença)' : 'Versão antiga do CloakBrowser (sem chave)'}">
            <span class="btn-text">🗝️ ${cloakEdition === 'pro' ? 'Licença' : 'Antiga'}</span>
            <span class="btn-loading"><span class="spinner"></span></span>
          </button>` : ''}
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
   * Botão de abrir a tela — o ÚNICO acesso que o cartão mostra (o endereço e a
   * porta saíram do cartão). Vale para os três navegadores: no CloakBrowser a
   * tela é o cliente do KasmVNC do próprio container; no Chromium/Brave é a
   * área de trabalho servida no subdomínio.
   */
  desktopButton(instance, url) {
    if (instance.status !== 'running') return '';
    const target = (instance.vnc && instance.vnc.url) || url;
    if (!target) return '';

    return `<a class="btn btn-secondary btn-sm" href="${target}"
               target="_blank" rel="noopener">
              <span class="btn-text">🖥 Abrir tela</span>
            </a>`;
  },

  /** Selo do navegador do perfil (texto curto: cabe na linha do título). */
  browserBadge(browser) {
    if (browser === 'brave') {
      return `<span class="type-badge brave" title="Navegador: Brave">Brave</span>`;
    }
    if (browser === 'cloakbrowser') {
      return `<span class="type-badge cloakbrowser" title="Navegador: CloakBrowser (antidetect)">Cloak</span>`;
    }
    return `<span class="type-badge chromium" title="Navegador: Chromium">Chro</span>`;
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

    // CloakBrowser edition buttons
    document.querySelectorAll('.action-cloak-edition').forEach(btn => {
      btn.addEventListener('click', (e) => this.handleChangeCloakEdition(e));
    });

    // Change country buttons
    document.querySelectorAll('.action-country').forEach(btn => {
      btn.addEventListener('click', (e) => this.handleChangeCountry(e));
    });

    // Remove buttons
    document.querySelectorAll('.action-remove').forEach(btn => {
      btn.addEventListener('click', (e) => this.handleRemove(e));
    });

    // Upload buttons (ficheiro para o perfil)
    document.querySelectorAll('.action-upload').forEach(btn => {
      btn.addEventListener('click', (e) => this.handleUpload(e));
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
   * Abre o diálogo da VERSÃO do CloakBrowser, já com a edição atual escolhida.
   *
   * "Antiga (sem chave)" = binário livre — uma sessão em paralelo.
   * "Nova (com licença)" = binário novo + uma chave da biblioteca, que é o que
   * permite mais de uma sessão ao mesmo tempo.
   */
  handleChangeCloakEdition(e) {
    const id = e.currentTarget.dataset.id;
    const current = e.currentTarget.dataset.edition === 'pro' ? 'pro' : 'free';

    const dialog = document.getElementById('cloak-edition-dialog');
    const select = document.getElementById('cloak-edition-select');
    if (!dialog || !select) return;

    select.value = current;
    dialog.classList.remove('hidden');

    const cancelBtn = document.getElementById('cloak-edition-cancel');
    const confirmBtn = document.getElementById('cloak-edition-confirm');
    const newCancel = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);
    const newConfirm = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirm, confirmBtn);

    newCancel.addEventListener('click', () => dialog.classList.add('hidden'));
    newConfirm.addEventListener('click', async () => {
      const edition = select.value;
      if (edition === current) {
        dialog.classList.add('hidden');
        App.showToast('A instância já está nessa versão', 'error');
        return;
      }

      newConfirm.classList.add('loading');
      newConfirm.disabled = true;
      try {
        await API.post(`/instances/${id}/cloak-edition`, { edition });
        App.showToast(
          edition === 'pro'
            ? 'CloakBrowser na versão nova (com licença). Reiniciando...'
            : 'CloakBrowser na versão antiga (sem chave). Reiniciando...',
          'success'
        );
        await Polling.fetchNow();
      } catch (err) {
        App.showToast(err.message || 'Erro ao trocar a versão', 'error');
      } finally {
        dialog.classList.add('hidden');
        newConfirm.classList.remove('loading');
        newConfirm.disabled = false;
      }
    });
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

    // A lista de países vem do PROVEDOR da instância (cada um tem a sua no
    // gluetun: a ExpressVPN chama «USA» aos Estados Unidos, a Surfshark
    // «United States»). No modo proxy o select leva a biblioteca de proxies.
    const instance = this.instances.find((item) => String(item.id) === String(id));
    const provider = (instance && instance.vpnProvider) || 'surfshark';
    const currentCountry = (instance && instance.vpnInfo && instance.vpnInfo.country) || null;

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
    } else if (typeof VpnCountries !== 'undefined') {
      VpnCountries.fill(select, provider, currentCountry);
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

  /**
   * Envia um ficheiro do computador para a pasta de Downloads do perfil.
   *
   * Por que existe: ao publicar nas redes, o seletor de ficheiros do site abre o
   * sistema de ficheiros do CONTAINER (é o navegador do perfil que o mostra), e
   * não o do computador de quem usa o dashboard. Enviar o ficheiro para lá é o
   * que o torna escolhível.
   *
   * O ficheiro vai CRU no corpo do pedido (nada de base64, que pesaria 33% mais
   * e obrigaria a montar a cópia inteira na memória): o servidor escreve-o no
   * disco em streaming, então o tamanho só depende do espaço em disco.
   */
  handleUpload(e) {
    const id = e.currentTarget.dataset.id;
    const input = document.createElement('input');
    input.type = 'file';
    input.style.display = 'none';

    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) return;

      const btn = document.querySelector(`.action-upload[data-id="${id}"]`);
      if (btn) btn.classList.add('loading');

      try {
        const result = await this._sendFile(id, file, (percent) => {
          if (btn) btn.title = `A enviar "${file.name}" — ${percent}%`;
        });
        App.showToast(result.message || 'Ficheiro enviado', 'success');
      } catch (err) {
        App.showToast(err.message || 'Erro ao enviar o ficheiro', 'error');
      } finally {
        if (btn) {
          btn.classList.remove('loading');
          btn.removeAttribute('title');
        }
      }
    });

    document.body.appendChild(input);
    input.click();
  },

  /**
   * POST do ficheiro cru, com progresso.
   *
   * É `XMLHttpRequest` (e não `fetch`) por causa do `upload.onprogress`: num
   * vídeo de centenas de MB o usuário precisa de ver que está a andar.
   *
   * @param {string} id
   * @param {File} file
   * @param {(percent: number) => void} [onProgress]
   */
  _sendFile(id, file, onProgress) {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('POST', `/api/instances/${id}/files`);
      request.setRequestHeader('Content-Type', 'application/octet-stream');
      // O cabeçalho é latin-1: o nome (acentos, emojis) vai codificado.
      request.setRequestHeader('X-File-Name', encodeURIComponent(file.name));

      const token = API.getToken();
      if (token) request.setRequestHeader('Authorization', `Bearer ${token}`);

      request.upload.onprogress = (event) => {
        if (onProgress && event.lengthComputable && event.total) {
          onProgress(Math.round((event.loaded / event.total) * 100));
        }
      };

      request.onload = () => {
        let data = {};
        try {
          data = JSON.parse(request.responseText);
        } catch (err) {
          data = {};
        }

        if (request.status >= 200 && request.status < 300) return resolve(data);
        if (request.status === 401) {
          API.removeToken();
          window.location.href = '/login.html';
          return reject(new Error(data.message || 'Sessão expirada'));
        }
        reject(new Error(data.message || `Erro ${request.status}`));
      };

      request.onerror = () => reject(new Error('Erro de conexão com o servidor'));
      request.onabort = () => reject(new Error('Envio cancelado'));
      request.send(file);
    });
  },

  disableControls(disabled) {
    const createBtn = document.getElementById('create-btn');
    if (createBtn) createBtn.disabled = disabled;

    document.querySelectorAll('.action-start, .action-stop, .action-remove').forEach(btn => {
      btn.disabled = disabled;
    });
  }
};
