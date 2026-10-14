/**
 * ProxiesLib - página "Proxies" (biblioteca de proxies reutilizáveis).
 *
 * A página mostra apenas os proxies adicionados e três ações:
 *   • Adicionar proxy  -> modal (um por um ou colando uma lista)
 *   • Testar           -> no próprio cartão do proxy
 *   • Testar todos     -> em sequência, respeitando o rate-limit do serviço de geo
 *
 * API pública usada pelo resto do app:
 *   open(), close(), activate(), fillCreateSelect(), applySavedPick(id)
 */
const ProxiesLib = {
  _results: {},        // id -> resultado do último teste ('loading' enquanto roda)
  _testingAll: false,
  _activeTab: 'manual',
  _statusTimer: null,
  _cache: [],          // última lista de proxies carregada (usada pelo seletor)

  open() {
    if (typeof App !== 'undefined' && App.switchView) return App.switchView('proxies');
    const view = document.getElementById('view-proxies');
    if (view) view.classList.remove('hidden');
    this.activate();
    return undefined;
  },

  close() {
    if (typeof App !== 'undefined' && App.switchView) return App.switchView('instances');
    const view = document.getElementById('view-proxies');
    if (view) view.classList.add('hidden');
    return undefined;
  },

  /** Chamado ao entrar na view: liga os eventos (uma vez) e carrega a lista. */
  activate() {
    this._bind();
    this.refresh();
  },

  /* ============================================================
     Eventos
     ============================================================ */

  _bind() {
    const on = (id, type, handler) => {
      const el = document.getElementById(id);
      if (!el) return;
      const flag = `bound${type}`;
      if (el.dataset[flag]) return;
      el.dataset[flag] = '1';
      el.addEventListener(type, handler);
    };

    on('proxies-add', 'click', () => this.openDialog());
    on('proxies-empty-add', 'click', () => this.openDialog());
    on('proxies-test-all', 'click', () => this.testAll());

    on('proxy-dialog-cancel', 'click', () => this.closeDialog());
    on('proxy-dialog-save', 'click', () => this.submitDialog());
    on('proxy-tab-btn-manual', 'click', () => this.setTab('manual'));
    on('proxy-tab-btn-list', 'click', () => this.setTab('list'));
    on('proxy-lib-auth', 'change', (e) => {
      const creds = document.getElementById('proxy-lib-credentials');
      if (creds) creds.classList.toggle('hidden', !e.target.checked);
    });

    const overlay = document.getElementById('proxy-dialog');
    if (overlay && !overlay.dataset.boundOverlay) {
      overlay.dataset.boundOverlay = '1';
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) this.closeDialog();
      });
    }

    // Delegação: os cartões são recriados a cada refresh.
    const list = document.getElementById('proxies-list');
    if (list && !list.dataset.boundClick) {
      list.dataset.boundClick = '1';
      list.addEventListener('click', (e) => {
        const testBtn = e.target.closest('[data-proxy-test]');
        if (testBtn) {
          this.test(Number(testBtn.dataset.proxyTest));
          return;
        }
        const removeBtn = e.target.closest('[data-proxy-remove]');
        if (removeBtn) this.confirmRemove(Number(removeBtn.dataset.proxyRemove));
      });
    }

    if (!this._escBound) {
      this._escBound = true;
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this._isDialogOpen()) this.closeDialog();
      });
    }
  },

  /* ============================================================
     Lista
     ============================================================ */

  async refresh() {
    const list = document.getElementById('proxies-list');
    const empty = document.getElementById('proxies-empty');
    if (!list) return;

    let proxies = [];
    try {
      const data = await API.get('/proxies');
      proxies = data.proxies || [];
    } catch (err) {
      App.showToast(err.message || 'Erro ao carregar proxies', 'error');
    }
    this._cache = proxies;

    list.textContent = '';

    if (!proxies.length) {
      list.classList.add('hidden');
      if (empty) empty.classList.remove('hidden');
      return;
    }

    if (empty) empty.classList.add('hidden');
    list.classList.remove('hidden');
    proxies.forEach((proxy) => list.append(ProxyCard.el(proxy, this._results[proxy.id])));
  },

  /* ============================================================
     Testes
     ============================================================ */

  /** Testa um proxy salvo e pinta o resultado no cartão. */
  async test(id) {
    if (this._results[id] === 'loading') return null;

    this._results[id] = 'loading';
    this._paintResult(id);
    this._setCardTesting(id, true);

    let result;
    try {
      result = await API.post(`/proxies/${id}/test`);
    } catch (err) {
      result = { live: false, error: err.message || 'Falha no teste' };
    }

    this._results[id] = result;
    this._paintResult(id);
    this._setCardTesting(id, false);
    return result;
  },

  /** Testa todos os proxies, um por vez (o serviço de geo limita requisições). */
  async testAll() {
    if (this._testingAll) return;

    const data = await API.get('/proxies').catch(() => null);
    const ids = ((data && data.proxies) || []).map((p) => p.id);

    if (!ids.length) {
      App.showToast('Adicione um proxy antes de testar', 'info');
      return;
    }

    this._testingAll = true;
    const btn = document.getElementById('proxies-test-all');
    this._setBusy(btn, true);

    let live = 0;
    for (let i = 0; i < ids.length; i++) {
      this._setStatus(`Testando ${i + 1} de ${ids.length}…`);
      const result = await this.test(ids[i]);
      if (result && result.live) live++;
    }

    this._setStatus(`${live} de ${ids.length} proxy(s) respondendo`, true);
    this._testingAll = false;
    this._setBusy(btn, false);
  },

  _paintResult(id) {
    const box = document.querySelector(`[data-proxy-card="${id}"] .proxy-card-result`);
    if (!box) return;
    box.textContent = '';
    box.append(ProxyCard.resultEl(this._results[id]));
  },

  _setCardTesting(id, on) {
    const btn = document.querySelector(`[data-proxy-test="${id}"]`);
    this._setBusy(btn, on);
  },

  _setStatus(text, autoHide) {
    const el = document.getElementById('proxies-status');
    if (!el) return;

    if (!text) {
      el.textContent = '';
      el.classList.add('hidden');
      return;
    }

    el.textContent = text;
    el.classList.remove('hidden');
    if (this._statusTimer) clearTimeout(this._statusTimer);
    if (autoHide) this._statusTimer = setTimeout(() => this._setStatus(''), 6000);
  },

  _setBusy(btn, on) {
    if (!btn) return;
    btn.classList.toggle('loading', on);
    btn.disabled = !!on;
  },

  /* ============================================================
     Remoção
     ============================================================ */

  confirmRemove(id) {
    const card = document.querySelector(`[data-proxy-card="${id}"]`);
    const nameEl = card && card.querySelector('.proxy-card-name');
    const name = (nameEl && nameEl.textContent) || 'este proxy';

    App.showConfirmDialog('Remover proxy', `Remover "${name}" da biblioteca?`, () => this.remove(id));
  },

  async remove(id) {
    try {
      await API.delete(`/proxies/${id}`);
      delete this._results[id];
      App.showToast('Proxy removido', 'success');
      await this.refresh();
      this.fillCreateSelect();
    } catch (err) {
      App.showToast(err.message || 'Erro ao remover proxy', 'error');
    }
  },

  /* ============================================================
     Modal de adicionar
     ============================================================ */

  openDialog() {
    this.resetForm();
    this.setTab('manual');
    const overlay = document.getElementById('proxy-dialog');
    if (overlay) overlay.classList.remove('hidden');
    const host = document.getElementById('proxy-lib-host');
    if (host) host.focus();
  },

  closeDialog() {
    const overlay = document.getElementById('proxy-dialog');
    if (overlay) overlay.classList.add('hidden');
    this.resetForm();
  },

  _isDialogOpen() {
    const overlay = document.getElementById('proxy-dialog');
    return !!overlay && !overlay.classList.contains('hidden');
  },

  setTab(name) {
    const isList = name === 'list';
    this._activeTab = isList ? 'list' : 'manual';

    const manual = document.getElementById('proxy-tab-manual');
    const listPanel = document.getElementById('proxy-tab-list');
    const manualBtn = document.getElementById('proxy-tab-btn-manual');
    const listBtn = document.getElementById('proxy-tab-btn-list');

    if (manual) manual.classList.toggle('hidden', isList);
    if (listPanel) listPanel.classList.toggle('hidden', !isList);

    if (manualBtn) {
      manualBtn.classList.toggle('active', !isList);
      manualBtn.setAttribute('aria-selected', String(!isList));
    }
    if (listBtn) {
      listBtn.classList.toggle('active', isList);
      listBtn.setAttribute('aria-selected', String(isList));
    }

    const save = document.getElementById('proxy-dialog-save');
    const label = save && save.querySelector('.btn-text');
    if (label) label.textContent = isList ? 'Importar' : 'Adicionar';

    this._setDialogError('');
    const feedback = document.getElementById('proxy-bulk-result');
    if (feedback) {
      feedback.textContent = '';
      feedback.classList.add('hidden');
    }
  },

  resetForm() {
    ['proxy-name', 'proxy-lib-host', 'proxy-lib-port', 'proxy-lib-user',
      'proxy-lib-pass', 'proxy-bulk-list'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });

    const scheme = document.getElementById('proxy-lib-scheme');
    if (scheme) scheme.value = 'http';

    const auth = document.getElementById('proxy-lib-auth');
    if (auth) auth.checked = false;

    const creds = document.getElementById('proxy-lib-credentials');
    if (creds) creds.classList.add('hidden');

    this._setDialogError('');
  },

  submitDialog() {
    return this._activeTab === 'list' ? this.importList() : this.saveManual();
  },

  async saveManual() {
    const name = this._value('proxy-name');
    const host = this._value('proxy-lib-host');
    const portRaw = this._value('proxy-lib-port');
    const scheme = this._value('proxy-lib-scheme');
    const auth = !!(document.getElementById('proxy-lib-auth') || {}).checked;
    const username = this._value('proxy-lib-user');
    const password = this._value('proxy-lib-pass', false);

    if (!name) return this._setDialogError('Informe um nome para o proxy.');
    if (!host) return this._setDialogError('Informe o host do proxy.');

    const port = parseInt(portRaw, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      return this._setDialogError('Porta inválida (use um número de 1 a 65535).');
    }
    if (auth && (!username || !password)) {
      return this._setDialogError('Proxy autenticado requer usuário e senha.');
    }

    const btn = document.getElementById('proxy-dialog-save');
    this._setBusy(btn, true);
    try {
      await API.post('/proxies', { name, host, port, scheme, auth, username, password });
      App.showToast('Proxy adicionado', 'success');
      this.closeDialog();
      await this.refresh();
      this.fillCreateSelect();
    } catch (err) {
      this._setDialogError(err.message || 'Erro ao salvar proxy');
    } finally {
      this._setBusy(btn, false);
    }
    return undefined;
  },

  async importList() {
    const listEl = document.getElementById('proxy-bulk-list');
    const list = ((listEl && listEl.value) || '').trim();
    if (!list) return this._setDialogError('Cole a lista de proxies.');

    const btn = document.getElementById('proxy-dialog-save');
    const feedback = document.getElementById('proxy-bulk-result');

    this._setDialogError('');
    this._setBusy(btn, true);
    if (feedback) {
      feedback.textContent = 'Importando…';
      feedback.classList.remove('hidden');
    }

    try {
      const r = await API.post('/proxies/bulk', { list });
      const total = r.total != null ? r.total : (r.imported + r.skipped);

      if (feedback) {
        feedback.textContent = '';
        feedback.append(ProxyCard.bulkFeedbackEl(r.imported, r.skipped, total));
      }

      await this.refresh();
      this.fillCreateSelect();

      if (r.imported > 0) {
        App.showToast(`Importados ${r.imported} de ${total}`, 'success');
        setTimeout(() => {
          if (this._isDialogOpen()) this.closeDialog();
        }, 1200);
      }
    } catch (err) {
      if (feedback) {
        feedback.textContent = '';
        feedback.classList.add('hidden');
      }
      this._setDialogError(err.message || 'Erro ao importar lista');
    } finally {
      this._setBusy(btn, false);
    }
    return undefined;
  },

  _setDialogError(message) {
    const el = document.getElementById('proxy-dialog-error');
    if (el) el.textContent = message || '';
    return undefined;
  },

  _value(id, trim) {
    const el = document.getElementById(id);
    if (!el) return '';
    const raw = el.value == null ? '' : String(el.value);
    return trim === false ? raw : raw.trim();
  },

  /* ============================================================
     Integração com o diálogo de criação de instância
     ============================================================ */

  /**
   * Popula o <select id="proxy-saved"> do diálogo de criação.
   * Cada opção é rotulada pelo PAÍS do proxy (a partir do último teste) e
   * nunca pelo endereço — host, porta e usuário não aparecem nesta tela.
   */
  async fillCreateSelect() {
    const select = document.getElementById('proxy-saved');
    if (!select) return;

    let proxies = [];
    try {
      const data = await API.get('/proxies');
      proxies = data.proxies || [];
      this._cache = proxies;
    } catch (err) {
      // silencioso: a tela de criação segue sem lista
    }

    select.textContent = '';

    if (!proxies.length) {
      const none = document.createElement('option');
      none.value = '';
      none.textContent = 'Nenhum proxy cadastrado — adicione no menu Proxies';
      select.append(none);
      return;
    }

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Selecione um proxy da biblioteca…';
    select.append(placeholder);

    proxies.forEach((proxy) => {
      const option = document.createElement('option');
      option.value = String(proxy.id);
      option.textContent = ProxyLabel.forPick(proxy);
      select.append(option);
    });
  },

  /**
   * Mostra o resumo do proxy escolhido na criação (país, cidade, fuso e IP do
   * último teste). O endereço não é exibido: quem escolhe vê onde o proxy sai.
   */
  async applySavedPick(id) {
    if (!id) {
      App._showPickedProxy(null);
      return;
    }

    let proxy = (this._cache || []).find((p) => String(p.id) === String(id));
    if (!proxy) {
      try {
        const data = await API.get('/proxies');
        this._cache = data.proxies || [];
        proxy = this._cache.find((p) => String(p.id) === String(id));
      } catch (err) {
        proxy = null;
      }
    }

    App._showPickedProxy(proxy || null);
  }
};
