// google.js — Google Agenda + Google Meet, sans dépendance supplémentaire (API REST + node-fetch).
// Principe : l'administrateur clique une fois sur « Connecter Google Agenda » dans le back office ;
// Google renvoie un « refresh token » que l'on garde dans la base (volume /data). Ensuite chaque
// rendez-vous crée un événement avec lien Google Meet et envoie l'invitation au client.
// Variables Railway nécessaires : GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (voir le guide fourni).
const crypto = require('crypto');
const fetch = require('node-fetch');
const db = require('./db');

const SCOPE = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/userinfo.email';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CAL_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

function configured() { return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET); }
function redirectUri(baseUrl) { return (process.env.BASE_URL || baseUrl || '').replace(/\/$/, '') + '/api/google/callback'; }

function status() {
  const row = db.prepare('SELECT email, connected_at FROM google_auth WHERE id = 1').get();
  return { configured: configured(), connected: !!row, email: row ? row.email : null, connectedAt: row ? row.connected_at : null };
}

// « state » signé : empêche d'utiliser l'adresse de retour de Google pour autre chose que notre demande.
function signState() {
  const ts = String(Date.now());
  const sig = crypto.createHmac('sha256', process.env.JWT_SECRET || 'x').update(ts).digest('hex').slice(0, 24);
  return ts + '.' + sig;
}
function checkState(state) {
  const [ts, sig] = String(state || '').split('.');
  if (!ts || !sig) return false;
  const good = crypto.createHmac('sha256', process.env.JWT_SECRET || 'x').update(ts).digest('hex').slice(0, 24);
  return sig === good && Date.now() - Number(ts) < 15 * 60 * 1000;
}

function authUrl(baseUrl) {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(baseUrl), response_type: 'code',
    scope: SCOPE, access_type: 'offline', prompt: 'consent', state: signState()
  });
  return AUTH_URL + '?' + p.toString();
}

async function postForm(url, params) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Google : ' + (data.error_description || data.error || res.status));
  return data;
}

async function exchangeCode(code, baseUrl) {
  const tok = await postForm(TOKEN_URL, {
    code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri(baseUrl), grant_type: 'authorization_code'
  });
  if (!tok.refresh_token) throw new Error("Google n'a pas renvoyé d'autorisation durable. Réessayez la connexion.");
  let email = null;
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: 'Bearer ' + tok.access_token } });
    email = (await r.json()).email || null;
  } catch {}
  db.prepare(`INSERT INTO google_auth (id, refresh_token, email, connected_at) VALUES (1, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET refresh_token = excluded.refresh_token, email = excluded.email, connected_at = datetime('now')`).run(tok.refresh_token, email);
  return { email };
}

function disconnect() { db.prepare('DELETE FROM google_auth WHERE id = 1').run(); }

let cached = { token: null, exp: 0 };
async function accessToken() {
  const row = db.prepare('SELECT refresh_token FROM google_auth WHERE id = 1').get();
  if (!row) throw new Error("Google Agenda n'est pas connecté.");
  if (cached.token && Date.now() < cached.exp - 60000) return cached.token;
  const tok = await postForm(TOKEN_URL, {
    client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: row.refresh_token, grant_type: 'refresh_token'
  });
  cached = { token: tok.access_token, exp: Date.now() + (tok.expires_in || 3600) * 1000 };
  return cached.token;
}

async function calFetch(method, url, body) {
  const token = await accessToken();
  const res = await fetch(url, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 204) return {};
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Google Agenda : ' + ((data.error && (data.error.message || data.error)) || res.status));
  return data;
}

function isoUtc(sql) { return new Date(sql.replace(' ', 'T') + 'Z').toISOString(); }
function endOf(sql, minutes) { return new Date(new Date(sql.replace(' ', 'T') + 'Z').getTime() + minutes * 60000).toISOString(); }

// Crée l'événement + le lien Meet + envoie l'invitation par email au client.
async function createMeeting({ titre, description, debutSql, dureeMin, attendeeEmail }) {
  const ev = await calFetch('POST', CAL_URL + '?conferenceDataVersion=1&sendUpdates=all', {
    summary: titre, description,
    start: { dateTime: isoUtc(debutSql), timeZone: 'Africa/Abidjan' },
    end: { dateTime: endOf(debutSql, dureeMin), timeZone: 'Africa/Abidjan' },
    attendees: attendeeEmail ? [{ email: attendeeEmail }] : [],
    conferenceData: { createRequest: { requestId: crypto.randomBytes(8).toString('hex'), conferenceSolutionKey: { type: 'hangoutsMeet' } } },
    reminders: { useDefault: true }
  });
  return { eventId: ev.id, meetLink: ev.hangoutLink || (ev.conferenceData && ev.conferenceData.entryPoints && ev.conferenceData.entryPoints[0] && ev.conferenceData.entryPoints[0].uri) || null };
}

async function updateMeeting(eventId, { debutSql, dureeMin }) {
  return calFetch('PATCH', CAL_URL + '/' + encodeURIComponent(eventId) + '?sendUpdates=all', {
    start: { dateTime: isoUtc(debutSql), timeZone: 'Africa/Abidjan' }, end: { dateTime: endOf(debutSql, dureeMin), timeZone: 'Africa/Abidjan' }
  });
}
async function cancelMeeting(eventId) { return calFetch('DELETE', CAL_URL + '/' + encodeURIComponent(eventId) + '?sendUpdates=all'); }

module.exports = { configured, status, authUrl, checkState, exchangeCode, disconnect, createMeeting, updateMeeting, cancelMeeting, redirectUri };
