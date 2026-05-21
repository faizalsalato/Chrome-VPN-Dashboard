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

    const cancelBtn = document.getElementById('create-cancel');
    const confirmBtn = document.getElementById('create-confirm');

    // Remove old listeners
    const newCancel = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);
    const newConfirm = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirm, confirmBtn);

    newCancel.addEventListener('click', () => dialog.classList.add('hidden'));
    newConfirm.addEventListener('click', async () => {
      const country = document.getElementById('country-select').value;
      newConfirm.classList.add('loading');
      newConfirm.disabled = true;

      try {
        await API.post('/instances', { country });
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
