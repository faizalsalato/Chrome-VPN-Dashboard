const express = require('express');
const router = express.Router();
const adminAuth = require('../middleware/admin-auth.middleware');
const instanceService = require('../services/instance.service');
const proxiesService = require('../services/proxies.service');
const vpnCredentials = require('../services/vpn-credentials.service');
const versionsService = require('../services/versions.service');
const imageUpdate = require('../services/image-update.service');
const cloakLicenses = require('../services/cloak-licenses.service');

/**
 * API da página /admin/.
 *
 * Autenticação própria (token compartilhado), independente do JWT de usuário.
 * A página não pede login: quem tem o token entra. Por isso este router é
 * montado ANTES do authMiddleware de usuário e não o reutiliza.
 *
 * Tudo aqui é leitura de estado ou ação de operador. As ações destrutivas
 * (delete) exigem confirmação explícita no corpo — a página manda
 * `{ confirm: true }` depois de o operador confirmar na tela.
 */

// Todas as rotas exigem o token de admin.
router.use(adminAuth.requireAdmin);

/** GET /api/admin/state — tudo que a página mostra, numa consulta só. */
router.get('/state', async (req, res, next) => {
  try {
    // `getAll()` já resolve o estado do Docker e enriquece cada instância com
    // health, geo e fingerprint. Não há um `isConnected()` separado no serviço.
    const instances = await instanceService.getAll();

    // Versões entram na mesma resposta: a página faz um pedido só. O serviço
    // tem cache próprio (5 min) para não bater no registry a cada poll.
    let versions = null;
    let versionsError = null;
    try {
      versions = await versionsService.snapshot();
    } catch (err) {
      versionsError = err.message;
    }

    res.json({
      instances: instances.instances || [],
      dockerConnected: instances.dockerConnected,
      proxies: proxiesService.list(),
      vpnProviders: vpnCredentials.list(),
      versions,
      versionsError,
      server: {
        time: new Date().toISOString(),
        uptimeSeconds: Math.round(process.uptime()),
        node: process.version,
        memory: process.memoryUsage(),
        host: require('os').hostname(),
        platform: require('os').platform()
      }
    });
  } catch (err) {
    next(err);
  }
});

/** GET /api/admin/versions?force=1 — só o bloco de versões, com refresh opcional. */
router.get('/versions', async (req, res, next) => {
  try {
    const force = req.query.force === '1' || req.query.force === 'true';
    res.json(await versionsService.snapshot({ force }));
  } catch (err) {
    next(err);
  }
});

/** POST /api/admin/versions/check — força a consulta ao registry e ao Google. */
router.post('/versions/check', async (req, res, next) => {
  try {
    versionsService._clearCache();
    const data = await versionsService.snapshot({ force: true });
    res.json({ message: 'Versões verificadas', ...data });
  } catch (err) {
    next(err);
  }
});

/** POST /api/admin/instances/:id/:action — start | stop | restart */
router.post('/instances/:id/:action', async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  const action = req.params.action;

  if (isNaN(id) || id < 1) {
    return res.status(400).json({ error: 'ValidationError', message: 'ID inválido' });
  }
  if (!['start', 'stop', 'restart'].includes(action)) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'Ação inválida (start, stop, restart)'
    });
  }

  try {
    await instanceService[action](id);
    res.json({ message: `Instância ${id}: ${action} executado`, id, action });
  } catch (err) {
    if (err.statusCode === 404 || err.status === 404) {
      return res.status(404).json({ error: 'NotFound', message: err.message });
    }
    if (err.status) {
      return res.status(err.status).json({ error: 'ActionError', message: err.message });
    }
    next(err);
  }
});

/** DELETE /api/admin/instances/:id — exige { confirm: true } no corpo. */
router.delete('/instances/:id', async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id < 1) {
    return res.status(400).json({ error: 'ValidationError', message: 'ID inválido' });
  }
  if (!req.body || req.body.confirm !== true) {
    return res.status(400).json({
      error: 'ConfirmationRequired',
      message: 'Remover instância exige { "confirm": true } no corpo'
    });
  }

  try {
    await instanceService.remove(id);
    res.json({ message: `Instância ${id} removida`, id });
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({ error: 'NotFound', message: err.message });
    }
    next(err);
  }
});

/** POST /api/admin/proxies/:id/test — testa o proxy e grava a geo. */
router.post('/proxies/:id/test', async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id < 1) {
    return res.status(400).json({ error: 'ValidationError', message: 'ID inválido' });
  }

  try {
    const proxyTester = require('../services/proxy-tester.service');
    const proxy = proxiesService.getWithSecrets(id);
    const result = await proxyTester.test({
      host: proxy.host,
      port: proxy.port,
      scheme: proxy.scheme,
      user: proxy.user,
      pass: proxy.pass
    });
    proxiesService.saveGeo(id, result);
    res.json(result);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: 'NotFound', message: err.message });
    }
    next(err);
  }
});

// ------------------------------------------------------- atualizar imagem
//
// "Atualizar" aqui e PULL + reconstrucao da derivada. Nao recria instancia:
// interromper sessao de usuario e outra acao, confirmada a parte.

