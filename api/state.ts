const fs = require('fs/promises');
const path = require('path');

const KEY_PREFIX = 'td:shared-state';
const DEFAULT_STATE = {
  cash: 1000000,
  portfolio: {},
  orders: [],
  nextId: 1,
  scannerOn: false,
  scannerRisk: 5000,
  scannerLog: [],
  scannerTraded: {},
  scannerCursor: 0,
  scannerLastRun: 0,
  updatedAt: 0,
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) reject(new Error('Payload too large'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function cleanProfileId(value) {
  const id = String(value || 'default').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48);
  return id || 'default';
}

function getProfileId(req, payload) {
  const fromQuery = req?.query?.profileId || req?.query?.accountId;
  const fromPayload = payload?.profileId || payload?.accountId;
  return cleanProfileId(fromQuery || fromPayload);
}

function getStateKey(profileId) {
  return `${KEY_PREFIX}:${cleanProfileId(profileId)}`;
}

function getStateFilePath(profileId) {
  const safeId = cleanProfileId(profileId);
  if (process.env.VERCEL) return path.join('/tmp', `tradedesk-state-${safeId}.json`);
  return path.join(process.cwd(), 'data', `td_state_${safeId}.json`);
}

function sanitizeState(payload) {
  return {
    cash: Number(payload?.cash) || DEFAULT_STATE.cash,
    portfolio: payload?.portfolio && typeof payload.portfolio === 'object' ? payload.portfolio : {},
    orders: Array.isArray(payload?.orders) ? payload.orders : [],
    nextId: Number(payload?.nextId) || 1,
    scannerOn: Boolean(payload?.scannerOn),
    scannerRisk: Number(payload?.scannerRisk) || DEFAULT_STATE.scannerRisk,
    scannerLog: Array.isArray(payload?.scannerLog) ? payload.scannerLog : [],
    scannerTraded: payload?.scannerTraded && typeof payload.scannerTraded === 'object' ? payload.scannerTraded : {},
    scannerCursor: Number(payload?.scannerCursor) || 0,
    scannerLastRun: Number(payload?.scannerLastRun) || 0,
    updatedAt: Number(payload?.updatedAt) || Date.now(),
  };
}

async function readKvState(profileId) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const response = await fetch(`${url}/get/${encodeURIComponent(getStateKey(profileId))}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`KV read failed: ${response.status}`);
  const data = await response.json();
  return data?.result ? sanitizeState(JSON.parse(data.result)) : null;
}

async function writeKvState(profileId, payload) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false;
  const response = await fetch(`${url}/set/${encodeURIComponent(getStateKey(profileId))}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ value: JSON.stringify(payload) }),
  });
  if (!response.ok) throw new Error(`KV write failed: ${response.status}`);
  return true;
}

async function readFileState(profileId) {
  const filePath = getStateFilePath(profileId);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return sanitizeState(JSON.parse(raw));
  } catch (error) {
    return null;
  }
}

async function writeFileState(profileId, payload) {
  const filePath = getStateFilePath(profileId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

async function readState(profileId) {
  try {
    const kvState = await readKvState(profileId);
    if (kvState) return kvState;
  } catch (error) {
    console.error('Shared KV read failed:', error.message);
  }
  return (await readFileState(profileId)) || { ...DEFAULT_STATE };
}

async function writeState(profileId, payload) {
  try {
    const written = await writeKvState(profileId, payload);
    if (written) return;
  } catch (error) {
    console.error('Shared KV write failed:', error.message);
  }
  await writeFileState(profileId, payload);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method === 'GET') {
    const profileId = getProfileId(req);
    res.status(200).json({ ...(await readState(profileId)), profileId });
    return;
  }
  if (req.method === 'POST') {
    try {
      const body = await readBody(req);
      const rawPayload = body ? JSON.parse(body) : {};
      const profileId = getProfileId(req, rawPayload);
      const payload = { ...sanitizeState(rawPayload), profileId };
      const currentState = await readState(profileId);
      if ((currentState.updatedAt || 0) > payload.updatedAt) {
        res.status(409).json({ ...currentState, profileId });
        return;
      }
      await writeState(profileId, payload);
      res.status(200).json(payload);
    } catch (error) {
      res.status(400).json({ error: error.message || 'Invalid state payload' });
    }
    return;
  }
  res.status(405).json({ error: 'Method not allowed' });
};
