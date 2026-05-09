const https = require('https');
const fs = require('fs/promises');
const path = require('path');
const { QUOTE_SYMBOLS } = require('./_stockUniverse');

const KEY = 'td:shared-state';
const EQUITY_LEVERAGE = 5;
const SCAN_BATCH_SIZE = 45;

const DEFAULT_STATE: any = {
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

function sanitize(p: any) {
  return {
    cash: Number(p?.cash) || DEFAULT_STATE.cash,
    portfolio: p?.portfolio && typeof p.portfolio === 'object' ? p.portfolio : {},
    orders: Array.isArray(p?.orders) ? p.orders : [],
    nextId: Number(p?.nextId) || 1,
    scannerOn: Boolean(p?.scannerOn),
    scannerRisk: Number(p?.scannerRisk) || DEFAULT_STATE.scannerRisk,
    scannerLog: Array.isArray(p?.scannerLog) ? p.scannerLog : [],
    scannerTraded: p?.scannerTraded && typeof p.scannerTraded === 'object' ? p.scannerTraded : {},
    scannerCursor: Number(p?.scannerCursor) || 0,
    scannerLastRun: Number(p?.scannerLastRun) || 0,
    updatedAt: Number(p?.updatedAt) || Date.now(),
  };
}

function getFilePath() {
  return process.env.VERCEL ? path.join('/tmp', 'tradedesk-state.json') : path.join(process.cwd(), 'data', 'td_state.json');
}

async function kvRead() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(KEY)}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const d = await r.json();
  return d?.result ? sanitize(JSON.parse(d.result)) : null;
}

