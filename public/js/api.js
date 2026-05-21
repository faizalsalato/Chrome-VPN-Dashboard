/**
 * API Client - HTTP wrapper with JWT authentication
 */
const API = {
  baseUrl: '/api',

  getToken() {
    return localStorage.getItem('dashboard_token');
  },

  setToken(token) {
    localStorage.setItem('dashboard_token', token);
  },

  removeToken() {
    localStorage.removeItem('dashboard_token');
  },

  isAuthenticated() {
    return !!this.getToken();
  },

  async request(method, endpoint, body = null) {
    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json'
    };

    const token = this.getToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const options = { method, headers };
    if (body) {
      options.body = JSON.stringify(body);
    }

    try {
      const response = await fetch(url, options);

      // Handle 401 - redirect to login
      if (response.status === 401) {
        this.removeToken();
        if (!window.location.pathname.includes('login')) {
          window.location.href = '/login.html';
        }
        const data = await response.json().catch(() => ({}));
        throw { status: 401, message: data.message || 'Sessão expirada' };
      }

      // Handle other errors
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw {
          status: response.status,
          message: data.message || `Erro ${response.status}`,
          retryAfter: data.retryAfter
        };
      }

      return await response.json();
    } catch (err) {
      if (err.status) throw err;
      // Network error
      throw { status: 0, message: 'Erro de conexão com o servidor' };
    }
  },

  get(endpoint) {
    return this.request('GET', endpoint);
  },

  post(endpoint, body) {
    return this.request('POST', endpoint, body);
  },

  delete(endpoint) {
    return this.request('DELETE', endpoint);
  }
};
