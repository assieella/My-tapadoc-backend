// routes/google.js — retour de Google après l'autorisation (public, protégé par un « state » signé).
const express = require('express');
const google = require('../google');
const router = express.Router();

function page(title, msg, ok) {
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:sans-serif;background:#F7F4EC;color:#241F14;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0"><div style="background:#fff;border:1px solid #DCD5C2;padding:32px;max-width:460px;text-align:center"><h2 style="color:#0A1B3D;font-family:Georgia,serif">${title}</h2><p>${msg}</p><p><a href="/Back-office-TAPA-CONSEIL.html" style="display:inline-block;background:#C9A227;color:#0A1B3D;padding:10px 18px;text-decoration:none;font-weight:bold">Retour au back office</a></p></div></body></html>`;
}
router.get('/callback', async (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  if (req.query.error) return res.send(page('Connexion annulée', "Google Agenda n'a pas été connecté.", false));
  if (!google.checkState(req.query.state)) return res.status(400).send(page('Lien expiré', 'Recommencez la connexion depuis le back office.', false));
  try {
    const base = (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host');
    const { email } = await google.exchangeCode(String(req.query.code || ''), base);
    res.send(page('Google Agenda connecté', `Les rendez-vous seront créés dans l'agenda ${email ? '<b>' + String(email).replace(/[<>&]/g, '') + '</b>' : 'connecté'}, avec un lien Google Meet.`, true));
  } catch (e) {
    res.status(500).send(page('Connexion impossible', String(e.message).replace(/[<>&]/g, ''), false));
  }
});
module.exports = router;
