// lock-account.js — reverrouille un compte débloqué manuellement.
const db = require('./db');
const email = process.argv[2];
if (!email) { console.error('Usage : node lock-account.js email@exemple.com'); process.exit(1); }
const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
if (!user) { console.error(`Aucun compte trouvé avec l'email ${email}`); process.exit(1); }
db.prepare('UPDATE users SET access_expires_at = NULL WHERE id = ?').run(user.id);
console.log(`✓ Compte ${email} reverrouillé.`);
