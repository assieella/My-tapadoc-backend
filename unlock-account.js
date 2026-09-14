// unlock-account.js — débloque manuellement un compte pour 365 jours, sans paiement (tests).
// Débloque FinModel ET Business Plan (accès séparés depuis la grille tarifaire par paliers).
// Ne concerne pas TAPA Procédures, qui se paie par manuel généré, pas par accès global.
const db = require('./db');
const email = process.argv[2];
if (!email) { console.error('Usage : node unlock-account.js email@exemple.com'); process.exit(1); }
const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
if (!user) { console.error(`Aucun compte trouvé avec l'email ${email}`); process.exit(1); }
const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
db.prepare('UPDATE users SET access_expires_at = ?, finmodel_access_expires_at = ?, businessplan_access_expires_at = ?, has_paid_before = 1 WHERE id = ?')
  .run(expiresAt, expiresAt, expiresAt, user.id);
console.log(`✓ Compte ${email} débloqué (TAPA FinModel + Business Plan) jusqu'au ${new Date(expiresAt).toLocaleDateString('fr-FR')} (365 jours, sans paiement).`);
console.log('  Ne débloque pas TAPA Procédures (paiement par manuel généré, pas par accès global).');
console.log("  Reconnectez-vous dans l'application (ou rechargez la page) pour voir l'accès complet.");
