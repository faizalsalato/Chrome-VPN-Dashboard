const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const instanceService = require('../services/instance.service');
const profileFiles = require('../services/profile-files.service');

// All instance routes require authentication
router.use(authMiddleware);

// GET /api/instances - List all instances
router.get('/', async (req, res, next) => {
  try {
    const result = await instanceService.getAll();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/instances - Create new instance
router.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    const {
      country, type = 'vpn', proxy, fingerprint, browser, vpnProvider, cloakEdition, proxyId
    } = body;

    if (type !== 'vpn' && type !== 'proxy') {
      return res.status(400).json({
        error: 'ValidationError',
        message: "Tipo inválido. Use 'vpn' ou 'proxy'"
      });
    }

    if (vpnProvider !== undefined && vpnProvider !== 'surfshark' && vpnProvider !== 'expressvpn') {
      return res.status(400).json({
        error: 'ValidationError',
        message: "Provedor VPN inválido. Use 'surfshark' ou 'expressvpn'"
      });
    }

    if (browser !== undefined && !['chromium', 'cloakbrowser'].includes(browser)) {
      return res.status(400).json({
        error: 'ValidationError',
        message: "Navegador inválido. Use 'chromium' ou 'cloakbrowser'"
      });
    }

    if (cloakEdition !== undefined && !['free', 'pro'].includes(cloakEdition)) {
      return res.status(400).json({
        error: 'ValidationError',
        message: "Versão do CloakBrowser inválida. Use 'free' ou 'pro'"
      });
    }

    if (fingerprint !== undefined && (typeof fingerprint !== 'object' || fingerprint === null || Array.isArray(fingerprint))) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'Fingerprint deve ser um objeto'
      });
    }

    let proxyConfig = null;
    if (type === 'proxy') {
      if (!proxy || !proxy.host || !proxy.port) {
        return res.status(400).json({
          error: 'ValidationError',
          message: 'Proxy requer host e porta'
        });
      }
      const port = parseInt(proxy.port, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        return res.status(400).json({
          error: 'ValidationError',
          message: 'Porta de proxy inválida'
        });
      }
      const auth = !!proxy.auth;
      if (auth && (!proxy.user || !proxy.pass)) {
        return res.status(400).json({
          error: 'ValidationError',
          message: 'Proxy autenticado requer usuário e senha'
        });
      }
      proxyConfig = {
        host: proxy.host,
        port,
        user: proxy.user || '',
        pass: proxy.pass || '',
        scheme: proxy.scheme === 'https' ? 'https' : 'http',
        auth
      };
    }

    // O corpo tem de chegar INTEIRO ao serviço: `cloakEdition` decide se a
    // instância nasce com chave (a versão "com licença") e `proxyId` liga-a à
    // geo do proxy que o cartão mostra. Montar o objeto à mão já deixou cair
    // estes dois campos — a instância nascia "sem licença" sem aviso.
    const instance = await instanceService.create({
      country, type, proxy: proxyConfig, fingerprint, browser, vpnProvider, cloakEdition, proxyId
    });
    res.status(201).json(instance);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({
        error: 'CreateError',
        message: err.message
      });
    }
    next(err);
  }
});

// POST /api/instances/:id/files - Envia um ficheiro para a pasta de Downloads do
// perfil (foto/vídeo que o usuário vai publicar nas redes).
router.post('/:id/files', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'ID de instância inválido'
      });
    }

    const { name, data } = req.body || {};
    const decoded = profileFiles.decode(data);
    if (decoded.error) {
      return res.status(400).json({ error: 'ValidationError', message: decoded.error });
    }

    const saved = await instanceService.saveFile(id, name, decoded.buffer);
    res.status(201).json({
      message: `"${saved.name}" enviado para o perfil (pasta Downloads)`,
      ...saved
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: 'UploadError', message: err.message });
    }
    next(err);
  }
});

// DELETE /api/instances/:id - Remove instance
router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'ID de instância inválido'
      });
    }

    await instanceService.remove(id);
    res.json({ message: `Instância ${id} removida com sucesso` });
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({
        error: 'NotFound',
        message: err.message
      });
    }
    next(err);
  }
});

// POST /api/instances/:id/start - Start instance
router.post('/:id/start', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'ID de instância inválido'
      });
    }

    await instanceService.start(id);
    res.json({ message: `Instância ${id} iniciada com sucesso` });
  } catch (err) {
    if (err.statusCode === 304 || (err.message && err.message.includes('already started'))) {
      return res.json({ message: `Instância ${id} já está em execução` });
    }
    if (err.statusCode === 404) {
      return res.status(404).json({
        error: 'NotFound',
        message: `Instância ${id} não encontrada`
      });
    }
    next(err);
  }
});

// POST /api/instances/:id/restart - Restart instance
router.post('/:id/restart', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'ID de instância inválido'
      });
    }

    await instanceService.restart(id);
    res.json({ message: `Instância ${id} reiniciada com sucesso` });
  } catch (err) {
    if (err.statusCode === 404) {
      return res.status(404).json({
        error: 'NotFound',
        message: `Instância ${id} não encontrada`
      });
    }
    next(err);
  }
});

// POST /api/instances/:id/stop - Stop instance
router.post('/:id/stop', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'ID de instância inválido'
      });
    }

    await instanceService.stop(id);
    res.json({ message: `Instância ${id} parada com sucesso` });
  } catch (err) {
    if (err.statusCode === 304 || (err.message && err.message.includes('already stopped'))) {
      return res.json({ message: `Instância ${id} já está parada` });
    }
    if (err.statusCode === 404) {
      return res.status(404).json({
        error: 'NotFound',
        message: `Instância ${id} não encontrada`
      });
    }
    next(err);
  }
});

// POST /api/instances/:id/country - Change VPN country
router.post('/:id/country', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'ID de instância inválido'
      });
    }

    const { country } = req.body;
    if (!country) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'País é obrigatório'
      });
    }

    await instanceService.changeCountry(id, country);
    res.json({ message: `País alterado para ${country}` });
  } catch (err) {
    next(err);
  }
});

// POST /api/instances/:id/cloak-edition - Troca a edição do CloakBrowser
// ("free" = binário antigo sem chave; "pro" = binário novo com a chave da
// biblioteca). Recria os containers preservando o perfil.
router.post('/:id/cloak-edition', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'ID de instância inválido'
      });
    }

    const edition = String((req.body && req.body.edition) || '').toLowerCase();
    if (edition !== 'free' && edition !== 'pro') {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'Edição inválida (use "free" ou "pro")'
      });
    }

    await instanceService.changeCloakEdition(id, edition);
    res.json({
      message: edition === 'pro'
        ? 'CloakBrowser na versão nova (com licença)'
        : 'CloakBrowser na versão antiga (sem chave)'
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/instances/:id/proxy - Troca o proxy de uma instância proxy.
// O corpo traz o id de um proxy da biblioteca (a senha fica no servidor).
router.post('/:id/proxy', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'ID de instância inválido'
      });
    }

    const proxyId = parseInt(req.body && req.body.proxyId, 10);
    if (isNaN(proxyId) || proxyId < 1) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'Proxy é obrigatório'
      });
    }

    await instanceService.changeProxy(id, proxyId);
    res.json({ message: `Proxy da instância ${id} alterado` });
  } catch (err) {
    next(err);
  }
});

// GET /api/instances/:id/vpn - Get VPN info
router.get('/:id/vpn', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'ID de instância inválido'
      });
    }

    const vpnInfo = await instanceService.getVPNInfo(id);
    res.json(vpnInfo);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
