// ── VERCEL CRON SCANNER ──────────────────────────────────────────────────
// Runs every 5 minutes via vercel.json cron config.
// Fetches live prices, checks EMA20×EMA50 crossovers, auto-executes trades,
// and saves updated state — all server-side, 24/7, even when no browser is open.

const https = require('https');
const { QUOTE_SYMBOLS } = require('./_stockUniverse');

const EQUITY_LEVERAGE = 5;

// ── Re-use the state read/write helpers from state.ts ─────────────────────
const fs = require('fs/promises');
const path = require('path');
const KEY = 'td:shared-state';
const DEFAULT_STATE: any = {
  cash: 1000000, portfolio: {}, orders: [], nextId: 1,
  scannerOn: false, scannerRisk: 5000, scannerLog: [], scannerTraded: {}, updatedAt: 0,
};

function sanitize(p: any) {
  return {
    cash: Number(p?.cash) || DEFAULT_STATE.cash,
    portfolio: (p?.portfolio && typeof p.portfolio === 'object') ? p.portfolio : {},
    orders: Array.isArray(p?.orders) ? p.orders : [],
    nextId: Number(p?.nextId) || 1,
    scannerOn: Boolean(p?.scannerOn),
    scannerRisk: Number(p?.scannerRisk) || 5000,
    scannerLog: Array.isArray(p?.scannerLog) ? p.scannerLog : [],
    scannerTraded: (p?.scannerTraded && typeof p.scannerTraded === 'object') ? p.scannerTraded : {},
    updatedAt: Number(p?.updatedAt) || Date.now(),
  };
}

function getFilePath() {
  return process.env.VERCEL ? path.join('/tmp', 'tradedesk-state.json') : path.join(process.cwd(), 'data', 'td_state.json');
}

async function kvRead() {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(KEY)}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const d = await r.json();
  return d?.result ? sanitize(JSON.parse(d.result)) : null;
}

