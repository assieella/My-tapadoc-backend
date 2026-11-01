// marche-generation.js — rédige l'étude de marché et l'analyse concurrentielle d'un Business Plan,
// en s'appuyant sur une vraie recherche web (concurrents réels, données de marché locales) plutôt
// que sur des généralités inventées. Un seul appel, une seule sortie structurée (10 champs).
const fetch = require('node-fetch');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

const CHAMPS = ['secteur','taille','clientele','besoins','concurrents','positionnement','forces','faiblesses','opportunites','menaces'];

async function genererEtudeMarche({ activite, secteur, localisation, nomEntreprise }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY n'est pas configurée sur le serveur.");
  if (!activite || !activite.trim()) throw new Error("Merci de décrire l'activité avant de générer l'étude de marché.");

  const lieu = (localisation && localisation.trim()) || "Côte d'Ivoire";

  const systemPrompt = `Tu es un analyste qui prépare l'étude de marché d'un business plan destiné à une banque en Côte d'Ivoire. Tu dois faire de VRAIES recherches web pour trouver des concurrents réels et des données de marché réelles — jamais inventer un nom d'entreprise ou un chiffre que tu n'as pas trouvé. Si tu ne trouves pas d'information fiable sur un point précis, dis-le explicitement plutôt que d'inventer ("Aucune donnée précise trouvée, mais..."). Écris en français professionnel, concret, 2 à 4 phrases par champ — pas de remplissage vague. Réponds UNIQUEMENT avec un objet JSON valide, sans texte avant ni après, avec exactement ces 10 clés : secteur, taille, clientele, besoins, concurrents, positionnement, forces, faiblesses, opportunites, menaces.`;

  const userPrompt = `Entreprise : ${nomEntreprise || 'non précisé'}
Localisation : ${lieu}
Secteur déclaré : ${secteur || 'non précisé'}
Description de l'activité (donnée par l'entrepreneur) : ${activite.trim()}

Fais des recherches web sur ce secteur précis à ${lieu} (ou à défaut en Côte d'Ivoire) : état du marché, taille/évolution, concurrents réels identifiables (noms si tu les trouves), tendances récentes. Puis rédige les 10 champs suivants pour le business plan de cette entreprise :
- secteur : comment se porte ce secteur d'activité (tendances, croissance, contexte réel trouvé en recherche)
- taille : taille du marché local et son évolution
- clientele : qui sont les clients typiques de ce type d'activité à cet endroit
- besoins : quels besoins client ce type d'activité cherche à satisfaire
- concurrents : les concurrents réels trouvés par recherche (noms si identifiés, sinon type de concurrence identifiée)
- positionnement : comment cette entreprise pourrait se différencier de cette concurrence
- forces : forces plausibles de ce projet compte tenu du contexte trouvé
- faiblesses : faiblesses ou risques plausibles pour un nouvel entrant sur ce marché
- opportunites : opportunités identifiées dans le contexte local actuel
- menaces : menaces identifiées (concurrence, réglementation, conjoncture)

Réponds uniquement avec le JSON, sans balises markdown.`;

  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }]
    })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Erreur API Claude (${res.status}) : ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const textBlocks = (data.content || []).filter(b => b.type === 'text').map(b => b.text);
  if (!textBlocks.length) throw new Error('Réponse Claude vide ou inattendue (aucun texte, peut-être seulement des recherches).');
  const raw = textBlocks[textBlocks.length - 1].trim();

  let cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/,'').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch (e2) { /* laisse parsed undefined */ }
    }
  }
  if (!parsed) throw new Error("Impossible de lire la réponse de l'IA (format inattendu). Réessayez.");

  const out = {};
  CHAMPS.forEach(k => { out[k] = typeof parsed[k] === 'string' ? parsed[k].trim() : ''; });
  return out;
}

module.exports = { genererEtudeMarche, CHAMPS };
