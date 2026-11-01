// routes/assistant.js — TAPA DOC Assistant : chatbot public sur la page d'Accueil.
// Pas d'authentification : le visiteur n'a pas forcément de compte. Il est identifié par un
// identifiant généré côté navigateur (localStorage), pas par IP — voir le cahier des charges
// pour le raisonnement (plusieurs visiteurs peuvent partager une IP).
const express = require('express');
const db = require('../db');
const { genererReponse } = require('../assistant-generation');

const router = express.Router();

const MESSAGE_LIMIT = 8; // quota de messages envoyés par le visiteur, par conversation

// Garde-fou anti-abus léger, par IP — indépendant du quota par visiteur : empêche un script de
// marteler l'API (donc la facture Claude) en générant des identifiants de navigateur à la volée.
// Fenêtre glissante en mémoire, simple et suffisant à ce stade (pas de dépendance supplémentaire).
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_PER_WINDOW = 20;
const rateBuckets = new Map(); // ip -> [timestamps]
function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (rateBuckets.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  timestamps.push(now);
  rateBuckets.set(ip, timestamps);
  return timestamps.length > RATE_MAX_PER_WINDOW;
}

function isValidVisitorId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9-]{10,64}$/.test(id);
}

// Extrait la directive [BOUTONS: A | B] éventuelle en fin de réponse ; renvoie le texte nettoyé
// et la liste des boutons suggérés (peut être vide).
function extraireBoutons(texte) {
  const match = texte.match(/\[BOUTONS:\s*([^\]]+)\]\s*$/);
  if (!match) return { texte: texte.trim(), boutons: [] };
  const boutons = match[1].split('|').map(b => b.trim()).filter(Boolean);
  const texteNettoye = texte.slice(0, match.index).trim();
  return { texte: texteNettoye, boutons };
}

function chargerConversation(visitorId) {
  let row = db.prepare('SELECT * FROM assistant_conversations WHERE visitor_id = ?').get(visitorId);
  if (!row) {
    db.prepare(`INSERT INTO assistant_conversations (visitor_id, messages, message_count) VALUES (?, '[]', 0)`).run(visitorId);
    row = db.prepare('SELECT * FROM assistant_conversations WHERE visitor_id = ?').get(visitorId);
  }
  return row;
}

// Récupère l'historique existant — utilisé au chargement de la page pour restaurer la conversation.
router.get('/conversation/:visitorId', (req, res) => {
  const { visitorId } = req.params;
  if (!isValidVisitorId(visitorId)) return res.status(400).json({ error: 'Identifiant invalide.' });
  const row = chargerConversation(visitorId);
  const messages = JSON.parse(row.messages);
  res.json({
    messages,
    messageCount: row.message_count,
    limitReached: row.message_count >= MESSAGE_LIMIT,
    limit: MESSAGE_LIMIT
  });
});

router.post('/message', express.json(), async (req, res) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Trop de requêtes, merci de patienter un instant.' });
  }

  const { visitorId, message } = req.body || {};
  if (!isValidVisitorId(visitorId)) return res.status(400).json({ error: 'Identifiant invalide.' });
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Message vide.' });
  }
  if (message.length > 2000) {
    return res.status(400).json({ error: 'Message trop long.' });
  }

  const row = chargerConversation(visitorId);
  if (row.message_count >= MESSAGE_LIMIT) {
    return res.status(403).json({ error: 'Quota de messages atteint.', limitReached: true, limit: MESSAGE_LIMIT });
  }

  const historique = JSON.parse(row.messages);
  historique.push({ role: 'user', content: message.trim() });

  try {
    const reponseBrute = await genererReponse({ messages: historique });
    const { texte, boutons } = extraireBoutons(reponseBrute);
    historique.push({ role: 'assistant', content: texte });

    const nouveauCompte = row.message_count + 1;
    db.prepare(`UPDATE assistant_conversations SET messages = ?, message_count = ?, updated_at = datetime('now') WHERE visitor_id = ?`)
      .run(JSON.stringify(historique), nouveauCompte, visitorId);

    res.json({
      reply: texte,
      boutons,
      messageCount: nouveauCompte,
      limitReached: nouveauCompte >= MESSAGE_LIMIT,
      limit: MESSAGE_LIMIT
    });
  } catch (err) {
    console.error('Erreur assistant TAPA DOC:', err);
    res.status(502).json({ error: "L'assistant n'a pas pu répondre pour le moment. Réessayez dans un instant." });
  }
});

module.exports = router;
