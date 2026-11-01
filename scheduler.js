// scheduler.js — tâches automatiques du back office, exécutées toutes les 5 minutes :
//  1) envoi des relances par email dues (rappels de rendez-vous, relance après proposition, relances libres) ;
//  2) résumé quotidien envoyé à l'équipe vers 8 h (heure d'Abidjan) : demandes en retard, relances du jour, rendez-vous.
const db = require('./db');
const { sendMail } = require('./email');
const core = require('./bo-core');

const TEAM_EMAIL = () => process.env.PRECRED_NOTIFY_EMAIL || 'formationella398@gmail.com';

function annuler(id, why) { db.prepare(`UPDATE relances SET statut = 'annulee', erreur = ? WHERE id = ?`).run(why || null, id); }

async function envoyerRelancesDues(now) {
  const dues = db.prepare(`SELECT * FROM relances WHERE type = 'email' AND statut = 'a_faire' AND due_at <= ? ORDER BY due_at LIMIT 50`).all(core.toSql(now));
  let envoyes = 0;
  for (const r of dues) {
    const d = db.prepare('SELECT * FROM demandes_precred WHERE id = ?').get(r.demande_id);
    if (!d || !d.email || d.relances_ok === 0 || d.statut === 'sans_suite' || d.statut === 'termine') { annuler(r.id, 'Client désinscrit ou dossier clôturé'); continue; }
    let rdv = null;
    if (r.rdv_id) {
      rdv = db.prepare('SELECT * FROM rendez_vous WHERE id = ?').get(r.rdv_id);
      if (!rdv || rdv.statut !== 'planifie') { annuler(r.id, 'Rendez-vous annulé ou terminé'); continue; }
      if (core.parseSql(rdv.debut).getTime() < now.getTime() - 30 * 60000) { annuler(r.id, 'Rendez-vous déjà passé'); continue; }
    }
    // On marque d'abord « envoyée » pour qu'un redémarrage en plein envoi ne puisse jamais produire un double email.
    db.prepare(`UPDATE relances SET statut = 'envoyee', done_at = datetime('now') WHERE id = ?`).run(r.id);
    try {
      const { subject, html } = core.composeEmail(r, d, rdv);
      await sendMail({ to: d.email, subject, html });
      envoyes++;
    } catch (e) {
      db.prepare(`UPDATE relances SET statut = 'echec', erreur = ? WHERE id = ?`).run(String(e.message).slice(0, 300), r.id);
    }
  }
  return envoyes;
}

async function resumeQuotidien(now) {
  if (now.getUTCHours() < 8) return false;
  const jour = core.toSql(now).slice(0, 10);
  const last = db.prepare(`SELECT derniere_execution FROM taches_systeme WHERE nom = 'digest'`).get();
  if (last && last.derniere_execution === jour) return false;
  db.prepare(`INSERT INTO taches_systeme (nom, derniere_execution) VALUES ('digest', ?) ON CONFLICT(nom) DO UPDATE SET derniere_execution = excluded.derniere_execution`).run(jour);

  const finJour = jour + ' 23:59:59';
  const retard = db.prepare(`SELECT * FROM demandes_precred WHERE statut = 'nouvelle' AND created_at <= ? ORDER BY id`).all(core.toSql(new Date(now.getTime() - 24 * 3600 * 1000)));
  const nouvelles = db.prepare(`SELECT COUNT(*) AS n FROM demandes_precred WHERE statut = 'nouvelle'`).get().n;
  const relances = db.prepare(`SELECT r.*, d.responsable, d.entreprise FROM relances r LEFT JOIN demandes_precred d ON d.id = r.demande_id
    WHERE r.type = 'interne' AND r.statut = 'a_faire' AND r.due_at <= ? ORDER BY r.due_at`).all(finJour);
  const rdvs = db.prepare(`SELECT v.*, d.responsable, d.entreprise FROM rendez_vous v JOIN demandes_precred d ON d.id = v.demande_id
    WHERE v.statut = 'planifie' AND v.debut >= ? AND v.debut <= ? ORDER BY v.debut`).all(jour + ' 00:00:00', finJour);
  if (!retard.length && !relances.length && !rdvs.length && !nouvelles) return false;

  const li = arr => arr.length ? `<ul>${arr.map(x => `<li>${x}</li>`).join('')}</ul>` : '<p><i>Rien</i></p>';
  const html = `<p>Bonjour, voici le point du jour du back office TAPA CONSEIL.</p>
    <h3>Rendez-vous aujourd'hui (${rdvs.length})</h3>${li(rdvs.map(v => `${core.esc(core.fmtFr(v.debut))} — ${core.esc(v.responsable)} (${core.esc(v.entreprise)})${v.lien_meet ? ` — <a href="${core.esc(v.lien_meet)}">lien Meet</a>` : ' — <b>lien Meet à ajouter</b>'}`))}
    <h3>Demandes sans réponse depuis plus de 24 h (${retard.length})</h3>${li(retard.map(d => `${core.esc(d.entreprise)} — ${core.esc(d.responsable)} — ${core.esc(d.email || d.telephone || '')}`))}
    <h3>Relances à faire (${relances.length})</h3>${li(relances.map(r => `${core.esc(r.titre)} <i>(prévue ${core.esc(core.fmtFr(r.due_at))})</i>`))}
    <p>${nouvelles} nouvelle(s) demande(s) en attente au total.</p>
    <p><a href="${core.esc(core.baseUrl())}/Back-office-TAPA-CONSEIL.html">Ouvrir le back office</a></p>`;
  try { await sendMail({ to: TEAM_EMAIL(), subject: `TAPA CONSEIL — point du jour : ${rdvs.length} RDV, ${relances.length} relance(s), ${retard.length} demande(s) en retard`, html }); }
  catch (e) { console.error('[scheduler] résumé quotidien non envoyé :', e.message); }
  return true;
}

async function tick(now = new Date()) {
  const envoyes = await envoyerRelancesDues(now);
  const digest = await resumeQuotidien(now);
  return { envoyes, digest };
}

let timer = null;
function start() {
  if (timer) return;
  const run = () => tick().catch(e => console.error('[scheduler]', e.message));
  setTimeout(run, 20 * 1000);
  timer = setInterval(run, 5 * 60 * 1000);
}

module.exports = { tick, envoyerRelancesDues, resumeQuotidien, start };
