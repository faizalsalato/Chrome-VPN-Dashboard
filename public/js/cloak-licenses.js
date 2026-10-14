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
    const checkBtn = document.getElementById('cloak-licenses-check');
    if (!closeBtn || !addBtn) return;

    const newClose = closeBtn.cloneNode(true);
    closeBtn.parentNode.replaceChild(newClose, closeBtn);
    const newAdd = addBtn.cloneNode(true);
    addBtn.parentNode.replaceChild(newAdd, addBtn);

    newClose.addEventListener('click', () => this.close());
    newAdd.addEventListener('click', () => this.add());

    if (checkBtn) {
      const newCheck = checkBtn.cloneNode(true);
      checkBtn.parentNode.replaceChild(newCheck, checkBtn);
      newCheck.addEventListener('click', () => this.check());
    }

    const updateBtn = document.getElementById('cloak-licenses-update');
    if (updateBtn) {
      const newUpdate = updateBtn.cloneNode(true);
      updateBtn.parentNode.replaceChild(newUpdate, updateBtn);
      newUpdate.addEventListener('click', () => this.update());
    }
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

  /** Uma linha por chave: pontas da chave + uso/plano/prazo/sessões + remover. */
  _rowHtml(item) {
    const parts = [item.instances ? `usada por ${item.instances} instância(s)` : 'sem uso'];
    if (item.plan) parts.push(item.plan);
    if (Number.isFinite(item.seatsActive) && Number.isFinite(item.seatsLimit)) {
      parts.push(`${item.seatsActive}/${item.seatsLimit} sessões`);
    }

    // O prazo é o que se olha primeiro numa chave de teste: vai no mesmo selo,
    // pintado quando está perto do fim (ou já passou).
    const expiry = this._expiry(item.expires);
    if (expiry) parts.push(expiry.label);

    const classes = ['type-badge'];
    if (expiry && expiry.urgent) classes.push(expiry.expired ? 'expired' : 'expiry-soon');

    return `
      <div class="cloak-license-row" data-id="${item.id}">
        <div class="cloak-license-info">
          <span class="cloak-license-key">${item.masked}</span>
          <span class="${classes.join(' ')}">${parts.join(' · ')}</span>
        </div>
        <button type="button" class="btn btn-danger btn-sm cloak-license-remove"
                data-id="${item.id}" data-masked="${item.masked}">Remover</button>
      </div>`;
  },

  /**
   * Prazo da chave em texto curto ("expira 17/10/2026 (em 3 dias)").
   * `urgent` marca o que está a 7 dias ou menos; `expired`, o que já passou.
   */
  _expiry(iso) {
    if (!iso) return null;
    const date = new Date(iso);
    if (isNaN(date.getTime())) return { label: `expira ${iso}`, urgent: false, expired: false };

    const day = date.toLocaleDateString('pt-BR');
    const days = Math.ceil((date.getTime() - Date.now()) / 86400000);
    if (days < 0) return { label: `expirada em ${day}`, urgent: true, expired: true };
    if (days === 0) return { label: 'expira hoje', urgent: true, expired: false };
    return {
      label: `expira ${day} (em ${days} dia${days === 1 ? '' : 's'})`,
      urgent: days <= 7,
      expired: false
    };
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

  /**
   * Pergunta ao vendor o estado das chaves: plano, prazo e lugares em uso.
   * É a única forma de saber se a chave ainda vale (e até quando) antes de
   * alguma instância Pro falhar.
   */
  async check() {
    const btn = document.getElementById('cloak-licenses-check');
    if (btn) {
      btn.classList.add('loading');
      btn.disabled = true;
    }
    try {
      const result = await API.post('/cloak-licenses/check', {});
      App.showToast(result.message || 'Chaves verificadas', 'success');
      await this.refresh();
    } catch (err) {
      App.showToast(err.message || 'Erro ao verificar as chaves', 'error');
    } finally {
      if (btn) {
        btn.classList.remove('loading');
        btn.disabled = false;
      }
    }
  },

  /**
   * Manda atualizar o binário Pro para a versão mais recente do vendor.
   *
   * Sem versão nova o servidor responde "já está na mais recente" (nada é
   * recriado); com versão nova, o download corre num container à parte e as
   * instâncias Pro que estão a correr são recriadas com o binário novo — o
   * perfil, os cookies e os logins ficam.
   */
  async update() {
    const btn = document.getElementById('cloak-licenses-update');
    if (btn) {
      btn.classList.add('loading');
      btn.disabled = true;
    }
    try {
      const result = await API.post('/cloak-licenses/update', {});
      App.showToast(result.message || 'Binário verificado', 'success');
      await this.refresh();
    } catch (err) {
      App.showToast(err.message || 'Erro ao atualizar o binário', 'error');
    } finally {
      if (btn) {
        btn.classList.remove('loading');
        btn.disabled = false;
      }
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
