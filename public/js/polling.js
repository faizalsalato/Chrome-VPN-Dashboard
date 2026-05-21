/**
 * Polling - Periodic data refresh
 */
const Polling = {
  interval: null,
  POLL_INTERVAL: 5000, // 5 seconds
  isPolling: false,

  start() {
    if (this.interval) return;
    this.fetchNow();
    this.interval = setInterval(() => this.fetch(), this.POLL_INTERVAL);
  },

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  },

  async fetch() {
    if (this.isPolling) return;
    this.isPolling = true;

    try {
      const data = await API.get('/instances');
      Instances.renderAll(data);
    } catch (err) {
      if (err.status === 401) {
        this.stop();
        return;
      }
      // Network error - show connection issue
      if (err.status === 0) {
        const banner = document.getElementById('connection-banner');
        if (banner) {
          banner.classList.remove('hidden');
          banner.querySelector('.banner-text').textContent = 'Erro de conexão com o servidor';
        }
      }
    } finally {
      this.isPolling = false;
    }
  },

  async fetchNow() {
    await this.fetch();
  }
};
