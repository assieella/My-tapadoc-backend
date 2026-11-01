// bo-core.js — logique partagée du back office : dates, modèles d'emails, création des relances automatiques.
const crypto = require('crypto');
const db = require('./db');

const STATUTS = ['nouvelle', 'a_contacter', 'rdv_planifie', 'diagnostic_propose', 'proposition_envoyee', 'a_relancer', 'client_confirme', 'termine', 'sans_suite'];
const STATUT_LABELS = {
  nouvelle: 'Nouvelle demande', a_contacter: 'À contacter', rdv_planifie: 'Rendez-vous planifié', diagnostic_propose: 'Diagnostic proposé',
  proposition_envoyee: 'Proposition envoyée', a_relancer: 'À relancer', client_confirme: 'Client confirmé', termine: 'Dossier terminé', sans_suite: 'Sans suite'
};

// ---- Dates : tout est stocké en UTC "YYYY-MM-DD HH:MM:SS" (Abidjan = UTC+0, donc identique à l'heure locale) ----
const toSql = d => new Date(d).toISOString().slice(0, 19).replace('T', ' ');
const parseSql = s => new Date(String(s).replace(' ', 'T') + 'Z');
function normalizeSql(input) { // accepte "2026-11-05T15:00" ou "2026-11-05 15:00[:00]"
  const m = String(input || '').trim().match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?/);
  return m ? `${m[1]} ${m[2]}:${m[3] || '00'}` : null;
}
function fmtFr(sql) {
  return new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).format(parseSql(sql));
}

function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function baseUrl() { return (process.env.BASE_URL || process.env.FRONTEND_URL || '').replace(/\/$/, ''); }

// Jeton de désinscription propre à chaque demande (lien « ne plus recevoir de relances » dans les emails).
function ensureToken(demandeId) {
  const row = db.prepare('SELECT token FROM demandes_precred WHERE id = ?').get(demandeId);
  if (row && row.token) return row.token;
  const t = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE demandes_precred SET token = ? WHERE id = ?').run(t, demandeId);
  return t;
}
function stopUrl(demandeId) { return baseUrl() + '/api/precred/stop/' + ensureToken(demandeId); }

function footer(demande) {
  return `<p style="font-size:12px;color:#6b6455;margin-top:24px;border-top:1px solid #ddd;padding-top:10px;">TAPA CONSEIL — « L'Intelligence Financière Pour Tous ». Vous ne souhaitez plus recevoir de relances ? <a href="${esc(stopUrl(demande.id))}">Cliquez ici</a>.</p>`;
}
function meetBlock(rdv) {
  return rdv.lien_meet
    ? `<p><a href="${esc(rdv.lien_meet)}" style="background:#C9A227;color:#0A1B3D;padding:10px 18px;text-decoration:none;font-weight:bold;border-radius:3px;">Rejoindre l'appel Google Meet</a></p><p style="font-size:12px;color:#6b6455;">Lien : ${esc(rdv.lien_meet)}</p>`
    : `<p>Le lien Google Meet vous sera communiqué avant l'appel.</p>`;
}

// ---- Modèles d'emails envoyés automatiquement au client ----
function composeEmail(relance, demande, rdv) {
  const nom = esc(demande.responsable);
  switch (relance.modele) {
    case 'rdv_j1':
      return { subject: `Rappel : votre rendez-vous TAPA CONSEIL ${fmtFr(rdv.debut)}`, html: `<p>Bonjour ${nom},</p><p>Nous vous rappelons notre rendez-vous en visioconférence <b>${esc(fmtFr(rdv.debut))}</b> (heure d'Abidjan), pour parler de votre projet de financement.</p>${meetBlock(rdv)}<p>Si ce créneau ne vous convient plus, répondez simplement à cet email.</p>${footer(demande)}` };
    case 'rdv_h1':
      return { subject: 'Votre rendez-vous TAPA CONSEIL commence dans 1 heure', html: `<p>Bonjour ${nom},</p><p>Notre appel commence dans une heure (<b>${esc(fmtFr(rdv.debut))}</b>, heure d'Abidjan).</p>${meetBlock(rdv)}${footer(demande)}` };
    case 'proposition_j3':
      return { subject: 'Suite à notre proposition — TAPA CONSEIL', html: `<p>Bonjour ${nom},</p><p>Nous revenons vers vous au sujet de la proposition d'accompagnement que nous vous avons envoyée pour <b>${esc(demande.entreprise)}</b>. Avez-vous eu le temps de la regarder ? Nous restons disponibles pour en discuter lors d'un court échange Google Meet, à l'heure qui vous arrange.</p><p>Il vous suffit de répondre à cet email avec vos disponibilités.</p>${footer(demande)}` };
    default:
      return { subject: relance.titre || 'Message de TAPA CONSEIL', html: `<p>Bonjour ${nom},</p>${String(relance.message || '').split(/\n{2,}/).map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')}${footer(demande)}` };
  }
}

