// routes/dossier.js — sauvegarde et chargement du dossier. Remplir le dossier est gratuit dès la
// création du compte ; l'export PDF/Excel est vérifié côté frontend sur `user.active`.
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const row = db.prepare('SELECT data, updated_at FROM dossiers WHERE user_id = ?').get(req.userId);
  if (!row) return res.json({ data: null });
  try { res.json({ data: JSON.parse(row.data), updatedAt: row.updated_at }); }
  catch { res.json({ data: null }); }
});

router.put('/', requireAuth, (req, res) => {
  const data = req.body?.data;
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Données de dossier invalides.' });
  const json = JSON.stringify(data);
  db.prepare(`
    INSERT INTO dossiers (user_id, data, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = datetime('now')
  `).run(req.userId, json);
  res.json({ ok: true });
});

module.exports = router;
