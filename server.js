// server.js — point d'entrée du backend (comptes + paiement Paiement Pro + sauvegarde du dossier)
// Sert TROIS frontends (TAPA FinModel, Établir votre Business Plan, TAPA Procédures) + le site public,
// TOUT depuis un seul serveur — une seule adresse à déployer, pas de souci de CORS entre deux hôtes.
require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const paymentRoutes = require('./routes/payment');
const dossierRoutes = require('./routes/dossier');
const adminRoutes = require('./routes/admin');
const proceduresRoutes = require('./routes/procedures');
const assistantRoutes = require('./routes/assistant');

const app = express();
app.set('trust proxy', true); // nécessaire derrière le proxy Railway pour que req.ip soit la vraie IP du visiteur (utilisé par le garde-fou anti-abus de l'assistant)
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/dossier', dossierRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/procedures', proceduresRoutes);
app.use('/api/assistant', assistantRoutes);

// Le site (Accueil, TAPA FinModel, Business Plan, TAPA Procédures, Guide, Tableau de bord) est servi
// tel quel depuis /public — même origine que l'API, donc plus aucun souci de CORS en local ou en ligne.
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'Accueil-TAPA-CONSEIL.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend TAPA CONSEIL démarré sur le port ${PORT} — site disponible sur http://localhost:${PORT}`));
