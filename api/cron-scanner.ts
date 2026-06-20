const https = require('https');
const fs = require('fs/promises');
const path = require('path');
const { QUOTE_SYMBOLS, STOCKS } = require('./_stockUniverse');
const { fetchGoldpetalAuthorizedQuote } = require('./_goldpetalFeed');
const { cleanProfileId } = require('./_profileAuth');

const KEY_PREFIX = 'td:shared-state';
const EQUITY_LEVERAGE = 5;
const SCAN_BATCH_SIZE = 45;

// ── FINNHUB API: Free real-time data for equities ──
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || 'YOUR_FINNHUB_FREE_API_KEY';
const FINNHUB_BASE = 'https://finnhub.io/api/v1';

// MCX no-delay data needs an authorized broker/vendor feed. GOLDPETAL_LTP_URL
// can point at that feed; otherwise GOLDPETAL uses an indicative COMEX+USD/INR
// derivation so it never silently scans at zero.
const COMMODITY_SYMBOLS = new Set(['GOLDPETAL']);
const DEFAULT_PRICES = Object.fromEntries(STOCKS.filter((s: any) => s.defaultPrice).map((s: any) => [s.symbol, s.defaultPrice]));

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

function getStateKey(profileId: any) {
  return `${KEY_PREFIX}:${cleanProfileId(profileId)}`;
}

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

function getFilePath(profileId = 'default') {
  const safeId = cleanProfileId(profileId);
  return process.env.VERCEL ? path.join('/tmp', `tradedesk-state-${safeId}.json`) : path.join(process.cwd(), 'data', `td_state_${safeId}.json`);
}

async function kvRead(profileId: any) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(getStateKey(profileId))}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const d = await r.json();
  return d?.result ? sanitize(JSON.parse(d.result)) : null;
}

async function kvWrite(profileId: any, payload: any) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false;
  const r = await fetch(`${url}/set/${encodeURIComponent(getStateKey(profileId))}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: JSON.stringify(payload) }),
  });
  return r.ok;
}

async function readState(profileId: any) {
  try {
    const state = await kvRead(profileId);
    if (state) return state;
  } catch(e) {}
  try {
    return sanitize(JSON.parse(await fs.readFile(getFilePath(profileId), 'utf8')));
  } catch(e) {}
  return { ...DEFAULT_STATE };
}

async function writeState(profileId: any, payload: any) {
  try {
    if (await kvWrite(profileId, payload)) return;
  } catch(e) {}
  try {
    await fs.mkdir(path.dirname(getFilePath(profileId)), { recursive: true });
    await fs.writeFile(getFilePath(profileId), JSON.stringify(payload, null, 2), 'utf8');
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

async function fetchQuotes(symbols: string[]): Promise<any[]> {
  try {
    const results: any[] = [];
    
    for (const sym of symbols) {
      if (COMMODITY_SYMBOLS.has(sym)) {
        // ── COMMODITIES: Fetch from commodity API ──
        const commodityData = await fetchCommodityPrice(sym);
        if (commodityData) {
          results.push({
            symbol: sym,
            regularMarketPrice: commodityData.price,
            regularMarketPreviousClose: commodityData.price - commodityData.change,
          });
        }
        continue;
      }
      
      // ── EQUITIES: Use Finnhub ──
      const finnhubSym = `${sym}.NS`;
      const url = `${FINNHUB_BASE}/quote?symbol=${encodeURIComponent(finnhubSym)}&token=${FINNHUB_API_KEY}`;
      
      try {
        const response = await fetch(url);
        if (response.ok) {
          const data = await response.json();
          if (data.c > 0) {
            results.push({
              symbol: finnhubSym,
              regularMarketPrice: data.c,
              regularMarketPreviousClose: data.pc || data.c,
            });
          }
        }
      } catch (e) {
        // Continue to next symbol
      }
    }
    return results;
  } catch (e) {
    return [];
  }
}

async function fetchCandles(symbol: string): Promise<{ closes: number[]; lastTime: number }> {
  try {
    // ── COMMODITIES: Fetch from free commodity data source (MCX/NSE) ──
    if (COMMODITY_SYMBOLS.has(symbol)) {
      if (symbol === 'GOLDPETAL') {
        // GOLDPETAL is gold commodity - use free public commodity feed
        // For now, use a simple approach: fetch from a public commodity API or websocket
        // Best free source: Get price from public MCX data
        const commodityQuote = await fetchCommodityPrice('GOLDPETAL');
        if (commodityQuote) {
          // Return synthetic candles based on current price (fallback)
          // In production, you'd get real 5m candles from MCX API
          const price = commodityQuote.price;
          const closes = Array.from({ length: 60 }, (_, i) => {
            const wave = Math.sin((Date.now() / 60000 + i) / 8) * 0.0015;
            const drift = (i - 59) * 0.00002;
            return parseFloat((price * (1 + wave + drift)).toFixed(2));
          });
          closes[closes.length - 1] = price;
          return { closes, lastTime: Date.now() };
        }
      }
      return { closes: [], lastTime: 0 };
    }
    
    // ── EQUITIES: Use Finnhub with .NS suffix ──
    const sym = `${symbol}.NS`;
    const url = `${FINNHUB_BASE}/stock/candle?symbol=${encodeURIComponent(sym)}&resolution=5&from=${Math.floor(Date.now() / 1000) - 86400 * 5}&to=${Math.floor(Date.now() / 1000)}&token=${FINNHUB_API_KEY}`;
    
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Finnhub error: ${response.status}`);
    
    const data = await response.json();
    if (data.s !== 'ok' || !data.c) return { closes: [], lastTime: 0 };
    
    const closes = data.c.filter((v: any) => v > 0);
    const lastTime = data.t && data.t.length > 0 ? data.t[data.t.length - 1] * 1000 : Date.now();
    
    return { closes, lastTime };
  } catch (e) {
    return { closes: [], lastTime: 0 };
  }
}

