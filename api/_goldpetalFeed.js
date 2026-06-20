const https = require('https');
const http = require('http');

function getPathValue(obj, path) {
  if (!obj || !path) return undefined;
  return String(path)
    .split('.')
    .reduce((value, key) => (value == null ? undefined : value[key]), obj);
}

function parseNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const n = Number(value.replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function goldpetalPriceDivisor(value) {
  const price = parseNumber(value);
  const unit = String(process.env.GOLDPETAL_LTP_UNIT || 'auto').toLowerCase();
  if (unit === 'paise') return 100;
  if (unit === 'per10g' || unit === '10g') return 10;
  if (unit === 'per1g' || unit === '1g' || unit === 'rupees') return 1;

  // GOLDPETAL is quoted in rupees per gram. Some generic gold endpoints return
  // the standard MCX ₹/10g quote; detect that obvious unit mismatch.
  return price >= 50000 ? 10 : 1;
}

function normalizeGoldpetalPrice(value, divisor = 1) {
  const price = parseNumber(value);
  if (price == null) return null;
  return price / divisor;
}

function fetchJson(url, headers = {}, timeout = 10000) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const client = parsed.protocol === 'http:' ? http : https;
      const req = client.get(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port,
          path: `${parsed.pathname}${parsed.search}`,
          headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json', ...headers },
          timeout,
        },
        (r) => {
          let d = '';
          r.on('data', c => d += c);
          r.on('end', () => {
            if (r.statusCode < 200 || r.statusCode >= 300) return resolve(null);
            try { resolve(JSON.parse(d)); } catch(e) { resolve(null); }
          });
        }
      );
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    } catch(e) {
      resolve(null);
    }
  });
}

function authHeadersFromEnv() {
  const headers = {};
  if (process.env.GOLDPETAL_LTP_AUTH_HEADER && process.env.GOLDPETAL_LTP_AUTH_VALUE) {
    headers[process.env.GOLDPETAL_LTP_AUTH_HEADER] = process.env.GOLDPETAL_LTP_AUTH_VALUE;
  }
  if (process.env.GOLDPETAL_LTP_BEARER_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GOLDPETAL_LTP_BEARER_TOKEN}`;
  }
  if (process.env.GOLDPETAL_LTP_API_KEY_HEADER && process.env.GOLDPETAL_LTP_API_KEY) {
    headers[process.env.GOLDPETAL_LTP_API_KEY_HEADER] = process.env.GOLDPETAL_LTP_API_KEY;
  }
  return headers;
}

async function fetchGoldpetalAuthorizedQuote() {
  const url = process.env.GOLDPETAL_LTP_URL;
  if (!url) return null;

  const data = await fetchJson(url, authHeadersFromEnv());
  if (!data) return null;

  const pricePath = process.env.GOLDPETAL_LTP_PRICE_PATH || 'price';
  const prevPath = process.env.GOLDPETAL_LTP_PREV_PATH || 'previousClose';
  const changePath = process.env.GOLDPETAL_LTP_CHANGE_PATH || 'change';
  const timePath = process.env.GOLDPETAL_LTP_TIME_PATH || 'timestamp';

  const rawPrice = getPathValue(data, pricePath);
  const divisor = goldpetalPriceDivisor(rawPrice);
  const price = normalizeGoldpetalPrice(rawPrice, divisor);
  if (!price || price <= 0) return null;

  const prev = normalizeGoldpetalPrice(getPathValue(data, prevPath), divisor);
  const rawChange = parseNumber(getPathValue(data, changePath));
  const change = normalizeGoldpetalPrice(rawChange, divisor);
  return {
    price,
    prev: prev || (change != null ? price - change : price),
    source: 'authorized-goldpetal-feed',
    feedTime: getPathValue(data, timePath) || null,
  };
}

module.exports = {
  fetchGoldpetalAuthorizedQuote,
};
