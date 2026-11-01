// middleware/admin.js — protège les routes du back office par la clé ADMIN_KEY (en-tête x-admin-key).
function requireAdminKey(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Clé admin manquante ou incorrecte.' });
  }
  next();
}
module.exports = { requireAdminKey };