async function kvWrite(payload: any) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false;
  const r = await fetch(`${url}/set/${encodeURIComponent(KEY)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: JSON.stringify(payload) }),
  });
  return r.ok;
}

async function readState() {
  try { const k = await kvRead(); if (k) return k; } catch(e) {}
  try {
    const raw = await fs.readFile(getFilePath(), 'utf8');
    return sanitize(JSON.parse(raw));
  } catch(e) {}
  return { ...DEFAULT_STATE };
}

async function writeState(payload: any) {
  try { if (await kvWrite(payload)) return; } catch(e) {}
  try {
    await fs.mkdir(path.dirname(getFilePath()), { recursive: true });
    await fs.writeFile(getFilePath(), JSON.stringify(payload, null, 2), 'utf8');
  } catch(e) {}
}

// ── Fetch live prices via Yahoo Finance v7 ────────────────────────────────
function fetchQuotes(yahooSyms: string[]): Promise<any[]> {
  return new Promise((resolve) => {
    const fields = 'regularMarketPrice,regularMarketPreviousClose,regularMarketDayHigh,regularMarketDayLow';
    const p = `/v7/finance/quote?symbols=${encodeURIComponent(yahooSyms.join(','))}&fields=${encodeURIComponent(fields)}&formatted=false`;
    const req = https.get(
      { hostname: 'query2.finance.yahoo.com', path: p, headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 12000 },
      (r: any) => { let d = ''; r.on('data', (c: any) => d += c); r.on('end', () => { try { resolve(JSON.parse(d)?.quoteResponse?.result || []); } catch(e) { resolve([]); } }); }
    );
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
  });
}

// ── Fetch 5m candle history for EMA calculation ──────────────────────────
async function fetchCandles(sym: string, yahooSym: string): Promise<number[]> {
  return new Promise((resolve) => {
    const p = `/v8/finance/chart/${encodeURIComponent(yahooSym)}?range=5d&interval=5m&includePrePost=false`;
    const req = https.get(
      { hostname: 'query1.finance.yahoo.com', path: p, headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 },
      (r: any) => {
        let d = ''; r.on('data', (c: any) => d += c);
        r.on('end', () => {
          try {
            const closes = JSON.parse(d)?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
            resolve(closes.filter((v: any) => v != null && v > 0));
          } catch(e) { resolve([]); }
        });
      }
    );
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
  });
}

// ── EMA helper ────────────────────────────────────────────────────────────
function ema(closes: number[], period: number): number | null {
  if (!closes || closes.length < period) return null;
  const k = 2 / (period + 1);
  let v = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) v = closes[i] * k + v * (1 - k);
  return v;
}
function prevEma(closes: number[], period: number): number | null {
  if (!closes || closes.length < period + 1) return null;
  return ema(closes.slice(0, -1), period);
}

function fn(n: number) { return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

// ── MAIN HANDLER ─────────────────────────────────────────────────────────
module.exports = async (req: any, res: any) => {
  // Allow manual trigger via GET, but primary use is cron (no auth needed for hobby plan)
  res.setHeader('Access-Control-Allow-Origin', '*');

  const state = await readState();
  if (!state.scannerOn) {
    res.json({ ok: true, message: 'Scanner is OFF — no action taken' });
    return;
  }

  const allSymbols = Object.keys(QUOTE_SYMBOLS);
  const symToYahoo: Record<string, string> = {};
  const yahooToSym: Record<string, string> = {};
  allSymbols.forEach(sym => {
    const y = QUOTE_SYMBOLS[sym] || (sym + '.NS');
    symToYahoo[sym] = y;
    yahooToSym[y] = sym;
  });

  // 1. Fetch live prices
  const BATCH = 40;
  const prices: Record<string, { price: number; prev: number }> = {};
  for (let i = 0; i < allSymbols.length; i += BATCH) {
    const batch = allSymbols.slice(i, i + BATCH);
    const quotes = await fetchQuotes(batch.map(s => symToYahoo[s]));
    quotes.forEach(q => {
      const sym = yahooToSym[q.symbol];
      if (sym && q.regularMarketPrice > 0) {
        prices[sym] = { price: q.regularMarketPrice, prev: q.regularMarketPreviousClose || q.regularMarketPrice };
      }
    });
  }

  // 2. Check SL/Target exits on open auto-positions
  let changed = false;
  Object.entries(state.portfolio).forEach(([id, h]: [string, any]) => {
    if (!h.sl || !h.target) return;
    const curr = prices[h.symbol]?.price;
    if (!curr || curr <= 0) return;
    const hitSL = curr <= h.sl, hitTarget = curr >= h.target;
    if (!hitSL && !hitTarget) return;
    const pnl = (curr - h.avgPrice) * h.qty;
    const marginReleased = h.marginUsed || ((h.avgPrice * h.qty) / (h.leverage || EQUITY_LEVERAGE));
    state.cash += marginReleased + pnl;
    const orderId = state.nextId++;
    state.orders.unshift({
      id: orderId, symbol: h.symbol, side: 'SELL', qty: h.qty, price: curr,
      total: curr * h.qty, time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
      desc: `🤖 CRON AUTO EXIT (${hitTarget ? 'TARGET HIT' : 'SL HIT'}) P&L: ${pnl >= 0 ? '+' : ''}₹${fn(pnl)}`,
    });
    const sig = state.scannerLog.find((s: any) => s.sym === h.symbol && s.status === 'EXECUTED');
    if (sig) { sig.status = hitTarget ? '✅ TARGET' : '❌ SL HIT'; sig.pnl = pnl; }
    delete state.portfolio[id];
    changed = true;
  });

  // 3. Fetch candles for symbols not yet having scanHistory, scan for crossovers
  // Process in small batches to avoid timeout (Vercel max 10s for cron on hobby)
  const toScan = allSymbols.slice(0, 60); // top 60 most liquid
  for (let i = 0; i < toScan.length; i += 5) {
    const batch = toScan.slice(i, i + 5);
    await Promise.all(batch.map(async sym => {
      const closes = await fetchCandles(sym, symToYahoo[sym]);
      if (closes.length < 55) return;
      const e20 = ema(closes, 20), e50 = ema(closes, 50);
      const p20 = prevEma(closes, 20), p50 = prevEma(closes, 50);
      if (!e20 || !e50 || !p20 || !p50) return;
      const bullCross = p20 <= p50 && e20 > e50;
      const bearCross = p20 >= p50 && e20 < e50;
      if (!bullCross && !bearCross) return;

      const e100 = ema(closes, 100), e200 = ema(closes, 200);
      const price = prices[sym]?.price || closes[closes.length - 1];
      if (!price || price <= 0) return;

      // EMA alignment: price position relative to EMA100/200
      const bullAlign = !e100 || (price > e100 && (!e200 || e100 >= e200));
      const bearAlign = !e100 || (price < e100 && (!e200 || e100 <= e200));
      const confirmed = bullCross ? bullAlign : bearAlign;

      const dir = bullCross ? 'BUY' : 'SELL';
      const key = `${sym}_${dir}_${Math.round(e20)}_${Math.round(e50)}`;
      if (state.scannerTraded[key]) return;
      state.scannerTraded[key] = true;

      const recent = closes.slice(-5);
      const slPrice = bullCross ? Math.min(...recent) * 0.9995 : Math.max(...recent) * 1.0005;
      const riskPer = Math.abs(price - slPrice);
      if (riskPer <= 0) return;
      const qty = Math.max(1, Math.floor(state.scannerRisk / riskPer));
      const target = bullCross ? price + riskPer : price - riskPer;

      const sig: any = {
        id: Date.now() + Math.random(), sym, dir,
        entry: parseFloat(price.toFixed(2)),
        sl: parseFloat(slPrice.toFixed(2)),
        target: parseFloat(target.toFixed(2)),
        qty, rr: '1:1',
        time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
        status: 'SIGNAL', pnl: null, confirmed,
        source: 'cron',
      };

      if (!confirmed) {
        sig.status = 'SKIPPED (EMA trend not aligned)';
      } else if (bullCross) {
        const total = price * qty;
        const marginRequired = total / EQUITY_LEVERAGE;
        if (marginRequired <= state.cash) {
          state.cash -= marginRequired;
          const hId = `auto_${state.nextId++}`;
          state.portfolio[hId] = {
            symbol: sym, type: 'EQUITY', qty, avgPrice: price,
            sl: slPrice, target, marginUsed: marginRequired, leverage: EQUITY_LEVERAGE,
          };
          state.orders.unshift({
            id: state.nextId++, symbol: sym, side: 'BUY', qty, price, total,
            time: sig.time,
            desc: `🤖 CRON AUTO BUY EMA20×50↑ · ${EQUITY_LEVERAGE}x · Margin ₹${fn(marginRequired)} · SL:₹${fn(slPrice)} T:₹${fn(target)}`,
          });
          sig.status = 'EXECUTED';
          changed = true;
        } else {
          sig.status = 'SKIPPED (low cash)';
        }
      }
      state.scannerLog.unshift(sig);
      if (state.scannerLog.length > 100) state.scannerLog.pop();
      changed = true;
    }));
  }

  if (changed) {
    state.updatedAt = Date.now();
    await writeState(state);
  }

  res.json({ ok: true, checked: toScan.length, changed, scannerOn: state.scannerOn, ts: new Date().toISOString() });
};
