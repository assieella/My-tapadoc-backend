// routes/backoffice.js — API du back office TAPA (toutes les routes sont protégées par ADMIN_KEY).
const express = require('express');
const db = require('../db');
const core = require('../bo-core');
const google = require('../google');
const { sendMail } = require('../email');
const { requireAdminKey } = require('../middleware/admin');

const router = express.Router();
router.use(requireAdminKey);

const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
const ref = id => 'PC-' + String(id).padStart(4, '0');
const PRODUITS = [
  { id: 'finmodel', label: 'TAPA FinModel', pay: ['finmodel', 'precred'] },
  { id: 'business-plan', label: 'Business Plan', pay: ['business-plan'] },
  { id: 'procedures', label: 'TAPA Procédures', pay: ['procedures'] }
];

function parseCtx(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }
function userByEmail(email) { return email ? db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(String(email).toLowerCase()) : null; }

// ------------------------------- Vue d'ensemble -------------------------------
router.get('/overview', (req, res) => {
  const now = new Date(), nowSql = core.toSql(now), finJour = nowSql.slice(0, 10) + ' 23:59:59';
  const parStatut = {}; core.STATUTS.forEach(s => parStatut[s] = 0);
  db.prepare('SELECT statut, COUNT(*) AS n FROM demandes_precred GROUP BY statut').all().forEach(r => { if (parStatut[r.statut] !== undefined) parStatut[r.statut] = r.n; });
  const enRetard = db.prepare(`SELECT COUNT(*) AS n FROM demandes_precred WHERE statut = 'nouvelle' AND created_at <= ?`).get(core.toSql(new Date(now.getTime() - 24 * 3600 * 1000))).n;
  const rdvAVenir = db.prepare(`SELECT COUNT(*) AS n FROM rendez_vous WHERE statut = 'planifie' AND debut >= ?`).get(nowSql).n;
  const rdvSansLien = db.prepare(`SELECT COUNT(*) AS n FROM rendez_vous WHERE statut = 'planifie' AND debut >= ? AND (lien_meet IS NULL OR lien_meet = '')`).get(nowSql).n;
  const relancesRetard = db.prepare(`SELECT COUNT(*) AS n FROM relances WHERE statut = 'a_faire' AND type = 'interne' AND due_at < ?`).get(nowSql).n;
  const relancesJour = db.prepare(`SELECT COUNT(*) AS n FROM relances WHERE statut = 'a_faire' AND type = 'interne' AND due_at >= ? AND due_at <= ?`).get(nowSql, finJour).n;
  const emailsEnAttente = db.prepare(`SELECT COUNT(*) AS n FROM relances WHERE statut = 'a_faire' AND type = 'email'`).get().n;
  const emailsEchec = db.prepare(`SELECT COUNT(*) AS n FROM relances WHERE statut = 'echec'`).get().n;
  const comptes = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const payes = db.prepare('SELECT COUNT(*) AS n FROM users WHERE has_paid_before = 1').get().n;
  const revenu = db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE status = 'success'`).get().s;
  res.json({ parStatut, statutLabels: core.STATUT_LABELS, enRetard, rdvAVenir, rdvSansLien, relancesRetard, relancesJour, emailsEnAttente, emailsEchec, comptes, payes, revenu, google: google.status() });
});

// ------------------------------- Demandes -------------------------------
function enrichir(d, nowSql) {
  const u = userByEmail(d.email);
  const rdv = db.prepare(`SELECT id, debut, lien_meet, statut FROM rendez_vous WHERE demande_id = ? AND statut = 'planifie' AND debut >= ? ORDER BY debut LIMIT 1`).get(d.id, nowSql);
  const nbRelances = db.prepare(`SELECT COUNT(*) AS n FROM relances WHERE demande_id = ? AND statut = 'a_faire'`).get(d.id).n;
  const ageH = (Date.now() - core.parseSql(d.created_at).getTime()) / 3600000;
  return { ...d, token: undefined, reference: ref(d.id), contexte: parseCtx(d.contexte), userId: u ? u.id : null, prochainRdv: rdv || null, relancesEnCours: nbRelances, enRetard: d.statut === 'nouvelle' && ageH > 24 };
}

router.get('/demandes', (req, res) => {
  const nowSql = core.toSql(new Date());
  const rows = db.prepare('SELECT * FROM demandes_precred ORDER BY id DESC LIMIT 500').all();
  res.json({ demandes: rows.map(d => enrichir(d, nowSql)), statuts: core.STATUTS, statutLabels: core.STATUT_LABELS });
});

router.get('/demandes/:id', (req, res) => {
  const d = db.prepare('SELECT * FROM demandes_precred WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!d) return res.status(404).json({ error: 'Demande introuvable.' });
  const nowSql = core.toSql(new Date());
  const u = userByEmail(d.email);
  const rdvs = db.prepare('SELECT * FROM rendez_vous WHERE demande_id = ? ORDER BY debut DESC').all(d.id);
  const relances = db.prepare('SELECT * FROM relances WHERE demande_id = ? ORDER BY due_at').all(d.id);
  const parcours = u ? db.prepare('SELECT created_at, produit, type, detail FROM evenements WHERE user_id = ? ORDER BY id DESC LIMIT 60').all(u.id) : [];
  res.json({ demande: enrichir(d, nowSql), rdvs, relances, compte: u ? { id: u.id, email: u.email, nom_entreprise: u.nom_entreprise, created_at: u.created_at, email_verified: u.email_verified, has_paid_before: u.has_paid_before } : null, parcours });
});

router.patch('/demandes/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT * FROM demandes_precred WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Demande introuvable.' });
  const b = req.body || {};
  const statut = b.statut !== undefined ? b.statut : row.statut;
  if (!core.STATUTS.includes(statut)) return res.status(400).json({ error: 'Statut inconnu.' });
  const notes = b.notes !== undefined ? clean(b.notes, 4000) : row.notes;
  const motif = b.motif_sans_suite !== undefined ? clean(b.motif_sans_suite, 300) : row.motif_sans_suite;
  const assigne = b.assigne_a !== undefined ? clean(b.assigne_a, 80) : row.assigne_a;
  db.prepare(`UPDATE demandes_precred SET statut=?, notes=?, motif_sans_suite=?, assigne_a=?, updated_at=datetime('now') WHERE id=?`).run(statut, notes, motif, assigne, id);
  if (statut !== row.statut) {
    const d = db.prepare('SELECT * FROM demandes_precred WHERE id = ?').get(id);
    if (statut === 'proposition_envoyee') core.autoRelancesPourStatut(d, statut);
    if (statut === 'sans_suite' || statut === 'termine') core.annulerRelancesDemande(id);
    if (statut === 'client_confirme') db.prepare(`UPDATE relances SET statut='annulee' WHERE demande_id = ? AND modele = 'proposition_j3' AND statut = 'a_faire'`).run(id);
  }
  res.json({ ok: true });
});

// ------------------------------- Rendez-vous -------------------------------
router.get('/rdv', (req, res) => {
  const nowSql = core.toSql(new Date());
  const per = req.query.periode === 'passes' ? 'passes' : req.query.periode === 'tous' ? 'tous' : 'a_venir';
  const where = per === 'a_venir' ? `v.debut >= '${nowSql}' AND v.statut = 'planifie'` : per === 'passes' ? `(v.debut < '${nowSql}' OR v.statut != 'planifie')` : '1=1';
  const rows = db.prepare(`SELECT v.*, d.responsable, d.entreprise, d.email, d.telephone FROM rendez_vous v JOIN demandes_precred d ON d.id = v.demande_id WHERE ${where} ORDER BY v.debut ${per === 'a_venir' ? 'ASC' : 'DESC'} LIMIT 300`).all();
  res.json({ rdvs: rows.map(r => ({ ...r, reference: ref(r.demande_id) })) });
});

router.post('/demandes/:id/rdv', async (req, res) => {
  const d = db.prepare('SELECT * FROM demandes_precred WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!d) return res.status(404).json({ error: 'Demande introuvable.' });
  const b = req.body || {};
  const debut = core.normalizeSql(b.debut);
  if (!debut) return res.status(400).json({ error: 'Date et heure invalides.' });
  const duree = Math.min(240, Math.max(10, parseInt(b.duree_min, 10) || 30));
  let lien = clean(b.lien_meet, 300) || null, eventId = null, avertissement = null;

  if (b.google) {
    if (!google.status().connected) return res.status(400).json({ error: "Google Agenda n'est pas connecté (onglet Google Agenda)." });
    if (!d.email) return res.status(400).json({ error: "Cette demande n'a pas d'email : impossible d'envoyer l'invitation Google." });
    try {
      const m = await google.createMeeting({
        titre: `TAPA CONSEIL — ${d.entreprise} (${d.responsable})`,
        description: `Appel de découverte TAPA PRE-CRED — ${ref(d.id)}\nBesoin : ${d.besoin}${d.montant ? '\nMontant souhaité : ' + d.montant : ''}`,
        debutSql: debut, dureeMin: duree, attendeeEmail: d.email
      });
      eventId = m.eventId; lien = m.meetLink || lien;
    } catch (e) { return res.status(502).json({ error: e.message }); }
  }
  const info = db.prepare(`INSERT INTO rendez_vous (demande_id, debut, duree_min, lien_meet, google_event_id) VALUES (?,?,?,?,?)`).run(d.id, debut, duree, lien, eventId);
  const rdv = db.prepare('SELECT * FROM rendez_vous WHERE id = ?').get(info.lastInsertRowid);
  core.creerRelancesRdv(rdv, d);
  if (['nouvelle', 'a_contacter', 'a_relancer'].includes(d.statut)) db.prepare(`UPDATE demandes_precred SET statut='rdv_planifie', updated_at=datetime('now') WHERE id=?`).run(d.id);

  // Sans Google : si un lien est fourni et que le client a un email, on lui envoie nous-mêmes la confirmation.
  if (!eventId && lien && d.email && d.relances_ok !== 0) {
    sendMail({ to: d.email, subject: `Confirmation de votre rendez-vous TAPA CONSEIL ${core.fmtFr(debut)}`, html: `<p>Bonjour ${core.esc(d.responsable)},</p><p>Notre appel en visioconférence est confirmé : <b>${core.esc(core.fmtFr(debut))}</b> (heure d'Abidjan), durée ${duree} min.</p><p><a href="${core.esc(lien)}" style="background:#C9A227;color:#0A1B3D;padding:10px 18px;text-decoration:none;font-weight:bold;border-radius:3px;">Rejoindre l'appel Google Meet</a></p>` })
      .catch(e => console.error('[bo] confirmation RDV non envoyée :', e.message));
  }
  if (!lien) avertissement = "Rendez-vous créé sans lien Google Meet : ajoutez-le dès que possible, les rappels au client en dépendent.";
  res.json({ ok: true, id: rdv.id, lien_meet: lien, google: !!eventId, avertissement });
});

router.patch('/rdv/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = db.prepare('SELECT * FROM rendez_vous WHERE id = ?').get(id);
  if (!r) return res.status(404).json({ error: 'Rendez-vous introuvable.' });
  const b = req.body || {};
  const statut = b.statut !== undefined ? b.statut : r.statut;
  if (!['planifie', 'realise', 'annule', 'absent'].includes(statut)) return res.status(400).json({ error: 'Statut inconnu.' });
  const debut = b.debut !== undefined ? core.normalizeSql(b.debut) : r.debut;
  if (!debut) return res.status(400).json({ error: 'Date et heure invalides.' });
  const duree = b.duree_min !== undefined ? Math.min(240, Math.max(10, parseInt(b.duree_min, 10) || r.duree_min)) : r.duree_min;
  const lien = b.lien_meet !== undefined ? clean(b.lien_meet, 300) : r.lien_meet;
  const notes = b.notes !== undefined ? clean(b.notes, 2000) : r.notes;
  let eventId = r.google_event_id, avert = null;

  if (eventId && google.status().connected) {
    try {
      if (statut === 'annule') { await google.cancelMeeting(eventId); eventId = null; }
      else if (debut !== r.debut || duree !== r.duree_min) await google.updateMeeting(eventId, { debutSql: debut, dureeMin: duree });
    } catch (e) { avert = "Le rendez-vous est modifié ici, mais Google Agenda n'a pas pu être mis à jour : " + e.message; }
  }
  db.prepare(`UPDATE rendez_vous SET statut=?, debut=?, duree_min=?, lien_meet=?, notes=?, google_event_id=?, updated_at=datetime('now') WHERE id=?`).run(statut, debut, duree, lien, notes, eventId, id);

  if (statut !== 'planifie') core.annulerRelancesRdv(id);
  else if (debut !== r.debut) { // nouvelle heure : on refait les rappels
    core.annulerRelancesRdv(id);
    const d = db.prepare('SELECT * FROM demandes_precred WHERE id = ?').get(r.demande_id);
    core.creerRelancesRdv({ ...r, debut }, d);
  }
  res.json({ ok: true, avertissement: avert });
});

// ------------------------------- Relances -------------------------------
router.get('/relances', (req, res) => {
  const now = new Date(), nowSql = core.toSql(now), finJour = nowSql.slice(0, 10) + ' 23:59:59';
  const f = req.query.filtre || 'a_faire';
  let where = '1=1';
  if (f === 'retard') where = `r.statut = 'a_faire' AND r.due_at < '${nowSql}'`;
  else if (f === 'aujourdhui') where = `r.statut = 'a_faire' AND r.due_at <= '${finJour}'`;
  else if (f === 'a_faire') where = `r.statut = 'a_faire'`;
  else if (f === 'terminees') where = `r.statut IN ('fait','envoyee','annulee','echec')`;
  const rows = db.prepare(`SELECT r.*, d.responsable, d.entreprise, d.email, u.email AS user_email, u.nom_entreprise AS user_entreprise FROM relances r
    LEFT JOIN demandes_precred d ON d.id = r.demande_id LEFT JOIN users u ON u.id = r.user_id WHERE ${where}
    ORDER BY ${f === 'terminees' ? 'r.id DESC' : 'r.due_at ASC'} LIMIT 300`).all();
  res.json({ relances: rows.map(r => ({ ...r, enRetard: r.statut === 'a_faire' && r.due_at < nowSql })) });
});

router.post('/relances', (req, res) => {
  const b = req.body || {};
  const due = core.normalizeSql(b.due_at);
  if (!due) return res.status(400).json({ error: 'Date et heure invalides.' });
  const type = b.type === 'email' ? 'email' : 'interne';
  const titre = clean(b.titre, 200);
  if (titre.length < 3) return res.status(400).json({ error: 'Donnez un titre à la relance.' });
  const demande_id = b.demande_id ? parseInt(b.demande_id, 10) : null;
  const user_id = b.user_id ? parseInt(b.user_id, 10) : null;
  if (!demande_id && !user_id) return res.status(400).json({ error: 'Choisissez la personne concernée.' });
  if (type === 'email') {
    const d = demande_id ? db.prepare('SELECT * FROM demandes_precred WHERE id = ?').get(demande_id) : null;
    if (!d || !d.email) return res.status(400).json({ error: "Une relance par email nécessite une demande avec une adresse email." });
    if (clean(b.message, 4000).length < 5) return res.status(400).json({ error: "Écrivez le message à envoyer au client." });
  }
  const id = core.addRelance({ demande_id, user_id, type, titre, message: clean(b.message, 4000) || null, due_at: due });
  res.json({ ok: true, id });
});

router.patch('/relances/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = db.prepare('SELECT * FROM relances WHERE id = ?').get(id);
  if (!r) return res.status(404).json({ error: 'Relance introuvable.' });
  const b = req.body || {};
  const statut = b.statut !== undefined ? b.statut : r.statut;
  if (!['a_faire', 'fait', 'annulee'].includes(statut)) return res.status(400).json({ error: 'Statut inconnu.' });
  const due = b.due_at !== undefined ? core.normalizeSql(b.due_at) : r.due_at;
  if (!due) return res.status(400).json({ error: 'Date et heure invalides.' });
  const titre = b.titre !== undefined ? clean(b.titre, 200) : r.titre;
  const message = b.message !== undefined ? clean(b.message, 4000) : r.message;
  db.prepare(`UPDATE relances SET statut=?, due_at=?, titre=?, message=?, erreur=NULL, done_at = CASE WHEN ? = 'fait' THEN datetime('now') ELSE done_at END WHERE id=?`).run(statut, due, titre, message, statut, id);
  res.json({ ok: true });
});

// ------------------------------- Parcours par service -------------------------------
function parcoursParPersonne() {
  const evts = db.prepare('SELECT user_id, produit, type, detail, created_at FROM evenements ORDER BY id').all();
  const map = new Map(); // user_id -> produit -> état
  evts.forEach(e => {
    if (!map.has(e.user_id)) map.set(e.user_id, {});
    const p = map.get(e.user_id);
    const s = p[e.produit] || (p[e.produit] = { ouvert: false, etape: null, paywall: false, clic: false, dernier: null });
    if (e.type === 'open' || e.type === 'screen' || e.type === 'step' || e.type === 'cta') s.ouvert = true;
    if (e.type === 'step' && e.detail) s.etape = e.detail;
    if (e.type === 'paywall') s.paywall = true;
    if (e.type === 'pay_click') s.clic = true;
    s.dernier = e.created_at;
  });
  return map;
}
function statutParcours(s, paye) {
  if (paye) return 'Payé';
  if (!s) return 'Pas ouvert';
  if (s.clic) return 'A cliqué sur Payer (paiement non terminé)';
  if (s.paywall) return 'A vu la page de paiement';
  if (s.etape) return 'S\'est arrêté à : ' + s.etape;
  if (s.ouvert) return 'A ouvert l\'outil';
  return 'Pas ouvert';
}

router.get('/parcours', (req, res) => {
  const map = parcoursParPersonne();
  const paidRows = db.prepare(`SELECT DISTINCT user_id, product FROM payments WHERE status = 'success'`).all();
  const services = PRODUITS.map(pr => {
    const paid = new Set(paidRows.filter(r => pr.pay.includes(r.product)).map(r => r.user_id));
    let ouvert = 0, paywall = 0, clic = 0; const arrets = {};
    map.forEach((p, uid) => {
      const s = p[pr.id]; if (!s || !s.ouvert) return;
      ouvert++; if (s.paywall) paywall++; if (s.clic) clic++;
      const lab = paid.has(uid) ? 'Payé' : statutParcours(s, false).replace("S'est arrêté à : ", '');
      arrets[lab] = (arrets[lab] || 0) + 1;
    });
    return { id: pr.id, label: pr.label, ouvert, paywall, clic, payes: paid.size, arrets: Object.entries(arrets).sort((a, b) => b[1] - a[1]).map(([etape, n]) => ({ etape, n })) };
  });
  const dem = db.prepare('SELECT statut, COUNT(*) AS n FROM demandes_precred GROUP BY statut').all();
  const total = dem.reduce((a, r) => a + r.n, 0);
  const get = k => (dem.find(r => r.statut === k) || { n: 0 }).n;
  const sources = db.prepare('SELECT source, COUNT(*) AS n FROM demandes_precred GROUP BY source ORDER BY n DESC').all();
  const comptes = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const verifies = db.prepare('SELECT COUNT(*) AS n FROM users WHERE email_verified = 1').get().n;
  res.json({ comptes, verifies, services, preCred: { demandes: total, rdvPlanifie: db.prepare(`SELECT COUNT(DISTINCT demande_id) AS n FROM rendez_vous`).get().n, clientsConfirmes: get('client_confirme'), sansSuite: get('sans_suite'), sources } });
});

router.get('/parcours/personnes', (req, res) => {
  const filtre = PRODUITS.find(p => p.id === req.query.produit);
  const map = parcoursParPersonne();
  const paid = db.prepare(`SELECT DISTINCT user_id, product FROM payments WHERE status = 'success'`).all();
  const users = db.prepare('SELECT * FROM users ORDER BY id DESC LIMIT 500').all();
  const demandes = db.prepare('SELECT id, lower(email) AS email, statut FROM demandes_precred WHERE email IS NOT NULL').all();
  const out = [];
  users.forEach(u => {
    const p = map.get(u.id) || {};
    const lignes = PRODUITS.map(pr => {
      const paye = paid.some(x => x.user_id === u.id && pr.pay.includes(x.product));
      const s = p[pr.id];
      return { produit: pr.id, label: pr.label, etat: statutParcours(s, paye), paye, dernier: s ? s.dernier : null, ouvert: !!(s && s.ouvert) || paye };
    });
    if (filtre && !lignes.find(l => l.produit === filtre.id).ouvert) return;
    const dem = demandes.find(d => d.email === String(u.email).toLowerCase());
    out.push({ userId: u.id, email: u.email, entreprise: u.nom_entreprise, telephone: u.phone, creeLe: u.created_at, verifie: !!u.email_verified, lignes, demandeId: dem ? dem.id : null, demandeStatut: dem ? dem.statut : null });
  });
  res.json({ personnes: out });
});

// ------------------------------- Google Agenda -------------------------------
router.get('/google/status', (req, res) => res.json(google.status()));
router.post('/google/connect', (req, res) => {
  if (!google.configured()) return res.status(400).json({ error: "GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET ne sont pas encore configurés sur Railway (voir le guide)." });
  const base = (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host');
  res.json({ url: google.authUrl(base), redirectUri: google.redirectUri(base) });
});
router.post('/google/disconnect', (req, res) => { google.disconnect(); res.json({ ok: true }); });

module.exports = router;
