// whatsapp.js — envoi de messages WhatsApp (non utilisé activement pour l'instant, conservé pour plus tard).
const fetch = require('node-fetch');

async function sendWhatsApp({ to, message }) {
  const url = process.env.WHATSAPP_API_URL;
  if (!url) {
    console.log(`[WhatsApp non envoyé — service non configuré] à: ${to}\n${message}`);
    return;
  }
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(process.env.WHATSAPP_API_KEY ? { Authorization: `Bearer ${process.env.WHATSAPP_API_KEY}` } : {}) },
      body: JSON.stringify({ to, message })
    });
  } catch (err) { console.error('Erreur envoi WhatsApp:', err); }
}
module.exports = { sendWhatsApp };
