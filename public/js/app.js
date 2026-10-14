/**
 * App - Main application initialization
 */
const App = {
  async init() {
    // Check authentication
    const isAuth = await Auth.checkAuth();
    if (!isAuth) return;

    // Theme toggle (light/dark) with persistence
    this.initTheme();

    // Set up create button
    const createBtn = document.getElementById('create-btn');
    if (createBtn) {
      createBtn.addEventListener('click', () => this.handleCreate());
    }

    // Set up VPN credentials button (na sidebar)
    const vpnCredsBtn = document.getElementById('vpn-creds-btn');
    if (vpnCredsBtn) {
      vpnCredsBtn.addEventListener('click', () => VpnCreds.open());
    }

    // Set up sidebar navigation (troca de views: Instâncias / Proxies)
    this.initNav();

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

  /**
   * Liga os itens da sidebar que trocam de view (data-view).
   */
  initNav() {
    document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
      btn.addEventListener('click', () => this.switchView(btn.dataset.view));
    });
  },

  /**
   * Alterna entre as views: 'instances' (main) e 'proxies' (página dedicada).
   */
  switchView(name) {
    const isProxies = name === 'proxies';
    const main = document.querySelector('.main-content');
    const proxies = document.getElementById('view-proxies');

    if (main) main.classList.toggle('hidden', isProxies);
    if (proxies) proxies.classList.toggle('hidden', !isProxies);

    // Atualiza o item ativo da sidebar
    document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === name);
    });

    // Ao entrar em Proxies, inicializa a página (formulário + lista)
    if (isProxies && typeof ProxiesLib !== 'undefined' && ProxiesLib.activate) {
      ProxiesLib.activate();
    }

    // Volta ao topo ao trocar de view
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
      const payload = await this._collectCreatePayload();
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

  /**
   * Inicializa o tema: reflete o tema atual no ícone do botão e liga o toggle.
   * O tema já foi aplicado no <head> (anti-flash); aqui só sincronizamos a UI.
   */
  initTheme() {
    const btn = document.getElementById('theme-toggle');
    this._syncThemeIcon();
    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = '1';
      btn.addEventListener('click', () => this.toggleTheme());
    }
  },

  /** Alterna entre 'dark' e 'light', persiste e atualiza o ícone. */
  toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    const next = current === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('theme', next);
    } catch (e) {
      // localStorage indisponível (modo privado) - tema vale só nesta sessão
    }
    this._syncThemeIcon();
  },

  /** Atualiza o ícone do botão conforme o tema ativo (☀️ no claro, 🌙 no escuro). */
  _syncThemeIcon() {
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    btn.textContent = isLight ? '☀️' : '🌙';
    btn.title = isLight ? 'Mudar para tema escuro' : 'Mudar para tema claro';
  },

  /** Restaura o formulário de criação para o estado padrão (VPN). */
  _resetCreateForm() {
    const typeSel = document.getElementById('instance-type');
    if (typeSel) typeSel.value = 'vpn';

    const browserSel = document.getElementById('instance-browser');
    if (browserSel) browserSel.value = 'chromium';
    this._syncBrowserHint();

    // Proxy: só se escolhe um item da biblioteca (nada é digitado aqui).
    const savedSel = document.getElementById('proxy-saved');
    if (savedSel) savedSel.value = '';
    this._showPickedProxy(null);

    // Recarrega a biblioteca de proxies no seletor "Proxy salvo"
    ProxiesLib.fillCreateSelect();

    this._applyCreateTypeVisibility('vpn');
  },

  /** Liga os listeners do seletor de tipo e do proxy salvo (idempotente). */
  _setupCreateTypeToggle() {
    const typeSel = document.getElementById('instance-type');
    if (typeSel && !typeSel.dataset.bound) {
      typeSel.dataset.bound = '1';
      typeSel.addEventListener('change', () => this._applyCreateTypeVisibility(typeSel.value));
    }

    const savedSel = document.getElementById('proxy-saved');
    if (savedSel && !savedSel.dataset.bound) {
      savedSel.dataset.bound = '1';
      savedSel.addEventListener('change', () => ProxiesLib.applySavedPick(savedSel.value));
    }

    // A nota do CDP só interessa quando o navegador escolhido é o CloakBrowser.
    const browserSel = document.getElementById('instance-browser');
    if (browserSel && !browserSel.dataset.hintBound) {
      browserSel.dataset.hintBound = '1';
      browserSel.addEventListener('change', () => this._syncBrowserHint());
    }
  },

  /** Mostra a nota do CDP apenas com o CloakBrowser selecionado. */
  _syncBrowserHint() {
    const hint = document.getElementById('browser-cdp-hint');
    const browserSel = document.getElementById('instance-browser');
    if (!hint || !browserSel) return;
    hint.classList.toggle('hidden', browserSel.value !== 'cloakbrowser');
  },

  /** Mostra/esconde os grupos VPN e Proxy conforme o tipo selecionado. */
  _applyCreateTypeVisibility(type) {
    const isProxy = type === 'proxy';
    const vpnGroup = document.getElementById('vpn-country-group');
    const proxyFields = document.getElementById('proxy-fields');
    if (vpnGroup) vpnGroup.classList.toggle('hidden', isProxy);
    if (proxyFields) proxyFields.classList.toggle('hidden', !isProxy);

    // Ao entrar em Proxy, garante a lista atual da biblioteca.
    if (isProxy) {
      const savedSel = document.getElementById('proxy-saved');
      if (savedSel && !savedSel.options.length) ProxiesLib.fillCreateSelect();
    }
  },

  /**
   * Desenha o resumo do proxy escolhido (país/cidade/fuso do último teste).
   * @param {object|null} proxy
   */
  _showPickedProxy(proxy) {
    const box = document.getElementById('proxy-picked');
    if (!box) return;
    box.textContent = '';
    if (!proxy) {
      box.classList.add('hidden');
      return;
    }
    box.append(ProxyCard.pickSummaryEl(proxy));
    box.classList.remove('hidden');
  },

  /**
   * Monta o payload de criação a partir do formulário.
   * No caso de proxy, o item escolhido é lido da biblioteca (com a senha),
   * então nada de host/porta/usuário é digitado nesta tela.
   * Retorna null (com toast de erro) se a validação falhar.
   */
  async _collectCreatePayload() {
    const typeEl = document.getElementById('instance-type');
    const type = typeEl ? typeEl.value : 'vpn';
    const browserEl = document.getElementById('instance-browser');
    // Só os navegadores conhecidos passam; qualquer outro valor cai no Chromium.
    const browser = browserEl && ['brave', 'cloakbrowser'].includes(browserEl.value)
      ? browserEl.value
      : 'chromium';

    if (type === 'proxy') {
      const savedSel = document.getElementById('proxy-saved');
      const proxyId = savedSel ? savedSel.value : '';
      if (!proxyId) {
        this.showToast('Escolha um proxy salvo em "Proxy salvo"', 'error');
        return null;
      }

      let proxy;
      try {
        // Credenciais vêm da biblioteca; a senha nunca passa pelo formulário.
        proxy = await API.get(`/proxies/${proxyId}/full`);
      } catch (err) {
        this.showToast(err.message || 'Erro ao carregar o proxy salvo', 'error');
        return null;
      }

      return {
        type: 'proxy',
        browser,
        proxy: {
          host: proxy.host,
          port: proxy.port,
          scheme: proxy.scheme || 'http',
          auth: !!proxy.auth,
          user: proxy.user || '',
          pass: proxy.pass || ''
        }
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
