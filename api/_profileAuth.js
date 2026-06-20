const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const AUTH_KEY_PREFIX = 'td:profile-auth';
const COOKIE_NAME = 'td_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_PROFILE_PASSWORD = 'like0124';

function cleanProfileId(value) {
  const id = String(value || 'default').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48);
  return id || 'default';
}

function profileIdFromRequest(req, payload) {
  return cleanProfileId(
    req?.query?.profileId || req?.query?.accountId ||
    payload?.profileId || payload?.accountId
  );
}

function authKey(profileId) {
  return `${AUTH_KEY_PREFIX}:${cleanProfileId(profileId)}`;
}

function authFile(profileId) {
  const safeId = cleanProfileId(profileId);
  return process.env.VERCEL
    ? path.join('/tmp', `tradedesk-auth-${safeId}.json`)
    : path.join(process.cwd(), 'data', `td_auth_${safeId}.json`);
}

async function kvRead(profileId) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const response = await fetch(`${url}/get/${encodeURIComponent(authKey(profileId))}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  const data = await response.json();
  return data?.result ? JSON.parse(data.result) : null;
}

async function kvWrite(profileId, record) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false;
  const response = await fetch(`${url}/set/${encodeURIComponent(authKey(profileId))}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: JSON.stringify(record) }),
  });
  return response.ok;
}

async function readAuth(profileId) {
  try {
    const record = await kvRead(profileId);
    if (record) return record;
  } catch (error) {}
  try {
    return JSON.parse(await fs.readFile(authFile(profileId), 'utf8'));
  } catch (error) {
    const salt = crypto.createHash('sha256').update(`td-default-salt:${cleanProfileId(profileId)}`).digest('hex').slice(0, 32);
    return {
      salt,
      passwordHash: await passwordDigest(DEFAULT_PROFILE_PASSWORD, salt),
      sessions: [],
      createdAt: Date.now(),
      preset: true,
    };
  }
}

async function writeAuth(profileId, record) {
  try {
    if (await kvWrite(profileId, record)) return;
  } catch (error) {}
  const file = authFile(profileId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(record, null, 2), 'utf8');
}

async function passwordDigest(password, salt) {
  const result = await scrypt(password, salt, 64);
  return Buffer.from(result).toString('hex');
}

function safeEqualHex(left, right) {
  try {
    const a = Buffer.from(String(left), 'hex');
    const b = Buffer.from(String(right), 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (error) {
    return false;
  }
}

function parseCookies(req) {
  return String(req?.headers?.cookie || '').split(';').reduce((out, part) => {
    const index = part.indexOf('=');
    if (index < 0) return out;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    return out;
  }, {});
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function setSessionCookie(res, token) {
  const secure = process.env.VERCEL ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_MS / 1000)}${secure}`
  );
}

function clearSessionCookie(res) {
  const secure = process.env.VERCEL ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
}

async function createSession(profileId, record, res) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const sessions = (Array.isArray(record.sessions) ? record.sessions : [])
    .filter(session => Number(session.expiresAt) > now)
    .slice(-4);
  sessions.push({ hash: tokenHash(token), expiresAt: now + SESSION_MS });
  record.sessions = sessions;
  await writeAuth(profileId, record);
  setSessionCookie(res, token);
}

async function isAuthenticated(req, profileId) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return false;
  const record = await readAuth(profileId);
  if (!record) return false;
  const hash = tokenHash(token);
  const now = Date.now();
  return (record.sessions || []).some(session =>
    Number(session.expiresAt) > now && safeEqualHex(session.hash, hash)
  );
}

async function requireProfileSession(req, res, profileId) {
  if (await isAuthenticated(req, profileId)) return true;
  res.status(401).json({ error: 'Profile is locked', code: 'PROFILE_LOCKED' });
  return false;
}

async function setupPassword(profileId, password, res) {
  if (await readAuth(profileId)) {
    const error = new Error('Profile already has a password');
    error.statusCode = 409;
    throw error;
  }
  validatePassword(password);
  const salt = crypto.randomBytes(16).toString('hex');
  const record = {
    salt,
    passwordHash: await passwordDigest(password, salt),
    sessions: [],
    createdAt: Date.now(),
  };
  await createSession(profileId, record, res);
}

async function login(profileId, password, res) {
  const record = await readAuth(profileId);
  if (!record) {
    const error = new Error('Create a password first');
    error.statusCode = 404;
    throw error;
  }
  const candidate = await passwordDigest(String(password || ''), record.salt);
  if (!safeEqualHex(candidate, record.passwordHash)) {
    const error = new Error('Incorrect password');
    error.statusCode = 401;
    throw error;
  }
  await createSession(profileId, record, res);
}

function validatePassword(password) {
  const value = String(password || '');
  if (value.length < 8 || value.length > 128) {
    const error = new Error('Password must be 8 to 128 characters');
    error.statusCode = 400;
    throw error;
  }
}

async function logout(req, res, profileId) {
  const token = parseCookies(req)[COOKIE_NAME];
  const record = await readAuth(profileId);
  if (token && record) {
    const hash = tokenHash(token);
    record.sessions = (record.sessions || []).filter(session => !safeEqualHex(session.hash, hash));
    await writeAuth(profileId, record);
  }
  clearSessionCookie(res);
}

module.exports = {
  cleanProfileId,
  profileIdFromRequest,
  readAuth,
  setupPassword,
  login,
  logout,
  isAuthenticated,
  requireProfileSession,
};
