// routes/procedures.js — TAPA Procédures : génération de manuels de procédures.
// Réutilise les comptes et le paiement Paiement Pro déjà en place pour TAPA FinModel/Business Plan.
//
// Parcours : questionnaire (gratuit) → paiement à l'unité → génération IA section par section
// (suivi en temps réel via polling) → téléchargement .docx immédiat (palier Standard) ou après
// validation par un expert TAPA (palier Validé).
const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { codeFor, currencyFor } = require('../channels');
const { TEMPLATES, tarifSelonTaille } = require('../templates-procedures');
const { genererSection } = require('../claude-generation');
const { saveManuelDocx } = require('../docx-builder');

const router = express.Router();
const OUT_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'manuels-generes');
const upload = multer({ dest: path.join(__dirname, '..', 'uploads-tmp'), limits: { fileSize: 20 * 1024 * 1024 } });

const PAIEMENTPRO_INIT_URL = process.env.PAIEMENTPRO_MODE === 'live'
  ? 'https://www.paiementpro.net/webservice/onlinepayment/init/curl-init.php'
  : 'https://sandbox.paiementpro.net/webservice/onlinepayment/init/curl-init.php';

function requireAdminKey(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Clé admin manquante ou incorrecte.' });
  }
  next();
}

function publicManuel(m) {
  return {
    id: m.id, type: m.type, palier: m.palier, statut: m.statut,
    contexte: JSON.parse(m.contexte), sections: m.sections ? JSON.parse(m.sections) : [],
    createdAt: m.created_at, updatedAt: m.updated_at
  };
}
function titreManuel(type) {
  return type === 'comptable' ? 'Manuel Comptable — Dossier de Crédit' : 'Manuel PME — Procédures Administratives & Financières';
}

router.get('/templates', (req, res) => {
  const out = {};
  Object.entries(TEMPLATES).forEach(([key, t]) => {
    out[key] = { label: t.label, description: t.description, prix: t.prix, sections: t.sections.map(s => s.titre) };
  });
  res.json({ templates: out });
});

router.post('/', requireAuth, (req, res) => {
  const { type, palier, contexte } = req.body || {};
  if (!TEMPLATES[type]) return res.status(400).json({ error: 'Type de manuel invalide.' });
  if (!['standard', 'valide'].includes(palier)) return res.status(400).json({ error: 'Palier invalide.' });
  const info = db.prepare(
    `INSERT INTO manuels (user_id, type, palier, contexte, statut) VALUES (?, ?, ?, ?, 'brouillon')`
  ).run(req.userId, type, palier, JSON.stringify(contexte || {}));
  const m = db.prepare('SELECT * FROM manuels WHERE id = ?').get(info.lastInsertRowid);
  res.json({ manuel: publicManuel(m) });
});

router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM manuels WHERE user_id = ? ORDER BY created_at DESC').all(req.userId);
  res.json({ manuels: rows.map(publicManuel) });
});

