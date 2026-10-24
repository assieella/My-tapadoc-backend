// routes/auth.js — inscription / connexion / mot de passe oublié / profil du compte
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { sendMail } = require('../email');
const { COUNTRIES } = require('../channels');

const router = express.Router();

function publicUser(u) {
  const active = !!u.access_expires_at && new Date(u.access_expires_at) > new Date();
  return {
    id: u.id, email: u.email, nomEntreprise: u.nom_entreprise, phone: u.phone, country: u.country,
    emailVerified: !!u.email_verified, hasPaidBefore: !!u.has_paid_before,
    accessExpiresAt: u.access_expires_at, active
  };
}
function signToken(userId) { return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '30d' }); }
function makeVerifyToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  db.prepare('UPDATE users SET verify_token_hash = ?, verify_token_expires = ? WHERE id = ?').run(tokenHash, expires, userId);
  return token;
}
async function sendVerificationEmail(user, token) {
  const link = `${process.env.FRONTEND_URL}/?verify=${token}`;
  await sendMail({
    to: user.email,
    subject: 'Confirmez votre email — TAPA CONSEIL',
    html: `<p>Bonjour,</p><p>Merci de créer votre compte. Cliquez sur ce lien pour confirmer votre email (valable 24h) :</p><p><a href="${link}">${link}</a></p><p>Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.</p>`
  }).catch(err => console.error('Erreur envoi email:', err));
}

router.post('/register', async (req, res) => {
  const { email, password, nomEntreprise, phone, country } = req.body || {};
  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: 'Email et mot de passe (6 caractères min.) requis.' });
  }
  const countryCode = COUNTRIES[country] ? country : 'CI';
  const cleanEmail = email.toLowerCase().trim();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail);
  if (existing) return res.status(409).json({ error: 'Un compte existe déjà avec cet email.' });

  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare(
    `INSERT INTO users (email, password_hash, nom_entreprise, phone, country) VALUES (?, ?, ?, ?, ?)`
  ).run(cleanEmail, hash, nomEntreprise || '', phone || '', countryCode);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  const token = makeVerifyToken(user.id);
  await sendVerificationEmail(user, token);
  res.json({ requiresVerification: true, email: user.email });
});

router.post('/resend-verification', async (req, res) => {
  const email = (req.body?.email || '').toLowerCase().trim();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (user && !user.email_verified) {
    const token = makeVerifyToken(user.id);
    await sendVerificationEmail(user, token);
  }
  res.json({ ok: true, message: "Si ce compte existe et n'est pas encore confirmé, un email vient d'être renvoyé." });
});

router.post('/verify-email', (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Lien invalide.' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const user = db.prepare('SELECT * FROM users WHERE verify_token_hash = ?').get(tokenHash);
  if (!user || !user.verify_token_expires || new Date(user.verify_token_expires) < new Date()) {
    return res.status(400).json({ error: "Ce lien de confirmation est invalide ou a expiré. Redemandez un email depuis l'écran de connexion." });
  }
  db.prepare('UPDATE users SET email_verified = 1, verify_token_hash = NULL, verify_token_expires = NULL WHERE id = ?').run(user.id);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  res.json({ token: signToken(updated.id), user: publicUser(updated) });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').toLowerCase().trim());
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
  }
  if (!user.email_verified) {
    return res.status(403).json({ error: 'NOT_VERIFIED', message: "Confirmez d'abord votre email — vérifiez votre boîte de réception." });
  }
  res.json({ token: signToken(user.id), user: publicUser(user) });
});

router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'Compte introuvable.' });
  res.json({ user: publicUser(user) });
});

router.patch('/me', requireAuth, (req, res) => {
  const { nomEntreprise, phone, country, currentPassword, newPassword } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'Compte introuvable.' });
  if (newPassword) {
    if (!currentPassword || !bcrypt.compareSync(currentPassword, user.password_hash)) {
      return res.status(401).json({ error: 'Mot de passe actuel incorrect.' });
    }
    if (newPassword.length < 6) return res.status(400).json({ error: 'Le nouveau mot de passe doit faire 6 caractères minimum.' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), user.id);
  }
  const countryCode = country && COUNTRIES[country] ? country : null;
  if (nomEntreprise !== undefined || phone !== undefined || countryCode) {
    db.prepare('UPDATE users SET nom_entreprise = COALESCE(?, nom_entreprise), phone = COALESCE(?, phone), country = COALESCE(?, country) WHERE id = ?')
      .run(nomEntreprise ?? null, phone ?? null, countryCode, user.id);
  }
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  res.json({ user: publicUser(updated) });
});

router.get('/countries', (req, res) => {
  res.json({ countries: Object.entries(COUNTRIES).map(([code, c]) => ({ code, name: c.name, dial: c.dial })) });
});

router.post('/forgot-password', async (req, res) => {
  const email = (req.body?.email || '').toLowerCase().trim();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (user) {
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE users SET reset_token_hash = ?, reset_token_expires = ? WHERE id = ?').run(tokenHash, expires, user.id);
    const link = `${process.env.FRONTEND_URL}/?reset=${token}`;
    await sendMail({
      to: user.email,
      subject: 'Réinitialisation de votre mot de passe — TAPA CONSEIL',
      html: `<p>Bonjour,</p><p>Cliquez sur ce lien pour choisir un nouveau mot de passe (valable 1 heure) :</p><p><a href="${link}">${link}</a></p><p>Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.</p>`
    }).catch(err => console.error('Erreur envoi email:', err));
  }
  res.json({ ok: true, message: "Si un compte existe avec cet email, un lien de réinitialisation a été envoyé." });
});

router.post('/reset-password', (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!token || !newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'Lien invalide ou mot de passe trop court (6 caractères min.).' });
  }
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const user = db.prepare('SELECT * FROM users WHERE reset_token_hash = ?').get(tokenHash);
  if (!user || !user.reset_token_expires || new Date(user.reset_token_expires) < new Date()) {
    return res.status(400).json({ error: 'Ce lien de réinitialisation est invalide ou a expiré.' });
  }
  db.prepare('UPDATE users SET password_hash = ?, reset_token_hash = NULL, reset_token_expires = NULL WHERE id = ?')
    .run(bcrypt.hashSync(newPassword, 10), user.id);
  res.json({ ok: true });
});

module.exports = router;
