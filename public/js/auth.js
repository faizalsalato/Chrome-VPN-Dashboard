/**
 * Authentication - Login/Logout/Session management
 */
const Auth = {
  init() {
    // Check if on login page
    const loginForm = document.getElementById('login-form');
    if (loginForm) {
      this.initLoginPage();
      return;
    }

    // Check if on dashboard - verify auth
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', () => this.logout());
      this.updateUserInfo();
    }
  },

  initLoginPage() {
    // If already authenticated, redirect to dashboard
    if (API.isAuthenticated()) {
      this.verifyAndRedirect();
      return;
    }

    const form = document.getElementById('login-form');
    form.addEventListener('submit', (e) => this.handleLogin(e));
  },

  async verifyAndRedirect() {
    try {
      await API.get('/auth/verify');
      window.location.href = '/';
    } catch (err) {
      API.removeToken();
    }
  },

  async handleLogin(e) {
    e.preventDefault();

    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    const errorEl = document.getElementById('error-message');
    const btn = document.getElementById('login-btn');

    // Clear previous error
    errorEl.textContent = '';

    // Validate
    if (!username || !password) {
      errorEl.textContent = 'Preencha todos os campos';
      return;
    }

    // Show loading
    btn.classList.add('loading');
    btn.disabled = true;

    try {
      const data = await API.post('/auth/login', { username, password });
      API.setToken(data.token);
      window.location.href = '/';
    } catch (err) {
      if (err.status === 429) {
        const minutes = Math.ceil((err.retryAfter || 300) / 60);
        errorEl.textContent = `Muitas tentativas. Aguarde ${minutes} minuto(s).`;
      } else if (err.status === 401) {
        errorEl.textContent = 'Credenciais inválidas';
      } else {
        errorEl.textContent = err.message || 'Erro ao autenticar';
      }
    } finally {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  },

  async checkAuth() {
    if (!API.isAuthenticated()) {
      window.location.href = '/login.html';
      return false;
    }

    try {
      await API.get('/auth/verify');
      return true;
    } catch (err) {
      window.location.href = '/login.html';
      return false;
    }
  },

  async logout() {
    try {
      await API.post('/auth/logout');
    } catch (err) {
      // Ignore errors on logout
    }
    API.removeToken();
    window.location.href = '/login.html';
  },

  updateUserInfo() {
    const userInfo = document.getElementById('user-info');
    if (userInfo) {
      const token = API.getToken();
      if (token) {
        try {
          const payload = JSON.parse(atob(token.split('.')[1]));
          userInfo.textContent = `👤 ${payload.username}`;
        } catch (err) {
          userInfo.textContent = '';
        }
      }
    }
  }
};

// Auto-initialize on page load
document.addEventListener('DOMContentLoaded', () => Auth.init());
