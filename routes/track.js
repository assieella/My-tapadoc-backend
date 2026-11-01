// routes/track.js — suivi du parcours des personnes IDENTIFIÉES (compte connecté) : quel service, quelle étape.
// Aucun suivi des visiteurs anonymes. Les appels sans jeton valide sont ignorés silencieusement.
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');
const router = express.Router();

const PRODUITS = ['finmodel', 'business-plan', 'procedures', 'accueil', 'pre-cred'];
const TYPES = ['open', 'screen', 'step', 'paywall', 'pay_click', 'cta'];
const buckets = new Map();
function limited(uid) {
  const now = Date.now(); const l = (buckets.get(uid) || []).filter(t => now - t < 3600000);
  if (l.length >= 400) { buckets.set(uid, l); return true; }
  l.push(now); buckets.set(uid, l); return false;
}

router.post('/', (req, res) => {
  try {
    const b = req.body || {};
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : b.token;
    if (!token || !PRODUITS.includes(b.produit) || !TYPES.includes(b.type)) return res.json({ ok: true });
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const detail = b.detail ? String(b.detail).slice(0, 120) : null;
    if (limited(payload.userId)) return res.json({ ok: true });
    // on ignore une répétition identique dans les 30 dernières secondes (ré-affichage de l'écran)
    const last = db.prepare('SELECT produit, type, detail, created_at FROM evenements WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(payload.userId);
    if (last && last.produit === b.produit && last.type === b.type && (last.detail || null) === detail &&
        Date.now() - new Date(last.created_at.replace(' ', 'T') + 'Z').getTime() < 30000) return res.json({ ok: true });
    db.prepare('INSERT INTO evenements (user_id, produit, type, detail) VALUES (?,?,?,?)').run(payload.userId, b.produit, b.type, detail);
  } catch (e) { /* jeton invalide : on ignore */ }
  res.json({ ok: true });
});
module.exports = router;
