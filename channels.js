// channels.js — moyens de paiement Mobile Money proposés au client, selon son pays.
const COUNTRIES = {
  CI: { name: "Côte d'Ivoire", dial: '225', currency: '952', operators: ['ORANGE', 'MTN', 'MOOV', 'WAVE'] },
  SN: { name: 'Sénégal',        dial: '221', currency: '952', operators: ['ORANGE', 'WAVE', 'FREE'] },
  BJ: { name: 'Bénin',          dial: '229', currency: '952', operators: ['MTN', 'MOOV'] },
  TG: { name: 'Togo',           dial: '228', currency: '952', operators: ['MOOV', 'MIXXBYYAS'] },
  BF: { name: 'Burkina Faso',   dial: '226', currency: '952', operators: ['ORANGE', 'MOOV'] },
  ML: { name: 'Mali',           dial: '223', currency: '952', operators: ['ORANGE', 'MOOV'] },
  NE: { name: 'Niger',          dial: '227', currency: '952', operators: ['ORANGE', 'MOOV'] },
  CM: { name: 'Cameroun',       dial: '237', currency: '950', operators: ['ORANGE', 'MTN'] },
};
const OPERATOR_LABELS = { ORANGE: 'Orange Money', MTN: 'MTN Mobile Money', MOOV: 'Moov Money', WAVE: 'Wave', FREE: 'Free Money', MIXXBYYAS: 'Mixx by Yas' };

function methodsForCountry(countryCode) {
  const c = COUNTRIES[countryCode] || COUNTRIES.CI;
  return c.operators.map(op => {
    const envKey = `CHANNEL_${countryCode}_${op}`;
    const code = process.env[envKey];
    return { key: op, label: OPERATOR_LABELS[op] || op, code: code || null, confirmed: !!code };
  });
}
function codeFor(countryCode, operatorKey) {
  const m = methodsForCountry(countryCode).find(m => m.key === operatorKey);
  return m && m.code ? m.code : null;
}
function currencyFor(countryCode) { return (COUNTRIES[countryCode] || COUNTRIES.CI).currency; }

module.exports = { COUNTRIES, methodsForCountry, codeFor, currencyFor };
