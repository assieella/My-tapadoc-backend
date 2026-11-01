// pricing.js — calcule le palier tarifaire à partir du montant réel du projet (jamais une question
// déclarative séparée : le montant vient du dossier déjà rempli par le client — champ "montant" de
// la Fiche Entreprise, le crédit/financement demandé). Décision actée avec Ella (sept. 2026) :
// facturer selon la taille réelle du projet, pas un prix unique — pour ne jamais sous-facturer un
// grand groupe. Seuils à ajuster après un premier bilan à 3 mois d'usage réel.

const PALIERS_BUSINESS_PLAN = [
  { max: 10_000_000,   amount: 15000,  label: '≤ 10M FCFA' },
  { max: 50_000_000,   amount: 30000,  label: '10-50M FCFA' },
  { max: 100_000_000,  amount: 60000,  label: '50-100M FCFA' },
  { max: Infinity,     surDevis: true, label: '+100M FCFA' }
];

const PALIERS_FINMODEL = [
  { max: 10_000_000,   amount: 15000,  label: '≤ 10M FCFA' },
  { max: 50_000_000,   amount: 25000,  label: '10-50M FCFA' },
  { max: 150_000_000,  amount: 50000,  label: '50-150M FCFA' },
  { max: 500_000_000,  amount: 90000,  label: '150-500M FCFA' },
  { max: Infinity,     surDevis: true, label: '+500M FCFA' }
];

// Une mise à jour de dossier (déjà payé une fois) coûte la moitié du tarif du palier — même
// logique de réduction que l'ancien tarif fixe FinModel (7 500 / 15 000 = 50%).
const RATIO_MISE_A_JOUR = 0.5;

function trouverPalier(montant, paliers) {
  const m = Number(montant) || 0;
  const palier = paliers.find(p => m <= p.max);
  return palier || paliers[paliers.length - 1];
}

function tarifBusinessPlan(montant) {
  const p = trouverPalier(montant, PALIERS_BUSINESS_PLAN);
  if (p.surDevis) return { surDevis: true, label: p.label };
  return { amount: p.amount, label: p.label, surDevis: false };
}

function tarifFinModel(montant, dejaPaye) {
  const p = trouverPalier(montant, PALIERS_FINMODEL);
  if (p.surDevis) return { surDevis: true, label: p.label };
  const amount = dejaPaye ? Math.round(p.amount * RATIO_MISE_A_JOUR) : p.amount;
  return { amount, label: p.label, surDevis: false, kind: dejaPaye ? 'update' : 'first' };
}

// Réduction appliquée aux Packs (V1 : seulement le Pack Création, FinModel + Business Plan).
// Pourcentage provisoire — à ajuster après le bilan à 3 mois évoqué avec Ella.
const REDUCTION_PACK = 0.15;

function tarifPackCreation(montant) {
  const bp = tarifBusinessPlan(montant);
  const fm = tarifFinModel(montant, false);
  if (bp.surDevis || fm.surDevis) return { surDevis: true, label: 'Projet trop important pour le Pack Création' };
  const total = bp.amount + fm.amount;
  const amount = Math.round(total * (1 - REDUCTION_PACK) / 500) * 500;
  return { amount, surDevis: false, label: `${bp.label}`, economie: total - amount };
}

module.exports = { tarifBusinessPlan, tarifFinModel, tarifPackCreation, PALIERS_BUSINESS_PLAN, PALIERS_FINMODEL };
