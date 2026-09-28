// verify-account.js — confirme manuellement l'email d'un compte, sans passer par le lien reçu par email.
const db = require('./db');
const email = process.argv[2];
if (!email) { console.error('Usage : node verify-account.js email@exemple.com'); process.exit(1); }
const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
if (!user) { console.error(`Aucun compte trouvé avec l'email ${email}`); process.exit(1); }
db.prepare('UPDATE users SET email_verified = 1, verify_token_hash = NULL, verify_token_expires = NULL WHERE id = ?').run(user.id);
console.log(`✓ Email ${email} confirmé manuellement.`);
