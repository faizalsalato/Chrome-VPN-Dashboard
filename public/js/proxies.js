/**
 * ProxiesLib - Modal "🔌 Proxies" (biblioteca de proxies reutilizáveis).
 * CRUD via /api/proxies. A senha é mascarada e nunca retornada na listagem.
 *
 * Também expõe ProxiesLib.fillCreateSelect() para popular o <select id="proxy-saved">
 * do diálogo de criação de instância.
 */
const ProxiesLib = {
  _editingId: null,

  open() {
    const dialog = document.getElementById('proxies-dialog');
    dialog.classList.remove('hidden');
    this._resetForm();
    this._bindButtons();
    this.refresh();
  },

  close() {
    document.getElementById('proxies-dialog').classList.add('hidden');
    this._resetForm();
  },

  _bindButtons() {
    const close = document.getElementById('proxies-cancel');
    const save = document.getElementById('proxies-save');
    const del = document.getElementById('proxies-delete');
    const cancelEdit = document.getElementById('proxies-cancel-edit');
    const authCb = document.getElementById('proxy-lib-auth');
    const test = document.getElementById('proxies-test');

    // Clone para remover listeners antigos (mesmo padrão dos outros dialogs)
    const newClose = close.cloneNode(true); close.parentNode.replaceChild(newClose, close);
    const newSave = save.cloneNode(true); save.parentNode.replaceChild(newSave, save);
    const newDel = del.cloneNode(true); del.parentNode.replaceChild(newDel, del);
    const newCancelEdit = cancelEdit.cloneNode(true); cancelEdit.parentNode.replaceChild(newCancelEdit, cancelEdit);
    const newAuth = authCb.cloneNode(true); authCb.parentNode.replaceChild(newAuth, authCb);
    const newTest = test.cloneNode(true); test.parentNode.replaceChild(newTest, test);

    newClose.addEventListener('click', () => this.close());
    newSave.addEventListener('click', () => this.save());
    newDel.addEventListener('click', () => this.remove());
    newCancelEdit.addEventListener('click', () => this._resetForm());
    newAuth.addEventListener('change', () => {
      document.getElementById('proxy-lib-credentials')
        .classList.toggle('hidden', !newAuth.checked);
    });
    newTest.addEventListener('click', () => this._testForm());
  },

  _resetForm() {
    this._editingId = null;
    ['proxy-name', 'proxy-lib-host', 'proxy-lib-port', 'proxy-lib-user', 'proxy-lib-pass'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    const scheme = document.getElementById('proxy-lib-scheme');
    if (scheme) scheme.value = 'http';
    const authCb = document.getElementById('proxy-lib-auth');
    if (authCb) authCb.checked = false;
    const creds = document.getElementById('proxy-lib-credentials');
    if (creds) creds.classList.add('hidden');

    // Botões: estado "adicionar"
    document.getElementById('proxies-delete').classList.add('hidden');
    document.getElementById('proxies-cancel-edit').classList.add('hidden');
    const title = document.getElementById('proxies-form-title');
    if (title) title.textContent = 'Adicionar proxy';
  },

  async refresh() {
    try {
      const data = await API.get('/proxies');
      const list = document.getElementById('proxies-list');
      if (!data.proxies.length) {
        list.innerHTML = '<p class="form-hint">Nenhum proxy salvo ainda.</p>';
        return;
      }
      list.innerHTML = data.proxies.map(p => this._proxyRow(p)).join('');
      // Liga clique para editar cada item
      list.querySelectorAll('[data-proxy-id]').forEach(row => {
        row.addEventListener('click', () => this._edit(parseInt(row.dataset.proxyId, 10)));
      });
      // Botão "Testar" de cada proxy salvo (não deve abrir o editor)
      list.querySelectorAll('.proxy-test-row').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._testSaved(parseInt(btn.dataset.proxyId, 10), btn);
        });
      });
    } catch (err) {
      document.getElementById('proxies-list').innerHTML =
        `<p class="form-hint">Erro ao carregar: ${err.message || 'falha'}</p>`;
    }
  },

  _proxyRow(p) {
    const auth = p.auth
      ? '<span class="type-badge surfshark">🔒 autenticado</span>'
      : '<span class="type-badge">aberto</span>';
    return `
      <div class="vpn-creds-provider" data-proxy-id="${p.id}" style="cursor: pointer;" title="Clique para editar">
        <div class="info-row">
          <span class="info-label">${this._esc(p.name)}</span>
          ${auth}
        </div>
        <div class="info-row">
          <span class="info-label">Endereço</span>
          <span class="info-value">${this._esc(p.host)}:${p.port} (${p.scheme})</span>
        </div>
        ${p.auth ? `<div class="info-row">
          <span class="info-label">Usuário</span>
          <span class="info-value">${this._esc(p.username || '')}</span>
        </div>` : ''}
        <div class="proxy-row-actions">
          <button class="btn btn-secondary btn-sm proxy-test-row" data-proxy-id="${p.id}">
            <span class="btn-text">🧪 Testar</span>
            <span class="btn-loading"><span class="spinner"></span></span>
          </button>
        </div>
      </div>`;
  },

  async _edit(id) {
    try {
      const p = await API.get(`/proxies/${id}/full`);
      this._editingId = id;
      document.getElementById('proxy-name').value = p.name;
      document.getElementById('proxy-lib-host').value = p.host;
      document.getElementById('proxy-lib-port').value = p.port;
      document.getElementById('proxy-lib-scheme').value = p.scheme || 'http';
      const authCb = document.getElementById('proxy-lib-auth');
      authCb.checked = !!p.auth;
      document.getElementById('proxy-lib-credentials').classList.toggle('hidden', !p.auth);
      document.getElementById('proxy-lib-user').value = p.user || '';
      document.getElementById('proxy-lib-pass').value = ''; // nunca preenche senha
      document.getElementById('proxies-delete').classList.remove('hidden');
      document.getElementById('proxies-cancel-edit').classList.remove('hidden');
      const title = document.getElementById('proxies-form-title');
      if (title) title.textContent = `Editando: ${p.name}`;
    } catch (err) {
      App.showToast(err.message || 'Erro ao carregar proxy', 'error');
    }
  },

  async save() {
    const name = (document.getElementById('proxy-name').value || '').trim();
    const host = (document.getElementById('proxy-lib-host').value || '').trim();
    const port = (document.getElementById('proxy-lib-port').value || '').trim();
    const scheme = document.getElementById('proxy-lib-scheme').value;
    const auth = document.getElementById('proxy-lib-auth').checked;
    const user = (document.getElementById('proxy-lib-user').value || '').trim();
    const pass = document.getElementById('proxy-lib-pass').value || '';

    const body = { name, host, port: parseInt(port, 10), scheme, auth, username: user, password: pass };
    try {
      if (this._editingId) {
        await API.put(`/proxies/${this._editingId}`, body);
        App.showToast('Proxy atualizado com sucesso', 'success');
      } else {
        await API.post('/proxies', body);
        App.showToast('Proxy salvo com sucesso', 'success');
      }
      this._resetForm();
      await this.refresh();
    } catch (err) {
      App.showToast(err.message || 'Erro ao salvar proxy', 'error');
    }
  },

  async remove() {
    if (!this._editingId) return;
    try {
      await API.delete(`/proxies/${this._editingId}`);
      App.showToast('Proxy removido', 'success');
      this._resetForm();
      await this.refresh();
    } catch (err) {
      App.showToast(err.message || 'Erro ao remover proxy', 'error');
    }
  },

  /**
   * Popula o <select id="proxy-saved"> do diálogo de criação.
   * Chamado sempre que o diálogo de criação é aberto no modo proxy.
   */
  async fillCreateSelect() {
    const sel = document.getElementById('proxy-saved');
    if (!sel) return;
    try {
      const data = await API.get('/proxies');
      sel.innerHTML = '<option value="">— Informar manualmente —</option>' +
        data.proxies.map(p =>
          `<option value="${p.id}">${this._esc(p.name)} (${this._esc(p.host)}:${p.port})</option>`
        ).join('');
    } catch (err) {
      // silencioso: mantém a opção manual
    }
  },

  /**
   * Ao escolher um proxy salvo no diálogo de criação, busca os dados completos
   * (com senha) e preenche os campos host/port/scheme/auth/user/pass.
   */
  async applySavedToCreate(id) {
    if (!id) return;
    try {
      const p = await API.get(`/proxies/${id}/full`);
      document.getElementById('proxy-host').value = p.host;
      document.getElementById('proxy-port').value = p.port;
      document.getElementById('proxy-scheme').value = p.scheme || 'http';
      const authCb = document.getElementById('proxy-auth');
      authCb.checked = !!p.auth;
      document.getElementById('proxy-credentials').classList.toggle('hidden', !p.auth);
      document.getElementById('proxy-user').value = p.user || '';
      document.getElementById('proxy-pass').value = p.pass || '';
    } catch (err) {
      App.showToast(err.message || 'Erro ao carregar proxy', 'error');
    }
  },

  /**
   * Testa o proxy informado no formulário (antes de salvar).
   * Usa o endpoint POST /proxies/test com os dados do formulário.
   */
  async _testForm() {
    const host = (document.getElementById('proxy-lib-host').value || '').trim();
    const port = (document.getElementById('proxy-lib-port').value || '').trim();
    const scheme = document.getElementById('proxy-lib-scheme').value;
    const auth = document.getElementById('proxy-lib-auth').checked;
    const user = (document.getElementById('proxy-lib-user').value || '').trim();
    const pass = document.getElementById('proxy-lib-pass').value || '';

    if (!host || !port) {
      App.showToast('Informe host e porta para testar', 'error');
      return;
    }
    // Se está editando e a senha ficou em branco, precisamos da senha real:
    // nesse caso usamos o endpoint por ID (que busca a senha no banco).
    if (this._editingId && auth && !pass) {
      return this._testSaved(this._editingId, document.getElementById('proxies-test'));
    }

    const btn = document.getElementById('proxies-test');
    this._setTesting(btn, true);
    this._showResultLoading();
    try {
      const body = { host, port: parseInt(port, 10), scheme, auth };
      if (auth) { body.username = user; body.password = pass; }
      const result = await API.post('/proxies/test', body);
      this._renderResult(result, `${host}:${port}`);
    } catch (err) {
      this._renderResult({ live: false, error: err.message || 'Falha no teste' }, `${host}:${port}`);
    } finally {
      this._setTesting(btn, false);
    }
  },

  /**
   * Testa um proxy já salvo (busca credenciais no banco) via POST /proxies/:id/test.
   */
  async _testSaved(id, btn) {
    this._setTesting(btn, true);
    this._showResultLoading();
    try {
      const result = await API.post(`/proxies/${id}/test`);
      const p = await API.get(`/proxies/${id}/full`).catch(() => null);
      const label = p ? `${p.host}:${p.port}` : `#${id}`;
      this._renderResult(result, label);
    } catch (err) {
      this._renderResult({ live: false, error: err.message || 'Falha no teste' }, `#${id}`);
    } finally {
      this._setTesting(btn, false);
    }
  },

  _setTesting(btn, on) {
    if (!btn) return;
    btn.classList.toggle('loading', on);
    btn.disabled = on;
  },

  _showResultLoading() {
    const el = document.getElementById('proxy-test-result');
    el.classList.remove('hidden');
    el.innerHTML = '<p class="form-hint">🔄 Testando proxy…</p>';
  },

  _flag(code) {
    return code ? `<span class="proxy-flag">${String(code).toLowerCase()}</span>` : '';
  },

  _renderResult(r, label) {
    const el = document.getElementById('proxy-test-result');
    el.classList.remove('hidden');
    if (r.live) {
      el.innerHTML = `
        <div class="proxy-test-card live">
          <div class="proxy-test-head">
            <span class="proxy-test-status ok">● LIVE</span>
            <span class="proxy-test-label">${this._esc(label)}</span>
            <span class="proxy-test-latency">${r.latencyMs} ms</span>
          </div>
          <div class="proxy-test-grid">
            <div class="info-row"><span class="info-label">IP</span><span class="info-value">${this._esc(r.ip || 'N/A')}</span></div>
            <div class="info-row"><span class="info-label">País</span><span class="info-value">${this._flag(r.countryCode)} ${this._esc(r.country || 'N/A')}</span></div>
            <div class="info-row"><span class="info-label">Região</span><span class="info-value">${this._esc(r.region || 'N/A')}</span></div>
            <div class="info-row"><span class="info-label">Cidade</span><span class="info-value">${this._esc(r.city || 'N/A')}</span></div>
            <div class="info-row"><span class="info-label">CEP</span><span class="info-value">${this._esc(r.zip || 'N/A')}</span></div>
            <div class="info-row"><span class="info-label">Coordenadas</span><span class="info-value">${r.lat != null ? r.lat : '—'}, ${r.lon != null ? r.lon : '—'}</span></div>
            <div class="info-row"><span class="info-label">Fuso</span><span class="info-value">${this._esc(r.timezone || 'N/A')}</span></div>
            <div class="info-row"><span class="info-label">ISP</span><span class="info-value">${this._esc(r.isp || 'N/A')}</span></div>
            <div class="info-row"><span class="info-label">Org</span><span class="info-value">${this._esc(r.org || 'N/A')}</span></div>
            <div class="info-row"><span class="info-label">AS</span><span class="info-value">${this._esc(r.as || 'N/A')}</span></div>
          </div>
        </div>`;
    } else {
      el.innerHTML = `
        <div class="proxy-test-card dead">
          <div class="proxy-test-head">
            <span class="proxy-test-status bad">● MORTO</span>
            <span class="proxy-test-label">${this._esc(label)}</span>
            ${r.latencyMs ? `<span class="proxy-test-latency">${r.latencyMs} ms</span>` : ''}
          </div>
          <p class="proxy-test-error">${this._esc(r.error || 'Proxy indisponível')}${r.code ? ` (${this._esc(r.code)})` : ''}</p>
        </div>`;
    }
  },

  _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
};
