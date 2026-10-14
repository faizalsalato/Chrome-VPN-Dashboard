const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const cloakLicenses = require('../services/cloak-licenses.service');
const instanceService = require('../services/instance.service');

// Todas as rotas exigem sessão: aqui passam chaves de licença.
router.use(authMiddleware);

// GET /api/cloak-licenses - Lista as chaves (mascaradas) com o uso de cada uma
router.get('/', async (req, res, next) => {
  try {
    res.json({ licenses: cloakLicenses.list(), total: cloakLicenses.count() });
  } catch (err) {
    next(err);
  }
});

// POST /api/cloak-licenses - Adiciona chaves (uma por linha no campo `keys`)
router.post('/', async (req, res, next) => {
  try {
    const { keys, label } = req.body || {};
    const result = cloakLicenses.addMany(keys, label);
    const message = result.added
      ? `${result.added} chave(s) adicionada(s)`
      : 'Nenhuma chave nova (já estavam na biblioteca)';
    res.status(201).json({ message, ...result });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: 'ValidationError', message: err.message });
    }
    next(err);
  }
});

// POST /api/cloak-licenses/check - Verifica as chaves no site do vendor
// (plano, prazo e lugares em uso) e devolve a lista já atualizada.
router.post('/check', async (req, res, next) => {
  try {
    const results = await cloakLicenses.checkAll();
    const failed = results.filter(r => r.error);
    const message = failed.length
      ? `${results.length - failed.length} de ${results.length} chave(s) verificada(s)`
      : `${results.length} chave(s) verificada(s)`;
    res.json({ message, results, licenses: cloakLicenses.list(), total: cloakLicenses.count() });
  } catch (err) {
    next(err);
  }
});

// POST /api/cloak-licenses/update - Atualiza o binário Pro para a versão mais
// recente do vendor (quando existir) e recria as instâncias Pro em execução.
router.post('/update', async (req, res, next) => {
  try {
    const result = await instanceService.updateCloakBrowser();
    let message;
    if (result.updated) {
      const version = result.downloadedVersion || result.version || 'nova versão';
      message = `Binário Pro atualizado para ${version}`;
      if (result.recreated.length) {
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
      return res.status(err.status).json({ error: 'ValidationError', message: err.message });
    }
    next(err);
  }
});

// DELETE /api/cloak-licenses/:id - Remove uma chave (solta as instâncias que a usavam)
router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return res.status(400).json({ error: 'ValidationError', message: 'ID inválido' });
    }
    const result = cloakLicenses.remove(id);
    res.json({ message: 'Chave removida', ...result });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: 'NotFound', message: err.message });
    }
    next(err);
  }
});

module.exports = router;
