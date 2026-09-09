// routes/admin.js — statistiques simples pour suivre l'activité, protégé par une clé (ADMIN_KEY).
const express = require('express');
const db = require('../db');

const router = express.Router();

function requireAdminKey(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Clé admin manquante ou incorrecte.' });
  }
  next();
}

const TAB_LABELS = ['Fiche Entreprise', 'Résultat 12 mois', 'Résultat 5 ans', 'Bilan', 'Trésorerie', 'Financement', 'Synthèse'];

router.get('/stats', requireAdminKey, (req, res) => {
  const totalUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const verifiedUsers = db.prepare('SELECT COUNT(*) AS n FROM users WHERE email_verified = 1').get().n;
  const paidUsers = db.prepare('SELECT COUNT(*) AS n FROM users WHERE has_paid_before = 1').get().n;
  const activeNow = db.prepare("SELECT COUNT(*) AS n FROM users WHERE access_expires_at IS NOT NULL AND access_expires_at > datetime('now')").get().n;

  const totalRevenue = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE status = 'success'").get().s;
  const successfulPayments = db.prepare("SELECT COUNT(*) AS n FROM payments WHERE status = 'success'").get().n;
  const revenueFinModel = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE status = 'success' AND product = 'finmodel'").get().s;
  const revenueBP = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE status = 'success' AND product = 'business-plan'").get().s;

  const dossiers = db.prepare('SELECT data FROM dossiers').all();
  const dropoff = TAB_LABELS.map(() => 0);
  let dossiersAvecDonnees = 0;
  dossiers.forEach(row => {
    try {
      const parsed = JSON.parse(row.data);
      const view = (parsed.meta && typeof parsed.meta.currentView === 'number') ? parsed.meta.currentView : 0;
      if (dropoff[view] !== undefined) dropoff[view]++;
      dossiersAvecDonnees++;
    } catch {}
  });

  const conversion = verifiedUsers > 0 ? Math.round((paidUsers / verifiedUsers) * 1000) / 10 : 0;

  res.json({
    comptes: { total: totalUsers, verifies: verifiedUsers, payes: paidUsers, actifs: activeNow, tauxConversion: conversion },
    paiements: { total: successfulPayments, revenuTotal: totalRevenue, revenuFinModel: revenueFinModel, revenuBusinessPlan: revenueBP },
    abandon: { dossiersAnalyses: dossiersAvecDonnees, parEtape: TAB_LABELS.map((label, i) => ({ etape: label, count: dropoff[i] })) }
  });
});

module.exports = router;
