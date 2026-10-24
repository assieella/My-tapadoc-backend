// email.js — envoi d'email via Resend (API HTTP, port 443 — jamais bloqué, contrairement au SMTP
// classique que Railway bloque par défaut sur son offre gratuite/Hobby). Documentation :
// https://resend.com/docs/api-reference/emails/send-email
const fetch = require('node-fetch');

const RESEND_API_URL = 'https://api.resend.com/emails';

async function sendMail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[email non envoyé — RESEND_API_KEY non configurée] à: ${to} — sujet: ${subject}\n${html}`);
    return;
  }

  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM || 'TAPA CONSEIL <contact@tapaconseilagence.com>',
      to: [to],
      subject,
      html
    })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Erreur envoi email Resend (${res.status}) : ${errText.slice(0, 300)}`);
  }
}

module.exports = { sendMail };
