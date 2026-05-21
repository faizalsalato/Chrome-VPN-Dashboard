const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const NGINX_SITES_PATH = '/etc/nginx/sites-available';
const NGINX_ENABLED_PATH = '/etc/nginx/sites-enabled';
const DOMAIN = process.env.DOMAIN || 'sakr.ath.cx';
const CERTBOT_EMAIL = process.env.CERTBOT_EMAIL || `admin@${DOMAIN}`;

class NginxService {
  generateServerBlock(instance) {
    const { id, port } = instance;
    const subdomain = `chrome${id}.${DOMAIN}`;

    return `# Chrome ${id} - Auto-generated
server {
    listen 80;
    server_name ${subdomain};

    location / {
        proxy_pass         http://localhost:${port};
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host       $host;
        proxy_set_header   X-Real-IP  $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout  3600s;
        proxy_send_timeout  3600s;
    }
}
`;
  }

  async addServerBlock(instance) {
    const configContent = this.generateServerBlock(instance);
    const subdomain = `chrome${instance.id}.${DOMAIN}`;
    const filePath = path.join(NGINX_SITES_PATH, `chrome${instance.id}`);
    const enabledPath = path.join(NGINX_ENABLED_PATH, `chrome${instance.id}`);

    // Write config
    fs.writeFileSync(filePath, configContent, 'utf-8');

    // Enable site
    try {
      if (fs.existsSync(enabledPath)) fs.unlinkSync(enabledPath);
      fs.symlinkSync(filePath, enabledPath);
    } catch (err) {
      console.warn(`[WARN] [nginx] Symlink:`, err.message);
    }

    // Test and reload nginx
    this._testConfig();
    this._reload();

    console.log(`[${new Date().toISOString()}] [INFO] [nginx] Server block criado para ${subdomain}`);

    // Generate SSL certificate with certbot
    try {
      console.log(`[${new Date().toISOString()}] [INFO] [nginx] Gerando certificado SSL para ${subdomain}...`);
      execSync(
        `certbot --nginx -d ${subdomain} --non-interactive --agree-tos -m ${CERTBOT_EMAIL} --redirect`,
        { timeout: 60000, stdio: 'pipe' }
      );
      console.log(`[${new Date().toISOString()}] [INFO] [nginx] SSL ativo para ${subdomain}`);
    } catch (err) {
      console.warn(`[WARN] [nginx] Certbot falhou para ${subdomain}: ${err.stderr ? err.stderr.toString() : err.message}`);
      // Não faz rollback - o site funciona em HTTP mesmo sem SSL
    }
  }

  async removeServerBlock(id) {
    const subdomain = `chrome${id}.${DOMAIN}`;
    const filePath = path.join(NGINX_SITES_PATH, `chrome${id}`);
    const enabledPath = path.join(NGINX_ENABLED_PATH, `chrome${id}`);

    // Remove symlink
    if (fs.existsSync(enabledPath)) {
      fs.unlinkSync(enabledPath);
    }

    // Remove config file
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Reload nginx
    try {
      this._testConfig();
      this._reload();
    } catch (err) {
      console.warn(`[WARN] [nginx] Erro ao recarregar:`, err.message);
    }

    // Revoke/delete certificate
    try {
      execSync(`certbot delete --cert-name ${subdomain} --non-interactive`, { timeout: 15000, stdio: 'pipe' });
      console.log(`[${new Date().toISOString()}] [INFO] [nginx] Certificado removido para ${subdomain}`);
    } catch (err) {
      console.warn(`[WARN] [nginx] Certbot delete falhou:`, err.message);
    }

    console.log(`[${new Date().toISOString()}] [INFO] [nginx] Server block removido para ${subdomain}`);
  }

  _testConfig() {
    try {
      execSync('nginx -t', { timeout: 5000, stdio: 'pipe' });
    } catch (err) {
      throw new Error(`Configuração Nginx inválida: ${err.stderr ? err.stderr.toString() : err.message}`);
    }
  }

  _reload() {
    try {
      execSync('systemctl reload nginx', { timeout: 5000, stdio: 'pipe' });
    } catch (err) {
      throw new Error(`Falha ao recarregar Nginx: ${err.message}`);
    }
  }
}

module.exports = new NginxService();