async function kvWrite(payload: any) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false;
  const r = await fetch(`${url}/set/${encodeURIComponent(KEY)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: JSON.stringify(payload) }),
  });
  return r.ok;
}

async function readState() {
  try {
    const state = await kvRead();
    if (state) return state;
  } catch(e) {}
  try {
    return sanitize(JSON.parse(await fs.readFile(getFilePath(), 'utf8')));
  } catch(e) {}
  return { ...DEFAULT_STATE };
}

async function writeState(payload: any) {
  try {
    if (await kvWrite(payload)) return;
  } catch(e) {}
  try {
    await fs.mkdir(path.dirname(getFilePath()), { recursive: true });
    await fs.writeFile(getFilePath(), JSON.stringify(payload, null, 2), 'utf8');
  } catch(e) {}
}

function getJson(hostname: string, requestPath: string, timeout = 10000): Promise<any> {
  return new Promise((resolve) => {
    const req = https.get(
      { hostname, path: requestPath, headers: { 'User-Agent': 'Mozilla/5.0' }, timeout },
      (r: any) => {
        let d = '';
        r.on('data', (c: any) => d += c);
        r.on('end', () => {
          try { resolve(JSON.parse(d)); } catch(e) { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function fetchQuotes(yahooSyms: string[]): Promise<any[]> {
  const fields = 'regularMarketPrice,regularMarketPreviousClose,regularMarketDayHigh,regularMarketDayLow';
  const p = `/v7/finance/quote?symbols=${encodeURIComponent(yahooSyms.join(','))}&fields=${encodeURIComponent(fields)}&formatted=false`;
  return (await getJson('query2.finance.yahoo.com', p, 12000))?.quoteResponse?.result || [];
}

async function fetchCandles(yahooSym: string): Promise<{ closes: number[]; lastTime: number }> {
  const p = `/v8/finance/chart/${encodeURIComponent(yahooSym)}?range=5d&interval=5m&includePrePost=false`;
  const data = await getJson('query1.finance.yahoo.com', p, 10000);
  const result = data?.chart?.result?.[0];
  const rawCloses = result?.indicators?.quote?.[0]?.close || [];
  const rawTimes = result?.timestamp || [];
  const closes: number[] = [];
  let lastTime = 0;
  rawCloses.forEach((v: any, i: number) => {
    if (v != null && v > 0) {
      closes.push(v);
      lastTime = rawTimes[i] || lastTime;
    }
  });
  return { closes, lastTime };
}

async function fetchCandles15m(yahooSym: string): Promise<{ closes: number[]; lastTime: number }> {
  const p = `/v8/finance/chart/${encodeURIComponent(yahooSym)}?range=5d&interval=15m&includePrePost=false`;
  const data = await getJson('query1.finance.yahoo.com', p, 10000);
  const result = data?.chart?.result?.[0];
  const rawCloses = result?.indicators?.quote?.[0]?.close || [];
  const rawTimes = result?.timestamp || [];
  const closes: number[] = [];
  let lastTime = 0;
  rawCloses.forEach((v: any, i: number) => {
    if (v != null && v > 0) {
      closes.push(v);
      lastTime = rawTimes[i] || lastTime;
    }
  });
  return { closes, lastTime };
}

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

function fn(n: number) {
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function tradeDayKey(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addOrder(state: any, order: any) {
  const timestamp = Date.now();
  state.orders.unshift({
    ...order,
    timestamp,
    tradeDate: tradeDayKey(timestamp),
    time: new Date(timestamp).toLocaleTimeString('en-IN', { hour12: true }),
    id: state.nextId++,
  });
}

function pruneScannerTraded(scannerTraded: Record<string, any>) {
  const keys = Object.keys(scannerTraded || {});
  if (keys.length <= 1200) return scannerTraded || {};
  const keep = new Set(keys.slice(-900));
  return Object.fromEntries(keys.filter(k => keep.has(k)).map(k => [k, scannerTraded[k]]));
}

function getScanSlice(symbols: string[], cursor: number) {
  const size = Math.min(SCAN_BATCH_SIZE, symbols.length);
  const start = Math.max(0, cursor || 0) % symbols.length;
  return {
    start,
    nextCursor: (start + size) % symbols.length,
    symbols: Array.from({ length: size }, (_, i) => symbols[(start + i) % symbols.length]),
  };
}

module.exports = async (req: any, res: any) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const state = await readState();
  if (!state.scannerOn) {
    res.json({ ok: true, scannerOn: false, message: 'Scanner is OFF, no action taken' });
    return;
  }

  const allSymbols = Object.keys(QUOTE_SYMBOLS);
  const symToYahoo: Record<string, string> = {};
  const yahooToSym: Record<string, string> = {};
  allSymbols.forEach(sym => {
    const y = QUOTE_SYMBOLS[sym] || `${sym}.NS`;
    symToYahoo[sym] = y;
    yahooToSym[y] = sym;
  });

  state.scannerTraded = pruneScannerTraded(state.scannerTraded);
  state.scannerLastRun = Date.now();

  const prices: Record<string, { price: number; prev: number }> = {};
  for (let i = 0; i < allSymbols.length; i += 40) {
    const batch = allSymbols.slice(i, i + 40);
    const quotes = await fetchQuotes(batch.map(s => symToYahoo[s]));
    quotes.forEach(q => {
      const sym = yahooToSym[q.symbol];
      if (sym && q.regularMarketPrice > 0) {
        prices[sym] = { price: q.regularMarketPrice, prev: q.regularMarketPreviousClose || q.regularMarketPrice };
      }
    });
  }

  let changed = false;
  Object.entries(state.portfolio).forEach(([id, h]: [string, any]) => {
    if (!h.sl || !h.target) return;
    const curr = prices[h.symbol]?.price;
    if (!curr || curr <= 0) return;
    const hitSL = curr <= h.sl;
    const hitTarget = curr >= h.target;
    if (!hitSL && !hitTarget) return;

    const pnl = (curr - h.avgPrice) * h.qty;
    const marginReleased = h.marginUsed || ((h.avgPrice * h.qty) / (h.leverage || EQUITY_LEVERAGE));
    state.cash += marginReleased + pnl;
    addOrder(state, {
      symbol: h.symbol,
      side: 'SELL',
      qty: h.qty,
      price: curr,
      total: curr * h.qty,
      charges: 0,
      realizedPnl: pnl,
      grossPnl: pnl,
      desc: `CRON AUTO EXIT (${hitTarget ? 'TARGET HIT' : 'SL HIT'}) P&L: ${pnl >= 0 ? '+' : ''}₹${fn(pnl)}`,
    });
    const sig = state.scannerLog.find((s: any) => s.sym === h.symbol && s.status === 'EXECUTED');
    if (sig) { sig.status = hitTarget ? 'TARGET' : 'SL HIT'; sig.pnl = pnl; }
    delete state.portfolio[id];
    changed = true;
  });

  const scan = getScanSlice(allSymbols, state.scannerCursor);
  state.scannerCursor = scan.nextCursor;

  for (let i = 0; i < scan.symbols.length; i += 5) {
    const batch = scan.symbols.slice(i, i + 5);
    await Promise.all(batch.map(async sym => {
      const { closes, lastTime } = await fetchCandles(symToYahoo[sym]);
      if (closes.length < 55) return;
      const e20 = ema(closes, 20), e50 = ema(closes, 50);
      const p20 = prevEma(closes, 20), p50 = prevEma(closes, 50);
      if (!e20 || !e50 || !p20 || !p50) return;

      const bullCross = p20 <= p50 && e20 > e50;
      const bearCross = p20 >= p50 && e20 < e50;
      if (!bullCross && !bearCross) return;

      // ── GAP CHECK: Only take signal if EMA20 & EMA50 are close (small gap = true signal) ──
      const gapPct = Math.abs(e20 - e50) / Math.max(e50, 1) * 100;
      const MAX_GAP = 0.5;
      if (gapPct > MAX_GAP) return;

      // ── 15m RESISTANCE/SUPPORT CHECK: Avoid entries too close to 15m EMA100/200 ──
      let skip15m = false;
      try {
        const c15m = await fetchCandles15m(symToYahoo[sym]);
        if (c15m.closes.length >= 100) {
          const e100_15m = ema(c15m.closes, 100);
          const e200_15m = ema(c15m.closes, 200);
          const price = prices[sym]?.price || closes[closes.length - 1];
          // For BUY: skip if price is too close to 15m EMA100 resistance (within 0.5% above)
          if (bullCross && e100_15m && price < e100_15m * 1.005) skip15m = true;
          // For SELL: skip if price is too close to 15m EMA200 support (within 0.5% below)
          if (bearCross && e200_15m && price > e200_15m * 0.995) skip15m = true;
        }
      } catch(e) {}
      if (skip15m) return;

      const e100 = ema(closes, 100), e200 = ema(closes, 200);
      const price = prices[sym]?.price || closes[closes.length - 1];
      if (!price || price <= 0) return;
      const bullAlign = !e100 || (price > e100 && (!e200 || e100 >= e200));
      const bearAlign = !e100 || (price < e100 && (!e200 || e100 <= e200));
      const confirmed = bullCross ? bullAlign : bearAlign;
      const dir = bullCross ? 'BUY' : 'SELL';
      const key = `${sym}_${dir}_${lastTime || closes.length}_${Math.round(e20)}_${Math.round(e50)}`;
      if (state.scannerTraded[key]) return;
      state.scannerTraded[key] = true;

      const recent = closes.slice(-5);
      const slPrice = bullCross ? Math.min(...recent) * 0.9995 : Math.max(...recent) * 1.0005;
      const riskPer = Math.abs(price - slPrice);
      if (riskPer <= 0) return;
      const qty = Math.max(1, Math.floor(state.scannerRisk / riskPer));
      const target = bullCross ? price + riskPer : price - riskPer;

      const sig: any = {
        id: Date.now() + Math.random(),
        sym,
        dir,
        entry: parseFloat(price.toFixed(2)),
        sl: parseFloat(slPrice.toFixed(2)),
        target: parseFloat(target.toFixed(2)),
        qty,
        rr: '1:1',
        time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
        status: 'SIGNAL',
        pnl: null,
        confirmed,
        source: 'server',
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
            id: hId,
            openedAt: Date.now(),
            symbol: sym,
            type: 'EQUITY',
            qty,
            avgPrice: price,
            sl: slPrice,
            target,
            marginUsed: marginRequired,
            leverage: EQUITY_LEVERAGE,
          };
          addOrder(state, {
            symbol: sym,
            side: 'BUY',
            qty,
            price,
            total,
            charges: 0,
            realizedPnl: 0,
            desc: `CRON AUTO BUY EMA20x50 up · ${EQUITY_LEVERAGE}x · Margin ₹${fn(marginRequired)} · SL:₹${fn(slPrice)} T:₹${fn(target)}`,
          });
          sig.status = 'EXECUTED';
        } else {
          sig.status = 'SKIPPED (low cash)';
        }
      }

      state.scannerLog.unshift(sig);
      if (state.scannerLog.length > 100) state.scannerLog.pop();
      changed = true;
    }));
  }

  state.updatedAt = Date.now();
  await writeState(state);

  res.json({
    ok: true,
    scannerOn: state.scannerOn,
    checked: scan.symbols.length,
    cursorStart: scan.start,
    nextCursor: state.scannerCursor,
    changed,
    ts: new Date().toISOString(),
  });
};