/**
 * POST /api/admin/images/:browser/update
 *
 * browser: chromium | brave | firefox | cloakbrowser
 *
 * O CloakBrowser responde com erro explicativo de proposito: ele nao se
 * atualiza por pull (o binario vem do vendor com a chave). Melhor devolver o
 * motivo do que puxar a imagem e fingir que atualizou o navegador.
 */
router.post('/images/:browser/update', async (req, res, next) => {
  const browser = String(req.params.browser || '').toLowerCase();
  const allowed = ['chromium', 'brave', 'firefox', 'cloakbrowser'];

  if (!allowed.includes(browser)) {
    return res.status(400).json({
      error: 'ValidationError',
      message: `Navegador invalido. Use um de: ${allowed.join(', ')}`
    });
  }

  try {
    const result = await imageUpdate.updateImage(browser, {
      edition: req.body && req.body.edition
    });

    if (result.error && !result.after) {
      // Falha de verdade (pull quebrou, registry fora): 502, nao 200.
      return res.status(502).json({
        error: 'UpdateFailed',
        message: result.error,
        ...result
      });
    }

    let message;
    if (browser === 'cloakbrowser') {
      message = result.error;
    } else if (result.changed) {
      message = `Imagem de ${browser} atualizada` +
        (result.rebuilt ? ' (derivada reconstruida)' : '');
    } else {
      message = `Imagem de ${browser} ja estava na mais recente`;
    }

    res.json({ message, ...result });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/images/:browser/update-and-recreate
 *
 * Atualiza a imagem E recria as instancias daquele navegador que estao a
 * correr. Exige { confirm: true }: isto derruba sessao aberta.
 */
router.post('/images/:browser/update-and-recreate', async (req, res, next) => {
  const browser = String(req.params.browser || '').toLowerCase();
  const allowed = ['chromium', 'brave', 'firefox'];

  if (!allowed.includes(browser)) {
    return res.status(400).json({
      error: 'ValidationError',
      message: `Navegador invalido. Use um de: ${allowed.join(', ')}`
    });
  }
  if (!req.body || req.body.confirm !== true) {
    return res.status(400).json({
      error: 'ConfirmationRequired',
      message: 'Recriar as instancias derruba as sessoes abertas. Envie { "confirm": true }.'
    });
  }

  try {
    const result = await imageUpdate.updateImage(browser);
    const recreated = [];
    const failed = [];

    if (result.error && !result.after) {
      return res.status(502).json({ error: 'UpdateFailed', message: result.error, ...result });
    }

    // So recria quando a imagem mudou de fato: sem mudanca, reiniciar os
    // navegadores seria so interrupcao sem ganho.
    if (result.changed) {
      const instances = await instanceService.getAll();
      for (const item of instances.instances || []) {
        if (item.browser !== browser) continue;
        try {
          await instanceService.restart(item.id);
          recreated.push(item.id);
        } catch (err) {
          failed.push({ id: item.id, error: err.message });
        }
      }
    }

    res.json({
      message: result.changed
        ? `Imagem de ${browser} atualizada; ${recreated.length} instancia(s) recriada(s)`
        : `Imagem de ${browser} ja estava na mais recente; nada recriado`,
      ...result,
      recreated,
      failed
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- CloakBrowser

/**
 * POST /api/admin/cloak/check — verifica as chaves no vendor.
 *
 * Uma consulta por chave (plano, prazo, lugares em uso). Pode demorar: são
 * chamadas HTTPS ao cloakbrowser.dev, com timeout de 12s cada.
 */
router.post('/cloak/check', async (req, res, next) => {
  try {
    const results = await cloakLicenses.checkAll();
    const failed = results.filter((r) => r.error);
    res.json({
      message: failed.length
        ? `${results.length - failed.length} de ${results.length} chave(s) verificada(s)`
        : `${results.length} chave(s) verificada(s)`,
      results,
      licenses: cloakLicenses.list(),
      total: cloakLicenses.count()
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/cloak/update — baixa o binário Pro mais recente do vendor.
 *
 * Isto RECRIA as instâncias Pro em execução (o binário novo só entra no ar
 * assim), então exige { confirm: true }: é interrupção de sessão de usuário.
 */
router.post('/cloak/update', async (req, res, next) => {
  if (!req.body || req.body.confirm !== true) {
    return res.status(400).json({
      error: 'ConfirmationRequired',
      message: 'Atualizar o binário Pro recria as instâncias em execução. Envie { "confirm": true }.'
    });
  }

  try {
    const result = await instanceService.updateCloakBrowser();
    let message;
    if (result.updated) {
      const version = result.downloadedVersion || result.version || 'nova versão';
      message = `Binário Pro atualizado para ${version}`;
      if (result.recreated && result.recreated.length) {
        message += ` (${result.recreated.length} instância(s) recriada(s): ${result.recreated.join(', ')})`;
      }
    } else if (result.failed) {
      message = 'Não foi possível atualizar o binário Pro (ver o log do servidor)';
    } else {
      message = `Já está na versão mais recente${result.version ? ` (${result.version})` : ''}`;
    }
    res.json({ message, ...result });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: 'UpdateError', message: err.message });
    }
    next(err);
  }
});

module.exports = router;
