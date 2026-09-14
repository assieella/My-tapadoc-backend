// middleware/auth.js — vérifie le token JWT, et l'accès payant en cours (30 jours glissants)
const jwt = require('jsonwebtoken');
const db = require('../db');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Non authentifié.' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session invalide ou expirée.' });
  }
}

function requireActive(req, res, next) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'Compte introuvable.' });
  const active = !!user.access_expires_at && new Date(user.access_expires_at) > new Date();
  if (!active) return res.status(402).json({ error: 'Votre accès a expiré. Un nouveau paiement est nécessaire.' });
  next();
}

module.exports = { requireAuth, requireActive };
