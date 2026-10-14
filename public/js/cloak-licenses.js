/**
 * CloakLicenses - modal da biblioteca de chaves do CloakBrowser.
 *
 * Por que existe: no modo grátis o binário aceita UMA sessão em paralelo; cada
 * chave Pro acrescenta sessões às instâncias que a usam. Aqui as chaves são
 * listadas (mascaradas), adicionadas em lote e removidas.
 */
const CloakLicenses = {
  open() {
    const dialog = document.getElementById('cloak-licenses-dialog');
    if (!dialog) return;
    dialog.classList.remove('hidden');
    this._bindButtons();
    this.refresh();
  },

  close() {
    const dialog = document.getElementById('cloak-licenses-dialog');
    if (dialog) dialog.classList.add('hidden');
  },

  /** Botões clonados: cada abertura começa com listeners limpos. */
  _bindButtons() {
    const closeBtn = document.getElementById('cloak-licenses-close');
    const addBtn = document.getElementById('cloak-licenses-add');
    if (!closeBtn || !addBtn) return;

    const newClose = closeBtn.cloneNode(true);
    closeBtn.parentNode.replaceChild(newClose, closeBtn);
    const newAdd = addBtn.cloneNode(true);
    addBtn.parentNode.replaceChild(newAdd, addBtn);

    newClose.addEventListener('click', () => this.close());
    newAdd.addEventListener('click', () => this.add());
  },

  async refresh() {
    const list = document.getElementById('cloak-licenses-list');
    if (!list) return;
    list.innerHTML = '<p class="form-hint">Carregando…</p>';

    let data;
    try {
      data = await API.get('/cloak-licenses');
    } catch (err) {
      list.innerHTML = `<p class="form-hint">Erro ao carregar: ${err.message || 'falha'}</p>`;
      return;
    }

    const licenses = data.licenses || [];
    if (!licenses.length) {
      list.innerHTML = '<p class="form-hint">Nenhuma chave cadastrada ainda.</p>';
      return;
    }

    list.innerHTML = licenses.map(item => this._rowHtml(item)).join('');
    list.querySelectorAll('.cloak-license-remove').forEach((btn) => {
      btn.addEventListener('click', () => this.remove(btn.dataset.id, btn.dataset.masked));
    });
  },

  /** Uma linha por chave: pontas da chave + uso/plano/sessões + remover. */
  _rowHtml(item) {
    const parts = [item.instances ? `usada por ${item.instances} instância(s)` : 'sem uso'];
    if (item.plan) parts.push(item.plan);
    if (Number.isFinite(item.seatsActive) && Number.isFinite(item.seatsLimit)) {
      parts.push(`${item.seatsActive}/${item.seatsLimit} sessões`);
    }

    return `
      <div class="cloak-license-row" data-id="${item.id}">
        <div class="cloak-license-info">
          <span class="cloak-license-key">${item.masked}</span>
          <span class="type-badge">${parts.join(' · ')}</span>
        </div>
        <button type="button" class="btn btn-danger btn-sm cloak-license-remove"
                data-id="${item.id}" data-masked="${item.masked}">Remover</button>
      </div>`;
  },

  /** Adiciona tudo o que estiver no textarea (uma chave por linha). */
  async add() {
    const input = document.getElementById('cloak-licenses-input');
    const keys = ((input && input.value) || '').trim();
    if (!keys) {
      App.showToast('Cole pelo menos uma chave', 'error');
      return;
    }

    const btn = document.getElementById('cloak-licenses-add');
    btn.classList.add('loading');
    btn.disabled = true;
    try {
      const result = await API.post('/cloak-licenses', { keys });
      App.showToast(result.message || 'Chaves adicionadas', 'success');
      if (input) input.value = '';
      await this.refresh();
    } catch (err) {
      App.showToast(err.message || 'Erro ao salvar as chaves', 'error');
    } finally {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  },

  async remove(id, masked) {
    App.showConfirmDialog(
      'Remover chave',
      `Remover a chave ${masked}? As instâncias que a usam passam a usar outra da biblioteca ` +
      '(sem chaves, voltam ao modo grátis).',
      async () => {
        try {
          await API.delete(`/cloak-licenses/${id}`);
          App.showToast('Chave removida', 'success');
          await this.refresh();
        } catch (err) {
          App.showToast(err.message || 'Erro ao remover a chave', 'error');
        }
      }
    );
  }
};
