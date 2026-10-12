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

    // Clone para remover listeners antigos (mesmo padrão dos outros dialogs)
    const newClose = close.cloneNode(true); close.parentNode.replaceChild(newClose, close);
    const newSave = save.cloneNode(true); save.parentNode.replaceChild(newSave, save);
    const newDel = del.cloneNode(true); del.parentNode.replaceChild(newDel, del);
    const newCancelEdit = cancelEdit.cloneNode(true); cancelEdit.parentNode.replaceChild(newCancelEdit, cancelEdit);
    const newAuth = authCb.cloneNode(true); authCb.parentNode.replaceChild(newAuth, authCb);

    newClose.addEventListener('click', () => this.close());
    newSave.addEventListener('click', () => this.save());
    newDel.addEventListener('click', () => this.remove());
    newCancelEdit.addEventListener('click', () => this._resetForm());
    newAuth.addEventListener('change', () => {
      document.getElementById('proxy-lib-credentials')
        .classList.toggle('hidden', !newAuth.checked);
    });
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

  _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
};
