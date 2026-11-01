// routes/precred.js — TAPA PRE-CRED : demandes d'accompagnement au financement.
//  • POST /api/precred/demande  → public (formulaire court), protégé contre le spam
//  • GET/PATCH /api/precred/admin/... → tableau de bord de l'équipe (clé ADMIN_KEY)
const express = require('express');
const db = require('../db');
const { sendMail } = require('../email');
const core = require('../bo-core');

const router = express.Router();

const BESOINS = [
  'Obtenir un crédit bancaire',
  'Monter un projet / Business Plan',
  'Faire un diagnostic financier',
  'Financer le développement de mon entreprise',
  'Autre besoin d\'accompagnement'
];
const SOURCES = ['accueil', 'synthese-finmodel', 'synthese-business-plan', 'chatbot'];
const DELAI_REPONSE_H = 24;

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function cleanText(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}
function reference(id) { return 'PC-' + String(id).padStart(4, '0'); }

// ---- Garde-fous anti-spam (en mémoire, sans dépendance) : 5 demandes/heure et 15/jour par IP ----
const buckets = new Map(); // ip -> [timestamps]
function recent(ip) { const now = Date.now(); return (buckets.get(ip) || []).filter(t => now - t < 24 * 3600 * 1000); }
function isRateLimited(ip) {
  const list = recent(ip);
  return list.filter(t => Date.now() - t < 3600 * 1000).length >= 5 || list.length >= 15;
}
// On ne compte que les demandes réellement enregistrées : une faute de frappe dans le formulaire ne bloque personne.
function recordHit(ip) { const list = recent(ip); list.push(Date.now()); buckets.set(ip, list); }

// Contexte automatique envoyé depuis la Synthèse : on ne garde que des champs connus, courts.
function sanitizeContexte(c) {
  if (!c || typeof c !== 'object') return null;
  const out = {};
  const num = k => { const v = Number(c[k]); if (isFinite(v)) out[k] = Math.round(v); };
  ['scoreFinancabilite', 'scorePerformance', 'montantProjet', 'effectif', 'ca1', 'creditSollicite'].forEach(num);
  ['classification', 'secteur', 'outil'].forEach(k => { if (typeof c[k] === 'string') out[k] = cleanText(c[k], 80); });
  return Object.keys(out).length ? out : null;
}

