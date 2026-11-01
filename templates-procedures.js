// templates-procedures.js — structure des 2 manuels TAPA Procédures.
// Chaque section a une consigne précise donnée à l'IA (Claude) pour respecter le squelette du
// template quel que soit le contexte de l'entreprise — c'est ça qui encode l'expertise métier.
const TEMPLATES = {
  pme: {
    label: "Manuel PME — Procédures administratives & financières",
    description: "Pour structurer la gestion administrative, RH, achats et trésorerie d'une PME.",
    prix: { standard: 25000, valide: 50000 },
    sections: [
      {
        titre: "Présentation de l'entreprise et objet du manuel",
        consigne: "Présente brièvement l'entreprise (nom, secteur, taille) à partir du contexte fourni, puis explique l'objet et le champ d'application de ce manuel de procédures. 2 à 3 paragraphes."
      },
      {
        titre: "Organisation générale et organigramme",
        consigne: "Décris l'organisation de l'entreprise : les postes clés, les responsabilités de chacun, les liens hiérarchiques. Présente un organigramme sous forme de liste structurée (poste → rattachement → responsabilités principales), adapté à la taille réelle de l'entreprise."
      },
      {
        titre: "Gestion administrative courante",
        consigne: "Décris les procédures de gestion du courrier, de l'archivage des documents, de la conservation des contrats et pièces officielles, adaptées à la taille de l'entreprise. Reste concret et applicable, pas théorique."
      },
      {
        titre: "Gestion des ressources humaines",
        consigne: "Décris les procédures de recrutement, d'intégration, de gestion des congés et de la paie, adaptées au contexte de l'entreprise (nombre d'employés, secteur). Mentionne les documents à conserver pour chaque étape."
      },
      {
        titre: "Gestion des achats et des fournisseurs",
        consigne: "Décris le circuit d'achat : de la demande à la réception, en passant par la validation et le choix des fournisseurs. Prévois un circuit de validation par seuil de montant si la taille de l'entreprise le justifie."
      },
      {
        titre: "Gestion de la trésorerie et des paiements",
        consigne: "Décris les procédures d'encaissement, de décaissement, la séparation entre qui autorise et qui exécute un paiement, et le suivi de la trésorerie au quotidien."
      },
      {
        titre: "Gestion des immobilisations et du matériel",
        consigne: "Décris les procédures d'acquisition, d'inventaire, d'entretien et de sortie du matériel et des équipements de l'entreprise."
      },
      {
        titre: "Contrôle interne et séparation des tâches",
        consigne: "Explique les principes de contrôle interne appliqués : séparation entre celui qui engage une dépense, celui qui la valide et celui qui la paie ; vérifications périodiques ; prévention des erreurs et des fraudes."
      },
      {
        titre: "Annexes — fiches de procédure type",
        consigne: "Propose 2 à 3 fiches de procédure courtes et pratiques (format : Objectif / Étapes / Responsable / Documents) sur des cas concrets adaptés au secteur de l'entreprise, par exemple : traitement d'une facture fournisseur, demande de congé, achat de fournitures."
      }
    ]
  },
  comptable: {
    label: "Manuel comptable — Dossier de crédit",
    description: "Pour démontrer la rigueur comptable de l'entreprise dans un dossier de demande de crédit.",
    prix: { standard: 35000, valide: 65000 },
    sections: [
      {
        titre: "Présentation de l'entreprise et cadre comptable",
        consigne: "Présente brièvement l'entreprise à partir du contexte fourni, puis situe son cadre comptable (référentiel SYSCOHADA, régime fiscal applicable selon la taille et le pays)."
      },
      {
        titre: "Organisation de la fonction comptable",
        consigne: "Décris comment la fonction comptable est organisée dans l'entreprise : qui tient les comptes, à quelle fréquence, avec quels outils, et les liens avec la direction."
      },
      {
        titre: "Procédure de tenue des comptes et pièces justificatives",
        consigne: "Décris les règles d'enregistrement comptable, les pièces justificatives exigées pour chaque type d'opération, et leur mode de conservation (durée, classement)."
      },
      {
        titre: "Procédure de facturation et d'encaissement",
        consigne: "Décris le circuit complet, de l'émission de la facture client jusqu'à l'encaissement et son rapprochement comptable."
      },
      {
        titre: "Procédure de décaissement et circuit de validation par seuil",
        consigne: "Décris le circuit de dépense : qui engage, qui valide selon le montant (prévoir des seuils de validation adaptés à la taille de l'entreprise), qui exécute le paiement."
      },
      {
        titre: "Procédure de clôture mensuelle et annuelle",
        consigne: "Décris les étapes de clôture des comptes chaque mois et chaque année : contrôles, régularisations, préparation des états financiers (bilan, compte de résultat)."
      },
      {
        titre: "Gestion de la trésorerie et rapprochements bancaires",
        consigne: "Décris la procédure de suivi de trésorerie et de rapprochement bancaire périodique, avec la fréquence adaptée à la taille de l'entreprise."
      },
      {
        titre: "Contrôle interne comptable et séparation des tâches",
        consigne: "Explique les contrôles mis en place pour garantir la fiabilité des comptes : séparation entre saisie, validation et paiement ; vérifications croisées ; supervision périodique par la direction."
      },
      {
        titre: "Annexes — plan comptable simplifié et modèles de pièces",
        consigne: "Propose un plan comptable simplifié adapté au secteur de l'entreprise (classes de comptes SYSCOHADA principales utilisées), et un exemple de bordereau de pièce justificative type."
      }
    ]
  }
};

// Le prix de base (par manuel × formule) est ajusté selon la taille de l'entreprise — une entreprise
// plus grande demande plus de travail de relecture/adaptation, même à structure de manuel identique.
// Décision actée avec Ella (sept. 2026), seuils à ajuster après un premier bilan d'usage réel.
const MULTIPLICATEUR_TAILLE = {
  'Micro (moins de 5 employés)': 1,
  'Petite (5 à 20 employés)': 1.2,
  'Moyenne (20 à 50 employés)': 1.6,
  'Grande (plus de 50 employés)': 2.2
  // "Groupe / entreprise complexe" n'a pas de multiplicateur : géré en "sur devis" (voir routes/procedures.js)
};
const TAILLE_SUR_DEVIS = 'Groupe / entreprise complexe';

function tarifSelonTaille(prixBase, taille) {
  if (taille === TAILLE_SUR_DEVIS) return { surDevis: true };
  const mult = MULTIPLICATEUR_TAILLE[taille] ?? 1;
  return { amount: Math.round(prixBase * mult / 500) * 500, surDevis: false }; // arrondi au multiple de 500 le plus proche
}

module.exports = { TEMPLATES, MULTIPLICATEUR_TAILLE, TAILLE_SUR_DEVIS, tarifSelonTaille };
