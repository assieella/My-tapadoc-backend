// reset-password.js — change directement le mot de passe d'un compte, sans passer par l'email.
//
// Usage :
//   node reset-password.js email@exemple.com nouveauMotDePasse
//
const bcrypt = require('bcryptjs');
const db = require('./db');

const email = process.argv[2];
const newPassword = process.argv[3];

if (!email || !newPassword) {
  console.error('Usage : node reset-password.js email@exemple.com nouveauMotDePasse');
  process.exit(1);
}
if (newPassword.length < 6) {
  console.error('Le mot de passe doit faire au moins 6 caractères.');
  process.exit(1);
}

const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
if (!user) {
  console.error(`Aucun compte trouvé avec l'email ${email}`);
  process.exit(1);
}

const hash = bcrypt.hashSync(newPassword, 10);
db.prepare('UPDATE users SET password_hash = ?, reset_token_hash = NULL, reset_token_expires = NULL WHERE id = ?').run(hash, user.id);
console.log(`✓ Mot de passe du compte ${email} changé avec succès. Nouveau mot de passe : ${newPassword}`);