router.get('/:id', requireAuth, (req, res) => {
  const m = db.prepare('SELECT * FROM manuels WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!m) return res.status(404).json({ error: 'Manuel introuvable.' });
  res.json({ manuel: publicManuel(m) });
});

// Tarif exact calculé selon le type, la formule et la taille de l'entreprise — consultable avant
// paiement, pour que le client voie le vrai prix (jamais le tarif de base seul).
router.get('/:id/tarif', requireAuth, (req, res) => {
  const m = db.prepare('SELECT * FROM manuels WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!m) return res.status(404).json({ error: 'Manuel introuvable.' });
  const contexte = JSON.parse(m.contexte);
  const prixBase = TEMPLATES[m.type].prix[m.palier];
  const tarif = tarifSelonTaille(prixBase, contexte.taille);
  res.json(tarif);
});

router.get('/:id/status', requireAuth, (req, res) => {
  const m = db.prepare('SELECT id, statut, sections, type FROM manuels WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!m) return res.status(404).json({ error: 'Manuel introuvable.' });
  const sections = m.sections ? JSON.parse(m.sections) : [];
  const total = TEMPLATES[m.type].sections.length;
  res.json({ statut: m.statut, sectionsGenerees: sections.length, totalSections: total, sections });
});

router.post('/:id/pay/init', requireAuth, async (req, res) => {
  const m = db.prepare('SELECT * FROM manuels WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!m) return res.status(404).json({ error: 'Manuel introuvable.' });
  if (!['brouillon', 'erreur'].includes(m.statut)) return res.status(400).json({ error: 'Ce manuel a déjà été payé ou est en cours de traitement.' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  const contexte = JSON.parse(m.contexte);
  const prixBase = TEMPLATES[m.type].prix[m.palier];
  const tarif = tarifSelonTaille(prixBase, contexte.taille);
  if (tarif.surDevis) {
    return res.status(200).json({
      surDevis: true,
      message: "La taille de cette entreprise nécessite un devis personnalisé — contactez TAPA CONSEIL pour l'établir avec vous."
    });
  }
  const amount = tarif.amount;
  const kind = `${m.type}-${m.palier}`;
  const reference = `PROCEDURES-${m.id}-${Date.now()}`;
  const channelKey = req.body?.channel;
  const channelCode = channelKey ? codeFor(user.country, channelKey) : null;
  if (!channelCode) {
    return res.status(400).json({ error: "Ce moyen de paiement n'est pas encore activé. Choisissez un autre Mobile Money ou contactez le support." });
  }

  db.prepare(
    `INSERT INTO payments (user_id, reference, product, kind, amount, status, manuel_id) VALUES (?, ?, 'procedures', ?, ?, 'pending', ?)`
  ).run(user.id, reference, kind, amount, m.id);

  const payload = {
    merchantId: process.env.PAIEMENTPRO_MERCHANT_ID,
    amount,
    description: `${titreManuel(m.type)} (${m.palier === 'valide' ? 'validé par un expert' : 'standard'}) — TAPA CONSEIL`,
    channel: channelCode,
    countryCurrencyCode: currencyFor(user.country),
    referenceNumber: reference,
    customerEmail: user.email,
    customerFirstName: user.nom_entreprise || 'Client',
    customerLastname: 'TAPA',
    customerPhoneNumber: user.phone || '0000000000',
    notificationURL: `${process.env.BASE_URL}/api/payment/notify`,
    returnURL: `${process.env.FRONTEND_URL}/?paiement=retour`,
    returnContext: JSON.stringify({ userId: user.id, reference })
  };

  try {
    const ppRes = await fetch(PAIEMENTPRO_INIT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload)
    });
    const data = await ppRes.json();
    if (!data.success) return res.status(502).json({ error: data.message || "Échec de l'initialisation du paiement." });
    db.prepare(`UPDATE manuels SET statut = 'attente_paiement', updated_at = datetime('now') WHERE id = ?`).run(m.id);
    res.json({ url: data.url, reference, amount });
  } catch (err) {
    console.error('Erreur init Paiement Pro (procédures):', err);
    res.status(502).json({ error: 'Impossible de contacter le service de paiement pour le moment.' });
  }
});

async function startGenerationForManuel(manuelId) {
  const m = db.prepare('SELECT * FROM manuels WHERE id = ?').get(manuelId);
  if (!m) return;
  const template = TEMPLATES[m.type];
  const contexte = JSON.parse(m.contexte);
  db.prepare(`UPDATE manuels SET statut = 'en_generation', sections = '[]', updated_at = datetime('now') WHERE id = ?`).run(m.id);

  const sections = [];
  try {
    for (const s of template.sections) {
      const contenu = await genererSection({ consigne: s.consigne, titre: s.titre, contexte });
      sections.push({ titre: s.titre, contenu });
      db.prepare(`UPDATE manuels SET sections = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(JSON.stringify(sections), m.id);
    }
    const docxPath = await saveManuelDocx(m.id, titreManuel(m.type), contexte, sections, OUT_DIR);
    const statutFinal = m.palier === 'valide' ? 'attente_validation' : 'genere';
    db.prepare(`UPDATE manuels SET statut = ?, docx_path = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(statutFinal, docxPath, m.id);
  } catch (err) {
    console.error('Erreur génération manuel', manuelId, ':', err);
    db.prepare(`UPDATE manuels SET statut = 'erreur', updated_at = datetime('now') WHERE id = ?`).run(m.id);
  }
}

router.get('/:id/download', requireAuth, (req, res) => {
  const m = db.prepare('SELECT * FROM manuels WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!m) return res.status(404).json({ error: 'Manuel introuvable.' });
  const pretAuTelechargement = (m.palier === 'standard' && m.statut === 'genere') || (m.palier === 'valide' && m.statut === 'livre');
  if (!pretAuTelechargement || !m.docx_path || !fs.existsSync(m.docx_path)) {
    return res.status(400).json({ error: "Ce manuel n'est pas encore prêt à être téléchargé." });
  }
  res.download(m.docx_path, `${titreManuel(m.type).replace(/[^a-z0-9]+/gi, '_')}.docx`);
});

router.get('/admin/en-attente', requireAdminKey, (req, res) => {
  const rows = db.prepare(`SELECT * FROM manuels WHERE statut = 'attente_validation' ORDER BY updated_at ASC`).all();
  res.json({ manuels: rows.map(publicManuel) });
});

router.post('/admin/:id/approuver', requireAdminKey, (req, res) => {
  const m = db.prepare('SELECT * FROM manuels WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Manuel introuvable.' });
  db.prepare(`UPDATE manuels SET statut = 'livre', updated_at = datetime('now') WHERE id = ?`).run(m.id);
  res.json({ ok: true });
});

router.post('/admin/:id/remplacer', requireAdminKey, upload.single('fichier'), (req, res) => {
  const m = db.prepare('SELECT * FROM manuels WHERE id = ?').get(req.params.id);
  if (!m) { if (req.file) fs.unlinkSync(req.file.path); return res.status(404).json({ error: 'Manuel introuvable.' }); }
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu.' });
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const finalPath = path.join(OUT_DIR, `manuel-${m.id}-corrige.docx`);
  fs.renameSync(req.file.path, finalPath);
  db.prepare(`UPDATE manuels SET statut = 'livre', docx_path = ?, updated_at = datetime('now') WHERE id = ?`).run(finalPath, m.id);
  res.json({ ok: true });
});

router.startGenerationForManuel = startGenerationForManuel;
module.exports = router;