// ---- Création de relances ----
function addRelance({ demande_id = null, user_id = null, rdv_id = null, type = 'interne', titre, message = null, modele = null, due_at, auto = 0 }) {
  const info = db.prepare(`INSERT INTO relances (demande_id, user_id, rdv_id, type, titre, message, modele, due_at, auto) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(demande_id, user_id, rdv_id, type, titre, message, modele, due_at, auto ? 1 : 0);
  return info.lastInsertRowid;
}

// À la création d'un rendez-vous : rappels automatiques au client (veille et 1 h avant) + tâche interne.
function creerRelancesRdv(rdv, demande, now = new Date()) {
  const debut = parseSql(rdv.debut);
  const ajoute = [];
  const j1 = new Date(debut.getTime() - 24 * 3600 * 1000);
  const h1 = new Date(debut.getTime() - 3600 * 1000);
  if (demande.email && demande.relances_ok !== 0) {
    if (j1 > now) ajoute.push(addRelance({ demande_id: demande.id, rdv_id: rdv.id, type: 'email', titre: 'Rappel client — veille du rendez-vous', modele: 'rdv_j1', due_at: toSql(j1), auto: 1 }));
    if (h1 > now) ajoute.push(addRelance({ demande_id: demande.id, rdv_id: rdv.id, type: 'email', titre: 'Rappel client — 1 h avant', modele: 'rdv_h1', due_at: toSql(h1), auto: 1 }));
  }
  ajoute.push(addRelance({ demande_id: demande.id, rdv_id: rdv.id, type: 'interne', titre: `Appel Google Meet avec ${demande.responsable} (${demande.entreprise})`, due_at: toSql(new Date(debut.getTime() - 15 * 60000)), auto: 1 }));
  return ajoute;
}
function annulerRelancesRdv(rdvId) {
  db.prepare(`UPDATE relances SET statut = 'annulee' WHERE rdv_id = ? AND statut = 'a_faire'`).run(rdvId);
}

// Quand une demande passe à « Proposition envoyée » : relance à J+3 (tâche équipe + email client), sans doublon.
function autoRelancesPourStatut(demande, statut, now = new Date()) {
  if (statut !== 'proposition_envoyee') return;
  const deja = db.prepare(`SELECT 1 FROM relances WHERE demande_id = ? AND modele = 'proposition_j3' AND statut = 'a_faire'`).get(demande.id);
  if (deja) return;
  const due = toSql(new Date(now.getTime() + 3 * 24 * 3600 * 1000));
  addRelance({ demande_id: demande.id, type: 'interne', titre: `Relancer ${demande.responsable} au sujet de la proposition`, due_at: due, auto: 1, modele: 'proposition_j3' });
  if (demande.email && demande.relances_ok !== 0) addRelance({ demande_id: demande.id, type: 'email', titre: 'Relance client — proposition envoyée', modele: 'proposition_j3', due_at: due, auto: 1 });
}
// Dès qu'on clôture ou qu'on classe sans suite, les relances encore prévues n'ont plus de sens.
function annulerRelancesDemande(demandeId) {
  db.prepare(`UPDATE relances SET statut = 'annulee' WHERE demande_id = ? AND statut = 'a_faire'`).run(demandeId);
}

module.exports = { STATUTS, STATUT_LABELS, toSql, parseSql, normalizeSql, fmtFr, esc, baseUrl, ensureToken, stopUrl, composeEmail, addRelance, creerRelancesRdv, annulerRelancesRdv, autoRelancesPourStatut, annulerRelancesDemande };