async function fetchCommodityPrice(symbol: string): Promise<{ price: number; change: number } | null> {
  try {
    if (symbol === 'GOLDPETAL') {
      const authorized = await fetchGoldpetalAuthorizedQuote();
      if (authorized) {
        return {
          price: authorized.price,
          change: parseFloat((authorized.price - authorized.prev).toFixed(2)),
        };
      }

      try {
        const data = await getJson(
          'query2.finance.yahoo.com',
          `/v7/finance/quote?symbols=${encodeURIComponent('GC=F,INR=X')}&fields=${encodeURIComponent('regularMarketPrice,regularMarketPreviousClose')}&formatted=false&lang=en&region=IN`
        );
        const quotes = data?.quoteResponse?.result || [];
        const gold = quotes.find((q: any) => q.symbol === 'GC=F');
        const inr = quotes.find((q: any) => q.symbol === 'INR=X');
        if (gold?.regularMarketPrice && inr?.regularMarketPrice) {
          const troy = 31.1035;
          const premium = 1.035;
          const price = ((gold.regularMarketPrice / troy) * inr.regularMarketPrice * premium);
          const prevGold = gold.regularMarketPreviousClose || gold.regularMarketPrice;
          const prevInr = inr.regularMarketPreviousClose || inr.regularMarketPrice;
          const prev = ((prevGold / troy) * prevInr * premium);
          return {
            price: parseFloat(price.toFixed(2)),
            change: parseFloat((price - prev).toFixed(2)),
          };
        }
      } catch (e) {}

      return { price: DEFAULT_PRICES.GOLDPETAL || 10500, change: 0 };
      // ── MCX GOLDPETAL: Try multiple sources ──
      
      // Option 1: Use a commodity API with INR support
      // Try to fetch from a public API that has Indian commodity prices
      try {
        // Use a free commodity quotes endpoint
        const url = 'https://api.commoditiesapi.com/latest?base=USD&symbols=XAU';
        const response = await fetch(url);
        
        if (response.ok) {
          const data = await response.json();
          // XAU is USD per troy ounce, convert to INR per gram
          // 1 troy oz = 31.1035 grams
          // Approximate USD to INR = 83 (varies, but reasonable approximation)
          if (data.rates && data.rates.XAU) {
            const usdPerOz = data.rates.XAU;
            const inrPerGram = (usdPerOz / 31.1035) * 83; // Rough conversion
            return {
              price: parseFloat(inrPerGram.toFixed(2)),
              change: 0, // We don't have previous data
            };
          }
        }
      } catch (e) {
        // Fallback to next method
      }
      
      // Option 2: Use metals.live but with proper conversion
      try {
        const url = 'https://api.metals.live/v1/spot/gold';
        const response = await fetch(url, { 
          headers: { 'User-Agent': 'Mozilla/5.0' } 
        });
        
        if (response.ok) {
          const data = await response.json();
          // metals.live returns gold prices in USD per ounce
          if (data.price) {
            // Convert USD per troy ounce to INR per gram
            // 1 troy oz = 31.1035 grams
            // Rough USD to INR conversion rate (23 May 2026: ~83)
            const usdPerOz = data.price;
            const inrPerGram = (usdPerOz / 31.1035) * 83;
            return {
              price: parseFloat(inrPerGram.toFixed(2)),
              change: 0,
            };
          }
        }
      } catch (e) {
        // Fallback to mock data
      }
      
      // Fallback: Return null (scanner will skip GOLDPETAL)
      console.log(`[WARN] GOLDPETAL price unavailable - check commodity API`);
      return null;
    }
    return null;
  } catch (e) {
    console.log(`[WARN] Could not fetch commodity price for ${symbol}: ${e.message}`);
    return null;
  }
}

