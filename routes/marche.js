// routes/marche.js — génère l'étude de marché et l'analyse concurrentielle du Business Plan via
// l'IA (avec recherche web réelle). Réservé aux comptes ayant un accès Business Plan actif.
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { genererEtudeMarche } = require('../marche-generation');

const router = express.Router();

router.post('/generer', requireAuth, async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'Compte introuvable.' });

  const active = !!user.businessplan_access_expires_at && new Date(user.businessplan_access_expires_at) > new Date();
  if (!active) {
    return res.status(402).json({ error: "Cette fonctionnalité nécessite un accès Business Plan actif." });
  }

  const { activite, secteur, localisation, nomEntreprise } = req.body || {};
  try {
    const etude = await genererEtudeMarche({ activite, secteur, localisation, nomEntreprise });
    res.json({ etude });
  } catch (err) {
    console.error('Erreur génération étude de marché:', err);
    res.status(502).json({ error: err.message || "Échec de la génération. Réessayez dans un instant." });
  }
});

module.exports = router;
