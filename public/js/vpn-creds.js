/**
 * VpnCreds - Modal de credenciais VPN (Surfshark / ExpressVPN).
 * Lista o status e salva (PUT /api/vpn-credentials/:provider).
 */
const VpnCreds = {
  LABELS: { surfshark: 'Surfshark', expressvpn: 'ExpressVPN' },

  open() {
    const dialog = document.getElementById('vpn-creds-dialog');
    dialog.classList.remove('hidden');
    this._renderLoading();
    this._bindButtons();
    this.refresh();
  },

  close() {
    document.getElementById('vpn-creds-dialog').classList.add('hidden');
  },

  _bindButtons() {
    const cancel = document.getElementById('vpn-creds-cancel');
    const save = document.getElementById('vpn-creds-save');
    // Clone para remover listeners antigos (mesmo padrão dos outros dialogs)
    const newCancel = cancel.cloneNode(true);
    cancel.parentNode.replaceChild(newCancel, cancel);
    const newSave = save.cloneNode(true);
    save.parentNode.replaceChild(newSave, save);
    newCancel.addEventListener('click', () => this.close());
    newSave.addEventListener('click', () => this.save());
  },

  _renderLoading() {
    document.getElementById('vpn-creds-list').innerHTML =
      '<p class="form-hint">Carregando...</p>';
  },

  async refresh() {
    try {
      const data = await API.get('/vpn-credentials');
      const list = document.getElementById('vpn-creds-list');
      list.innerHTML = data.providers.map(p => this._providerHtml(p)).join('');
    } catch (err) {
      document.getElementById('vpn-creds-list').innerHTML =
        `<p class="form-hint">Erro ao carregar: ${err.message || 'falha'}</p>`;
    }
  },

  _providerHtml(p) {
    const label = this.LABELS[p.provider] || p.provider;
    const status = p.configured
      ? `<span class="type-badge surfshark">● Configurado</span>`
      : `<span class="type-badge">○ Não configurado</span>`;
    return `
      <div class="vpn-creds-provider" data-provider="${p.provider}">
        <div class="info-row">
          <span class="info-label">${label}</span>
          ${status}
        </div>
        <div class="form-group">
          <label for="vpn-user-${p.provider}">Usuário OpenVPN</label>
          <input type="text" id="vpn-user-${p.provider}" class="form-input" placeholder="usuário ${label}" autocomplete="off" />
        </div>
        <div class="form-group">
          <label for="vpn-pass-${p.provider}">Senha OpenVPN</label>
          <input type="password" id="vpn-pass-${p.provider}" class="form-input" placeholder="(em branco = manter atual)" autocomplete="off" />
        </div>
      </div>`;
  },

  async save() {
    const providers = ['surfshark', 'expressvpn'];
    let saved = 0;
    for (const provider of providers) {
      const userEl = document.getElementById(`vpn-user-${provider}`);
      const passEl = document.getElementById(`vpn-pass-${provider}`);
      const username = (userEl && userEl.value || '').trim();
      const password = (passEl && passEl.value) || '';
      // Linha vazia = não alterar este provedor
      if (!username && !password) continue;
      if (!username || !password) {
        App.showToast(`Preencha usuário E senha de ${this.LABELS[provider]}`, 'error');
        return;
      }
      try {
        await API.put(`/vpn-credentials/${provider}`, { username, password });
        saved++;
        if (passEl) passEl.value = '';
      } catch (err) {
        App.showToast(err.message || `Erro ao salvar ${this.LABELS[provider]}`, 'error');
        return;
      }
    }
    if (saved > 0) {
      App.showToast('Credenciais salvas com sucesso', 'success');
    } else {
      App.showToast('Nada para salvar (preencha um provedor)', 'error');
    }
    await this.refresh();
  }
};
