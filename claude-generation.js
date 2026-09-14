// claude-generation.js — rédige chaque section d'un manuel via l'API Claude, en respectant le
// squelette du template. Le contexte réel de l'entreprise est injecté à chaque appel — l'IA rédige
// et adapte, mais ne décide jamais du plan (ça reste la responsabilité de templates-procedures.js).
const fetch = require('node-fetch');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

async function genererSection({ consigne, titre, contexte }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY n'est pas configurée sur le serveur.");
  }

  const contextePrompt = `
Contexte de l'entreprise :
- Nom : ${contexte.nomEntreprise || 'non précisé'}
- Secteur d'activité : ${contexte.secteur || 'non précisé'}
- Taille : ${contexte.taille || 'non précisée'}
- Pays : ${contexte.pays || 'Côte d\'Ivoire'}
- Particularités mentionnées par l'entrepreneur : ${contexte.specificites || 'aucune particularité mentionnée'}
`.trim();

  const systemPrompt = `Tu rédiges une section d'un manuel de procédures professionnel pour TAPA CONSEIL, un cabinet de conseil financier ivoirien. Le document final est destiné à être présenté à une banque ou utilisé en interne par l'entreprise cliente. Écris en français professionnel, clair et concret — pas de jargon inutile, pas de généralités vagues. Adapte le contenu au contexte réel de l'entreprise fourni. N'invente aucun chiffre financier. Ne mets pas de titre de section dans ta réponse (il est déjà géré séparément) — commence directement par le texte de la section. Réponds uniquement avec le contenu de la section, sans préambule ni commentaire sur ta tâche.`;

  const userPrompt = `${contextePrompt}\n\nRédige la section "${titre}" de ce manuel de procédures.\n\nConsigne pour cette section : ${consigne}`;

  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1200,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Erreur API Claude (${res.status}) : ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const textBlock = (data.content || []).find(b => b.type === 'text');
  if (!textBlock) throw new Error('Réponse Claude vide ou inattendue.');
  return textBlock.text.trim();
}

module.exports = { genererSection };
