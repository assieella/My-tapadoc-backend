// db.js — base SQLite (fichier data.db). Le chemin est configurable via DATA_DIR pour pointer vers
// un volume persistant Railway — sans ça, le fichier vit dans le code déployé et disparaît à chaque
// nouveau déploiement (c'est ce qui s'est passé avant qu'on ajoute cette variable).
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'data.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  nom_entreprise TEXT,
  phone TEXT,
  country TEXT NOT NULL DEFAULT 'CI',
  email_verified INTEGER NOT NULL DEFAULT 0,
  verify_token_hash TEXT,
  verify_token_expires TEXT,
  has_paid_before INTEGER NOT NULL DEFAULT 0,
  access_expires_at TEXT,
  reset_token_hash TEXT,
  reset_token_expires TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  reference TEXT UNIQUE NOT NULL,
  product TEXT NOT NULL DEFAULT 'precred',   -- 'precred' | 'business-plan' | 'procedures'
  kind TEXT NOT NULL DEFAULT 'first',        -- 'first' | 'update' | 'business-plan' | 'pme-standard' | 'pme-valide' | 'comptable-standard' | 'comptable-valide'
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  manuel_id INTEGER,                         -- rempli uniquement pour product='procedures'
  provider_payload TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS dossiers (
  user_id INTEGER PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- TAPA Procédures : un manuel généré par achat, indépendant du "dossier" TAPA FinModel/Business Plan.
CREATE TABLE IF NOT EXISTS manuels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,              -- 'pme' | 'comptable'
  palier TEXT NOT NULL,            -- 'standard' | 'valide'
  contexte TEXT NOT NULL,          -- JSON des réponses au questionnaire de qualification
  sections TEXT,                   -- JSON : [{titre, contenu}] rempli au fur et à mesure de la génération
  statut TEXT NOT NULL DEFAULT 'brouillon', -- brouillon|attente_paiement|en_generation|genere|attente_validation|livre|erreur
  reference_paiement TEXT,
  docx_path TEXT,                  -- chemin du .docx final (remplacé si un expert TAPA en dépose une version corrigée)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- TAPA DOC Assistant : conversation du chatbot public, liée à un identifiant de navigateur
-- (pas un compte utilisateur — le visiteur n'a pas encore forcément créé de compte).
CREATE TABLE IF NOT EXISTS assistant_conversations (
  visitor_id TEXT PRIMARY KEY,
  messages TEXT NOT NULL DEFAULT '[]',   -- JSON : [{role:'user'|'assistant', content}]
  message_count INTEGER NOT NULL DEFAULT 0, -- nombre de messages envoyés par le visiteur (pour le quota)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Migration douce : ajoute la colonne product si elle n'existe pas déjà (bases créées avant ce changement).
try { db.exec("ALTER TABLE payments ADD COLUMN product TEXT NOT NULL DEFAULT 'precred'"); } catch (e) {}
try { db.exec("ALTER TABLE payments ADD COLUMN manuel_id INTEGER"); } catch (e) {}

// Migration : sépare l'accès FinModel et Business Plan (auparavant un seul champ partagé
// access_expires_at débloquait les deux produits ensemble — nécessaire depuis que chacun a sa
// propre grille tarifaire par palier). Colonne conservée pour compat, mais plus utilisée pour le
// contrôle d'accès des deux outils.
try { db.exec("ALTER TABLE users ADD COLUMN finmodel_access_expires_at TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN businessplan_access_expires_at TEXT"); } catch (e) {}
// Report l'ancien accès partagé sur les deux nouvelles colonnes, pour ne pas couper l'accès des
// clients ayant déjà payé avant cette migration.
try {
  db.exec(`
    UPDATE users SET
      finmodel_access_expires_at = access_expires_at,
      businessplan_access_expires_at = access_expires_at
    WHERE access_expires_at IS NOT NULL
      AND finmodel_access_expires_at IS NULL
      AND businessplan_access_expires_at IS NULL
  `);
} catch (e) {}

// Traçabilité du palier facturé, pour le bilan à 3 mois évoqué avec Ella.
try { db.exec("ALTER TABLE payments ADD COLUMN palier TEXT"); } catch (e) {}

module.exports = db;
