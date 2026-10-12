/**
 * App - Main application initialization
 */
const App = {
  async init() {
    // Check authentication
    const isAuth = await Auth.checkAuth();
    if (!isAuth) return;

    // Set up create button
    const createBtn = document.getElementById('create-btn');
    if (createBtn) {
      createBtn.addEventListener('click', () => this.handleCreate());
    }

    // Set up VPN credentials button
    const vpnCredsBtn = document.getElementById('vpn-creds-btn');
    if (vpnCredsBtn) {
      vpnCredsBtn.addEventListener('click', () => VpnCreds.open());
    }

    // Set up dialog
    this.initDialog();

    // Start polling
    Polling.start();

    // Handle visibility change - pause/resume polling
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        Polling.stop();
      } else {
        Polling.start();
      }
    });
  },

  handleCreate() {
    // Show create dialog with country selector
    const dialog = document.getElementById('create-dialog');
    dialog.classList.remove('hidden');

    // Reset form to default (VPN) each time it opens
    this._resetCreateForm();
    this._setupCreateTypeToggle();

    const cancelBtn = document.getElementById('create-cancel');
    const confirmBtn = document.getElementById('create-confirm');

    // Remove old listeners
    const newCancel = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);
    const newConfirm = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirm, confirmBtn);

    newCancel.addEventListener('click', () => dialog.classList.add('hidden'));
    newConfirm.addEventListener('click', async () => {
      const payload = this._collectCreatePayload();
      if (payload === null) {
        // Validation failed (message already shown via toast)
        return;
      }

      newConfirm.classList.add('loading');
      newConfirm.disabled = true;

      try {
        await API.post('/instances', payload);
        this.showToast('Nova instância criada com sucesso', 'success');
        await Polling.fetchNow();
      } catch (err) {
        this.showToast(err.message || 'Erro ao criar instância', 'error');
      } finally {
        dialog.classList.add('hidden');
        newConfirm.classList.remove('loading');
        newConfirm.disabled = false;
      }
    });
  },

  /** Restaura o formulário de criação para o estado padrão (VPN). */
  _resetCreateForm() {
    const typeSel = document.getElementById('instance-type');
    if (typeSel) typeSel.value = 'vpn';

    const browserSel = document.getElementById('instance-browser');
    if (browserSel) browserSel.value = 'chromium';

    ['proxy-host', 'proxy-port', 'proxy-user', 'proxy-pass'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    const authCb = document.getElementById('proxy-auth');
    if (authCb) authCb.checked = false;

    this._applyCreateTypeVisibility('vpn');
  },

  /** Liga os listeners do seletor de tipo e do checkbox de auth (idempotente). */
  _setupCreateTypeToggle() {
    const typeSel = document.getElementById('instance-type');
    if (typeSel && !typeSel.dataset.bound) {
      typeSel.dataset.bound = '1';
      typeSel.addEventListener('change', () => this._applyCreateTypeVisibility(typeSel.value));
    }

    const authCb = document.getElementById('proxy-auth');
    if (authCb && !authCb.dataset.bound) {
      authCb.dataset.bound = '1';
      authCb.addEventListener('change', () => {
        const creds = document.getElementById('proxy-credentials');
        if (creds) creds.classList.toggle('hidden', !authCb.checked);
      });
    }
  },

  /** Mostra/esconde os grupos VPN e Proxy conforme o tipo selecionado. */
  _applyCreateTypeVisibility(type) {
    const vpnGroup = document.getElementById('vpn-country-group');
    const proxyFields = document.getElementById('proxy-fields');
    if (vpnGroup) vpnGroup.classList.toggle('hidden', type === 'proxy');
    if (proxyFields) proxyFields.classList.toggle('hidden', type !== 'proxy');
  },

  /**
   * Monta o payload de criação a partir do formulário.
   * Retorna null (com toast de erro) se a validação falhar.
   */
  _collectCreatePayload() {
    const typeEl = document.getElementById('instance-type');
    const type = typeEl ? typeEl.value : 'vpn';
    const browserEl = document.getElementById('instance-browser');
    const browser = browserEl && browserEl.value === 'brave' ? 'brave' : 'chromium';

    if (type === 'proxy') {
      const host = (document.getElementById('proxy-host').value || '').trim();
      const portRaw = (document.getElementById('proxy-port').value || '').trim();
      const scheme = document.getElementById('proxy-scheme').value;
      const auth = document.getElementById('proxy-auth').checked;
      const user = (document.getElementById('proxy-user').value || '').trim();
      const pass = document.getElementById('proxy-pass').value || '';

      if (!host || !portRaw) {
        this.showToast('Informe host e porta do proxy', 'error');
        return null;
      }
      const port = parseInt(portRaw, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        this.showToast('Porta de proxy inválida', 'error');
        return null;
      }
      if (auth && (!user || !pass)) {
        this.showToast('Proxy autenticado requer usuário e senha', 'error');
        return null;
      }

      return {
        type: 'proxy',
        browser,
        proxy: { host, port, scheme, auth, user, pass }
      };
    }

    const country = document.getElementById('country-select').value;
    const vpnProviderEl = document.getElementById('vpn-provider');
    const vpnProvider = vpnProviderEl && vpnProviderEl.value === 'expressvpn' ? 'expressvpn' : 'surfshark';
    return { country, type: 'vpn', browser, vpnProvider };
  },

  initDialog() {
    const overlay = document.getElementById('confirm-dialog');
    const cancelBtn = document.getElementById('dialog-cancel');

    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => this.hideDialog());
    }

    if (overlay) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) this.hideDialog();
      });
    }

    // ESC key closes dialog
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hideDialog();
    });
  },

  showConfirmDialog(title, message, onConfirm) {
    const overlay = document.getElementById('confirm-dialog');
    const titleEl = document.getElementById('dialog-title');
    const messageEl = document.getElementById('dialog-message');
    const confirmBtn = document.getElementById('dialog-confirm');

    titleEl.textContent = title;
    messageEl.textContent = message;
    overlay.classList.remove('hidden');

    // Remove old listener and add new one
    const newConfirmBtn = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);

    newConfirmBtn.addEventListener('click', async () => {
      newConfirmBtn.classList.add('loading');
      newConfirmBtn.disabled = true;
      try {
        await onConfirm();
      } finally {
        this.hideDialog();
      }
    });

    // Focus the cancel button for accessibility
    document.getElementById('dialog-cancel').focus();
  },

  hideDialog() {
    const overlay = document.getElementById('confirm-dialog');
    if (overlay) {
      overlay.classList.add('hidden');
    }
  },

  showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    if (!toast) return;

    toast.textContent = message;
    toast.className = `toast ${type}`;

    // Auto-hide after 3 seconds
    setTimeout(() => {
      toast.classList.add('hidden');
    }, 3000);
  }
};

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  // Only init app on dashboard page (not login)
  if (!document.getElementById('login-form')) {
    App.init();
  }
});
