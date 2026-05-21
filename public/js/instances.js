/**
 * Instances - Rendering and control of instance cards
 */
const Instances = {
  instances: [],
  dockerConnected: true,

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
    const vpn = instance.vpnInfo;

    let vpnSection = '';
    if (instance.status === 'running') {
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
          </div>
          <span class="card-status ${instance.status}">${this.statusLabel(instance.status)}</span>
        </div>
        <div class="card-body">
          <div class="card-info">
            <div class="info-row">
              <span class="info-label">Porta</span>
              <span class="info-value">${instance.port}</span>
            </div>
            <div class="info-row">
              <span class="info-label">URL</span>
              <div class="url-row">
                <a href="${url}" target="_blank" rel="noopener" class="info-value">${domain}</a>
                <button class="copy-btn" data-url="${url}" title="Copiar URL">📋</button>
              </div>
            </div>
          </div>
          ${vpnSection}
        </div>
        <div class="card-actions">
          ${startStopBtn}
          <button class="btn btn-secondary btn-sm action-restart" data-id="${instance.id}">
            <span class="btn-text">🔄 Restart</span>
            <span class="btn-loading"><span class="spinner"></span></span>
          </button>
          <button class="btn btn-secondary btn-sm action-country" data-id="${instance.id}">
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

  handleChangeCountry(e) {
    const id = e.currentTarget.dataset.id;
    const dialog = document.getElementById('country-dialog');
    dialog.classList.remove('hidden');

    const cancelBtn = document.getElementById('country-cancel');
    const confirmBtn = document.getElementById('country-confirm');

    const newCancel = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);
    const newConfirm = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirm, confirmBtn);

    newCancel.addEventListener('click', () => dialog.classList.add('hidden'));
    newConfirm.addEventListener('click', async () => {
      const country = document.getElementById('change-country-select').value;
      newConfirm.classList.add('loading');
      newConfirm.disabled = true;

      try {
        await API.post(`/instances/${id}/country`, { country });
        App.showToast(`País alterado para ${country}. Reiniciando...`, 'success');
        await Polling.fetchNow();
      } catch (err) {
        App.showToast(err.message || 'Erro ao trocar país', 'error');
      } finally {
        dialog.classList.add('hidden');
        newConfirm.classList.remove('loading');
        newConfirm.disabled = false;
      }
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