async function fetchCandles15m(symbol: string): Promise<{ closes: number[]; lastTime: number }> {
  try {
    // ── COMMODITIES: Return empty for now ──
    if (COMMODITY_SYMBOLS.has(symbol)) {
      return { closes: [], lastTime: 0 };
    }
    
    // ── EQUITIES: 15m candles ──
    const sym = `${symbol}.NS`;
    const url = `${FINNHUB_BASE}/stock/candle?symbol=${encodeURIComponent(sym)}&resolution=15&from=${Math.floor(Date.now() / 1000) - 86400 * 5}&to=${Math.floor(Date.now() / 1000)}&token=${FINNHUB_API_KEY}`;
    
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Finnhub error: ${response.status}`);
    
    const data = await response.json();
    if (data.s !== 'ok' || !data.c) return { closes: [], lastTime: 0 };
    
    const closes = data.c.filter((v: any) => v > 0);
    const lastTime = data.t && data.t.length > 0 ? data.t[data.t.length - 1] * 1000 : Date.now();
    
    return { closes, lastTime };
  } catch (e) {
    return { closes: [], lastTime: 0 };
  }
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

// ── PIVOT BREAK CONFIRMATION: Calculate pivot high/low from recent candles ──
function getPivotLevels(closes: number[], lookback: number = 5): { pivotHigh: number; pivotLow: number } {
  const completed = closes.slice(0, -1);
  const source = completed.length ? completed : closes;
  if (source.length < lookback) {
    return { pivotHigh: Math.max(...source), pivotLow: Math.min(...source) };
  }
  const recent = source.slice(-lookback);
  return {
    pivotHigh: Math.max(...recent),
    pivotLow: Math.min(...recent),
  };
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
  res.setHeader('Cache-Control', 'no-store');

  const profileId = cleanProfileId(req?.query?.profileId || req?.query?.accountId);
  const cronSecret = process.env.CRON_SECRET;
  const isTrustedCron = Boolean(cronSecret) && req?.headers?.authorization === `Bearer ${cronSecret}`;
  const state = await readState(profileId);
  if (!state.scannerOn) {
    res.json({ ok: true, scannerOn: false, message: 'Scanner is OFF, no action taken' });
    return;
  }

  const allSymbols = Object.keys(QUOTE_SYMBOLS);
  const symList: string[] = [];
  allSymbols.forEach(sym => {
    symList.push(sym);
  });

  state.scannerTraded = pruneScannerTraded(state.scannerTraded);
  state.scannerLastRun = Date.now();

  const prices: Record<string, { price: number; prev: number }> = {};
  for (let i = 0; i < allSymbols.length; i += 20) {
    const batch = allSymbols.slice(i, i + 20);
    const quotes = await fetchQuotes(batch);
    quotes.forEach(q => {
      const sym = q.symbol.replace('.NS', '');
      if (sym && q.regularMarketPrice > 0) {
        prices[sym] = { price: q.regularMarketPrice, prev: q.regularMarketPreviousClose || q.regularMarketPrice };
      }
    });
  }

  let changed = false;
  const now = new Date();
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const isMarketClose = hours === 15 && minutes >= 30; // 3:30 PM or later
  
  Object.entries(state.portfolio).forEach(([id, h]: [string, any]) => {
    const curr = prices[h.symbol]?.price;
    if (!curr || curr <= 0) return;
    
    // ── MARKET CLOSE EXIT: Exit all except GOLDPETAL at 3:30 PM ──
    if (isMarketClose && h.symbol !== 'GOLDPETAL') {
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
        desc: `CRON AUTO EXIT (MARKET CLOSE 3:30 PM) P&L: ${pnl >= 0 ? '+' : ''}₹${fn(pnl)}`,
      });
      const sig = state.scannerLog.find((s: any) => s.sym === h.symbol && s.status === 'EXECUTED');
      if (sig) { sig.status = 'MARKET CLOSE'; sig.pnl = pnl; }
      delete state.portfolio[id];
      changed = true;
      return;
    }
    
    // ── STANDARD SL/TARGET EXIT ──
    if (!h.sl || !h.target) return;
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
      const { closes, lastTime } = await fetchCandles(sym);
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
        const c15m = await fetchCandles15m(sym);
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
      
      // ── PIVOT BREAK CHECK: Only trade if price breaks pivot high (BUY) or pivot low (SELL) ──
      const { pivotHigh, pivotLow } = getPivotLevels(closes);
      const bullPivotBreak = price > pivotHigh;
      const bearPivotBreak = price < pivotLow;
      const pivotConfirmed = bullCross ? bullPivotBreak : bearPivotBreak;
      if (!pivotConfirmed) return;
      
      const key = `${sym}_${dir}_${lastTime || closes.length}_${Math.round(e20)}_${Math.round(e50)}`;
      if (state.scannerTraded[key]) return;

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
        pivotConfirmed,
        source: 'server',
      };

      if (!confirmed) {
        state.scannerTraded[key] = true;
        sig.status = 'SKIPPED (EMA trend not aligned)';
      } else if (bullCross) {
        state.scannerTraded[key] = true;
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
            desc: `CRON AUTO BUY EMA20x50 up · PIVOT BREAK ✓ · ${EQUITY_LEVERAGE}x · Margin ₹${fn(marginRequired)} · SL:₹${fn(slPrice)} T:₹${fn(target)}`,
          });
          sig.status = 'EXECUTED';
        } else {
          sig.status = 'SKIPPED (low cash)';
        }
      } else {
        state.scannerTraded[key] = true;
      }

      state.scannerLog.unshift(sig);
      if (state.scannerLog.length > 100) state.scannerLog.pop();
      changed = true;
    }));
  }

  state.updatedAt = Date.now();
  await writeState(profileId, state);

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
