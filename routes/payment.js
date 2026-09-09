// routes/payment.js — intégration Paiement Pro (paiementpro.net)
// Docs constructeur : https://paiementpro.net/api-php
//
// Ce backend sert plusieurs produits distincts (fichiers frontend séparés, un seul compte/backend) :
//   - "finmodel"      → TAPA FinModel (paiement à l'usage : 1er dossier / mise à jour)
//   - "business-plan" → Établir votre Business Plan (prix fixe, pas de distinction 1er/mise à jour pour l'instant)
//   - "procedures"    → TAPA Procédures (paiement à l'unité par manuel, voir routes/procedures.js)
// Le frontend envoie `product` dans le corps de la requête pour indiquer lequel il facture.
//
// ⚠️ IMPORTANT AVANT LA MISE EN PRODUCTION : la formule de vérification du "hashcode" renvoyé par
// Paiement Pro sur le webhook n'est documentée que dans l'espace marchand connecté. Tant qu'elle
// n'est pas confirmée ici (voir verifyHashcode), la sécurité repose uniquement sur la correspondance
// référence + montant avec un paiement que nous avons nous-mêmes initié.
const express = require('express');
const fetch = require('node-fetch');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { methodsForCountry, codeFor, currencyFor } = require('../channels');

const router = express.Router();

const PAIEMENTPRO_INIT_URL = process.env.PAIEMENTPRO_MODE === 'live'
  ? 'https://www.paiementpro.net/webservice/onlinepayment/init/curl-init.php'
  : 'https://sandbox.paiementpro.net/webservice/onlinepayment/init/curl-init.php';

const ACCESS_DAYS = parseInt(process.env.ACCESS_DAYS || '30', 10);
const { tarifBusinessPlan, tarifFinModel, tarifPackCreation } = require('../pricing');

function verifyHashcode(/* payload */) {
  // TODO : implémenter la vérification officielle dès qu'elle est confirmée par Paiement Pro.
  return true;
}

// Le montant du projet est lu directement dans le dossier déjà rempli par le client (champ
// "montant" de la Fiche Entreprise, le crédit/financement demandé) — jamais une question posée
// séparément, pour qu'un client ne puisse pas minimiser son tarif sans aussi fausser son propre
// dossier (celui qu'il présente ensuite à sa banque).
function montantDuDossier(userId) {
  const row = db.prepare('SELECT data FROM dossiers WHERE user_id = ?').get(userId);
  if (!row) return 0;
  try {
    const data = JSON.parse(row.data);
    return Number(data?.fiche?.montant) || 0;
  } catch (e) {
    return 0;
  }
}

function accessColumnFor(product) {
  return product === 'business-plan' ? 'businessplan_access_expires_at' : 'finmodel_access_expires_at';
}
function isActive(user, product) {
  const expiresAt = user[accessColumnFor(product)];
  return !!expiresAt && new Date(expiresAt) > new Date();
}

// Détermine le montant et le palier facturé selon le produit et le vrai montant du dossier.
function priceFor(user, product) {
  const montant = montantDuDossier(user.id);
  if (product === 'business-plan') {
    const t = tarifBusinessPlan(montant);
    return { ...t, kind: 'business-plan', montant };
  }
  const t = tarifFinModel(montant, isActive(user, 'finmodel') || user.has_paid_before);
  return { ...t, montant };
}

router.get('/price', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'Compte introuvable.' });
  const product = req.query.product === 'business-plan' ? 'business-plan' : 'finmodel';
  const active = isActive(user, product);
  res.json({ ...priceFor(user, product), active, accessExpiresAt: user[accessColumnFor(product)] });
});

router.get('/methods', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'Compte introuvable.' });
  res.json({ country: user.country, methods: methodsForCountry(user.country).map(({key,label,confirmed})=>({key,label,confirmed})) });
});

// Pack Création — FinModel + Business Plan en un seul paiement, à prix réduit. Un seul pack existe
// pour l'instant (V1) ; les packs Entreprise/Pro/Financement (avec TAPA Procédures et relecture
// humaine) demandent une intégration plus large, pas encore construite.
router.get('/pack/price', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'Compte introuvable.' });
  const montant = montantDuDossier(user.id);
  const tarif = tarifPackCreation(montant);
  const bothActive = isActive(user, 'finmodel') && isActive(user, 'business-plan');
  res.json({ ...tarif, montant, alreadyActive: bothActive });
});