router.post('/demande', async (req, res) => {
  const b = req.body || {};
  // Champ piège invisible : un humain ne le remplit jamais, un robot oui. On répond "ok" sans rien enregistrer.
  if (b.website) return res.json({ ok: true, reference: 'PC-0000', delaiHeures: DELAI_REPONSE_H });
  if (isRateLimited(req.ip)) return res.status(429).json({ error: 'Trop de demandes depuis cette connexion. Réessayez un peu plus tard.' });

  const entreprise = cleanText(b.entreprise, 120);
  const responsable = cleanText(b.responsable, 120);
  const telephone = cleanText(b.telephone, 30);
  const email = cleanText(b.email, 120).toLowerCase();
  const disponibilites = cleanText(b.disponibilites, 300);
  const besoin = cleanText(b.besoin, 80);
  const montant = cleanText(b.montant, 40);
  const description = cleanText(b.description, 1500);
  const source = SOURCES.includes(b.source) ? b.source : 'accueil';
  const contexte = sanitizeContexte(b.contexte);

  if (entreprise.length < 2) return res.status(400).json({ error: "Indiquez le nom de votre entreprise ou de votre projet." });
  if (responsable.length < 3) return res.status(400).json({ error: 'Indiquez votre nom et prénom.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ error: "Indiquez une adresse email valide : c'est là que nous enverrons l'invitation Google Meet." });
  if (telephone && (!/^[+0-9 ().-]{8,30}$/.test(telephone) || telephone.replace(/\D/g, '').length < 8)) {
    return res.status(400).json({ error: 'Le numéro de téléphone indiqué semble incorrect (laissez le champ vide si vous préférez).' });
  }
  if (disponibilites.length < 3) return res.status(400).json({ error: 'Indiquez vos disponibilités (jours et heures) pour fixer l\'appel.' });
  if (!BESOINS.includes(besoin)) return res.status(400).json({ error: 'Choisissez votre besoin principal.' });
  if (b.consentement !== true) return res.status(400).json({ error: 'Merci de cocher la case de consentement pour que nous puissions vous contacter.' });

  // Doublon : même téléphone + même entreprise dans les 15 dernières minutes → on renvoie la demande existante.
  const dup = db.prepare(`SELECT id FROM demandes_precred WHERE email = ? AND entreprise = ? AND created_at > datetime('now','-15 minutes')`).get(email, entreprise);
  if (dup) return res.json({ ok: true, reference: reference(dup.id), delaiHeures: DELAI_REPONSE_H });

  const info = db.prepare(`INSERT INTO demandes_precred (entreprise, responsable, telephone, email, disponibilites, besoin, montant, description, source, contexte, consentement)
    VALUES (?,?,?,?,?,?,?,?,?,?,1)`).run(entreprise, responsable, telephone, email, disponibilites, besoin, montant || null, description || null, source, contexte ? JSON.stringify(contexte) : null);
  recordHit(req.ip);
  core.ensureToken(info.lastInsertRowid);
  try { // si la personne a un compte, on note l'événement dans son parcours
    const u = db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(email);
    if (u) db.prepare("INSERT INTO evenements (user_id, produit, type, detail) VALUES (?, 'pre-cred', 'demande', ?)").run(u.id, source);
  } catch (e) {}
  const ref = reference(info.lastInsertRowid);

  // Notification à l'équipe (n'empêche jamais l'enregistrement si l'email échoue).
  const notify = process.env.PRECRED_NOTIFY_EMAIL || 'formationella398@gmail.com';
  const ctxHtml = contexte ? `<p><b>Contexte du dossier (depuis la Synthèse) :</b><br>${Object.entries(contexte).map(([k, v]) => esc(k) + ' : ' + esc(v)).join('<br>')}</p>` : '';
  sendMail({
    to: notify,
    subject: `Nouvelle demande TAPA PRE-CRED ${ref} — ${entreprise}`,
    html: `<p><b>Nouvelle demande d'accompagnement ${esc(ref)}</b> (à contacter sous ${DELAI_REPONSE_H} h pour fixer un appel Google Meet)</p>
      <p><b>Entreprise / projet :</b> ${esc(entreprise)}<br><b>Responsable :</b> ${esc(responsable)}<br>
      <b>Email :</b> ${esc(email)}<br><b>Téléphone :</b> ${esc(telephone || '—')}<br><b>Disponibilités pour l'appel :</b> ${esc(disponibilites)}<br><b>Besoin :</b> ${esc(besoin)}<br>
      <b>Montant souhaité :</b> ${esc(montant || '—')}<br><b>Source :</b> ${esc(source)}</p>
      <p><b>Description :</b><br>${esc(description || '—').replace(/\n/g, '<br>')}</p>${ctxHtml}`
  }).catch(e => console.error('[precred] notification email échouée :', e.message));

  // Accusé de réception au client (maintenant possible : on a son email).
  sendMail({
    to: email,
    subject: `Votre demande TAPA PRE-CRED ${ref} est bien reçue`,
    html: `<p>Bonjour ${esc(responsable)},</p>
      <p>Merci, nous avons bien reçu votre demande d'accompagnement (référence <b>${esc(ref)}</b>) pour <b>${esc(entreprise)}</b>.</p>
      <p>Un conseiller TAPA CONSEIL vous écrira sous ${DELAI_REPONSE_H} h pour fixer avec vous un appel en visioconférence (Google Meet), en tenant compte de vos disponibilités :<br><i>${esc(disponibilites)}</i></p>
      <p>TAPA CONSEIL vous aide à préparer et structurer votre dossier de financement ; la décision finale appartient à l'établissement financier.</p>
      <p>À très bientôt,<br>L'équipe TAPA CONSEIL</p>`
  }).catch(e => console.error('[precred] accusé de réception échoué :', e.message));

  res.json({ ok: true, reference: ref, delaiHeures: DELAI_REPONSE_H });
});


// Lien « ne plus recevoir de relances » présent dans chaque email envoyé au client.
router.get('/stop/:token', (req, res) => {
  const row = db.prepare('SELECT id FROM demandes_precred WHERE token = ?').get(String(req.params.token || ''));
  let msg = "Ce lien n'est plus valide.";
  if (row) {
    db.prepare('UPDATE demandes_precred SET relances_ok = 0 WHERE id = ?').run(row.id);
    db.prepare("UPDATE relances SET statut = 'annulee' WHERE demande_id = ? AND type = 'email' AND statut = 'a_faire'").run(row.id);
    msg = "C'est noté : vous ne recevrez plus de relances de notre part pour cette demande.";
  }
  res.set('Content-Type', 'text/html; charset=utf-8').send(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TAPA CONSEIL</title></head><body style="font-family:sans-serif;background:#F7F4EC;color:#241F14;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0"><div style="background:#fff;border:1px solid #DCD5C2;padding:32px;max-width:440px;text-align:center"><h2 style="color:#0A1B3D;font-family:Georgia,serif">TAPA CONSEIL</h2><p>${msg}</p></div></body></html>`);
});

module.exports = router;