router.post('/pack/init', requireAuth, async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'Compte introuvable.' });

  const bothActive = isActive(user, 'finmodel') && isActive(user, 'business-plan');
  if (bothActive) return res.json({ alreadyActive: true });

  const montant = montantDuDossier(user.id);
  const tarif = tarifPackCreation(montant);
  if (tarif.surDevis) {
    return res.status(200).json({ surDevis: true, message: "Votre projet dépasse le seuil géré automatiquement pour le Pack Création — contactez-nous pour un devis." });
  }

  const { amount, label } = tarif;
  const reference = `PACK-CREATION-${user.id}-${Date.now()}`;
  const channelKey = req.body?.channel;
  const channelCode = channelKey ? codeFor(user.country, channelKey) : null;
  if (!channelCode) {
    return res.status(400).json({ error: "Ce moyen de paiement n'est pas encore activé. Choisissez un autre Mobile Money ou contactez le support." });
  }

  db.prepare(
    `INSERT INTO payments (user_id, reference, product, kind, amount, status, palier) VALUES (?, ?, 'pack-creation', 'pack-creation', ?, 'pending', ?)`
  ).run(user.id, reference, amount, label);

  const payload = {
    merchantId: process.env.PAIEMENTPRO_MERCHANT_ID,
    amount,
    description: "Pack Création (FinModel + Business Plan) — TAPA CONSEIL",
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
    res.json({ url: data.url, reference, amount });
  } catch (err) {
    console.error('Erreur init Paiement Pro (pack):', err);
    res.status(502).json({ error: 'Impossible de contacter le service de paiement pour le moment.' });
  }
});

router.post('/init', requireAuth, async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'Compte introuvable.' });

  const product = req.body?.product === 'business-plan' ? 'business-plan' : 'finmodel';
  const active = isActive(user, product);
  if (active) return res.json({ alreadyActive: true });

  const tarif = priceFor(user, product);
  if (tarif.surDevis) {
    return res.status(200).json({
      surDevis: true,
      label: tarif.label,
      message: "Votre projet dépasse le seuil géré automatiquement — nous devons établir un devis personnalisé avec vous.",
    });
  }

  const { amount, kind, label } = tarif;
  const reference = `${product.toUpperCase()}-${user.id}-${Date.now()}`;
  const channelKey = req.body?.channel;
  const channelCode = channelKey ? codeFor(user.country, channelKey) : null;
  if (!channelCode) {
    return res.status(400).json({ error: "Ce moyen de paiement n'est pas encore activé. Choisissez un autre Mobile Money ou contactez le support." });
  }

  db.prepare(
    `INSERT INTO payments (user_id, reference, product, kind, amount, status, palier) VALUES (?, ?, ?, ?, ?, 'pending', ?)`
  ).run(user.id, reference, product, kind, amount, label);

  const payload = {
    merchantId: process.env.PAIEMENTPRO_MERCHANT_ID,
    amount,
    description: product === 'business-plan'
      ? "Établir votre Business Plan — TAPA CONSEIL"
      : (kind === 'first' ? "Création du dossier TAPA FinModel — TAPA CONSEIL" : "Mise à jour du dossier TAPA FinModel — TAPA CONSEIL"),
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
    if (!data.success) {
      return res.status(502).json({ error: data.message || "Échec de l'initialisation du paiement." });
    }
    res.json({ url: data.url, reference, amount, kind });
  } catch (err) {
    console.error('Erreur init Paiement Pro:', err);
    res.status(502).json({ error: 'Impossible de contacter le service de paiement pour le moment.' });
  }
});

router.post('/notify', express.json(), async (req, res) => {
  const body = req.body || {};
  const reference = body.referenceNumber;
  const responsecode = String(body.responsecode);

  const payment = db.prepare('SELECT * FROM payments WHERE reference = ?').get(reference);
  if (!payment) {
    console.warn('Notification Paiement Pro pour une référence inconnue:', reference);
    return res.sendStatus(200);
  }
  if (!verifyHashcode(body)) {
    console.error('Hashcode invalide pour la référence', reference);
    return res.sendStatus(200);
  }

  const amountMatches = Number(body.amount) === payment.amount;
  const status = (responsecode === '0' && amountMatches) ? 'success' : 'failed';

  db.prepare(`UPDATE payments SET status = ?, provider_payload = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(status, JSON.stringify(body), payment.id);

  if (status === 'success') {
    if (payment.product === 'procedures') {
      try {
        const proceduresRouter = require('./procedures');
        await proceduresRouter.startGenerationForManuel(payment.manuel_id);
      } catch (err) {
        console.error('Erreur déclenchement génération manuel:', err);
      }
    } else if (payment.product === 'pack-creation') {
      const expiresAt = new Date(Date.now() + ACCESS_DAYS * 24 * 60 * 60 * 1000).toISOString();
      db.prepare(`UPDATE users SET has_paid_before = 1, finmodel_access_expires_at = ?, businessplan_access_expires_at = ? WHERE id = ?`)
        .run(expiresAt, expiresAt, payment.user_id);
    } else {
      const expiresAt = new Date(Date.now() + ACCESS_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const colonne = accessColumnFor(payment.product);
      db.prepare(`UPDATE users SET has_paid_before = 1, ${colonne} = ? WHERE id = ?`).run(expiresAt, payment.user_id);
    }
  }
  res.sendStatus(200);
});

router.get('/status/:reference', requireAuth, (req, res) => {
  const payment = db.prepare('SELECT * FROM payments WHERE reference = ? AND user_id = ?')
    .get(req.params.reference, req.userId);
  if (!payment) return res.status(404).json({ error: 'Paiement introuvable.' });
  res.json({ status: payment.status });
});

module.exports = router;
