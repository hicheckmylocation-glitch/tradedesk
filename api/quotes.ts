const https = require("https");
const { QUOTE_SYMBOLS, STOCKS } = require('./_stockUniverse');

// Build a map of symbol → defaultPrice for MCX/offline fallback
const DEFAULT_PRICES: Record<string, number> = {};
STOCKS.forEach((s: any) => { if(s.defaultPrice) DEFAULT_PRICES[s.symbol] = s.defaultPrice; });

// Fetch up to 40 symbols in ONE HTTP request using Yahoo Finance v7 batch API.
// This avoids the rate-limiting that happens when 50+ individual requests fire at once.
function fetchBatchV7(yahooSyms) {
  return new Promise((resolve) => {
    const fields = [
      'regularMarketPrice','regularMarketPreviousClose',
      'regularMarketDayHigh','regularMarketDayLow',
      'regularMarketOpen','regularMarketVolume',
      'fiftyTwoWeekHigh','fiftyTwoWeekLow','marketCap',
    ].join(',');
    const path = `/v7/finance/quote?symbols=${encodeURIComponent(yahooSyms.join(','))}&fields=${encodeURIComponent(fields)}&formatted=false&lang=en&region=IN`;
    const req = https.get(
      {
        hostname: "query2.finance.yahoo.com",
        path,
        headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
        timeout: 12000,
      },
      (r) => {
        let d = "";
        r.on("data", c => d += c);
        r.on("end", () => {
          try { resolve(JSON.parse(d)?.quoteResponse?.result || []); }
          catch(e) { resolve([]); }
        });
      }
    );
    req.on("error", () => resolve([]));
    req.on("timeout", () => { req.destroy(); resolve([]); });
  });
}

// Per-symbol v8 chart fallback for any symbol v7 returned 0/null for.
function fetchChartFallback(yahooSym) {
  return new Promise((resolve) => {
    const path = "/v8/finance/chart/" + encodeURIComponent(yahooSym) + "?range=5d&interval=1d&includePrePost=false";
    const req = https.get(
      { hostname: "query1.finance.yahoo.com", path, headers: { "User-Agent": "Mozilla/5.0" }, timeout: 8000 },
      (r) => {
        let d = "";
        r.on("data", c => d += c);
        r.on("end", () => {
          try {
            const chartResult = JSON.parse(d)?.chart?.result?.[0];
            if (!chartResult) { resolve(null); return; }
            const meta = chartResult.meta || {};
            if (!meta.regularMarketPrice) {
              const closes = chartResult?.indicators?.quote?.[0]?.close || [];
              for (let i = closes.length - 1; i >= 0; i--) {
                if (closes[i] != null && closes[i] > 0) { meta.regularMarketPrice = closes[i]; break; }
              }
            }
            resolve(meta.regularMarketPrice ? meta : null);
          } catch(e) { resolve(null); }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

// ── LIVE MCX PRICE DERIVATION ─────────────────────────────────────────────
// Yahoo Finance has no MCX feed, but we can derive accurate INR prices from
// international futures (COMEX/NYMEX) + live USD/INR rate.
const INTL_REFS = ['GC=F','SI=F','BZ=F','NG=F','HG=F','INR=X'];

async function fetchIntlRates(): Promise<Record<string, { price: number; prev: number }>> {
  const quotes: any[] = await fetchBatchV7(INTL_REFS) as any[];
  const r: Record<string, { price: number; prev: number }> = {};
  quotes.forEach(q => {
    if(q.regularMarketPrice) r[q.symbol] = { price: q.regularMarketPrice, prev: q.regularMarketPreviousClose || q.regularMarketPrice };
  });
  return r;
}

// Derive MCX INR prices from international rates
// Returns map of { symbol → { price, prev } }
function deriveMCXPrices(rates: Record<string, { price: number; prev: number }>): Record<string, { price: number; prev: number }> {
  const out: Record<string, { price: number; prev: number }> = {};
  const USDINR   = rates['INR=X']?.price || 84;
  const prevINR  = rates['INR=X']?.prev  || USDINR;
  const TROY     = 31.1035; // grams per troy oz
  // MCX import duty + GST premium over COMEX (~3.5% for gold, ~5% for silver)
  const GOLD_PREM = 1.035;
  const SILV_PREM = 1.05;

  const gcNow  = rates['GC=F']?.price, gcPrev = rates['GC=F']?.prev;
  const siNow  = rates['SI=F']?.price, siPrev = rates['SI=F']?.prev;
  const bzNow  = rates['BZ=F']?.price, bzPrev = rates['BZ=F']?.prev;
  const ngNow  = rates['NG=F']?.price, ngPrev = rates['NG=F']?.prev;
  const hgNow  = rates['HG=F']?.price, hgPrev = rates['HG=F']?.prev;

  if(gcNow) {
    const goldPer10g     = (gcNow  / TROY) * 10 * USDINR * GOLD_PREM;
    const goldPer10gPrev = (gcPrev / TROY) * 10 * prevINR * GOLD_PREM;
    out['GOLD']      = { price: Math.round(goldPer10g),      prev: Math.round(goldPer10gPrev) };
    out['GOLDM']     = { price: Math.round(goldPer10g),      prev: Math.round(goldPer10gPrev) };
    out['GOLDPETAL'] = { price: Math.round(goldPer10g / 10), prev: Math.round(goldPer10gPrev / 10) };
  }
  if(siNow) {
    const silverPerKg     = (siNow  / TROY) * 1000 * USDINR * SILV_PREM;
    const silverPerKgPrev = (siPrev / TROY) * 1000 * prevINR * SILV_PREM;
    out['SILVER']  = { price: Math.round(silverPerKg),     prev: Math.round(silverPerKgPrev) };
    out['SILVERM'] = { price: Math.round(silverPerKg),     prev: Math.round(silverPerKgPrev) };
  }
  if(bzNow) {
    // MCX Crude Oil tracks Brent (BZ=F), ₹/barrel
    out['CRUDEOIL'] = { price: Math.round(bzNow * USDINR), prev: Math.round(bzPrev * prevINR) };
  }
  if(ngNow) {
    // MCX Natural Gas tracks NYMEX NG, ₹/mmBtu
    out['NATURALGAS'] = { price: parseFloat((ngNow * USDINR).toFixed(1)), prev: parseFloat((ngPrev * prevINR).toFixed(1)) };
  }
  if(hgNow) {
    // HG=F is USD/pound; MCX Copper is ₹/kg; 1kg = 2.20462 lbs
    out['COPPER'] = { price: Math.round(hgNow * 2.20462 * USDINR), prev: Math.round(hgPrev * 2.20462 * prevINR) };
  }
  return out;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=30");

  const requested = (req.query.symbols ? req.query.symbols.split(",") : Object.keys(QUOTE_SYMBOLS)).filter(Boolean);
  const result = {};

  // Build bidirectional symbol maps
  const symToYahoo = {};
  const yahooToSym = {};
  requested.forEach(sym => {
    const y = QUOTE_SYMBOLS[sym] || (sym + ".NS");
    symToYahoo[sym] = y;
    yahooToSym[y] = sym;
  });
  const allYahoo = requested.map(s => symToYahoo[s]);

  // Step 1: Batch v7 requests (40 symbols per HTTP call)
  const BATCH = 40;
  const batches = [];
  for (let i = 0; i < allYahoo.length; i += BATCH) batches.push(allYahoo.slice(i, i + BATCH));

  await Promise.all(batches.map(async batch => {
    const quotes = await fetchBatchV7(batch);
    quotes.forEach(q => {
      const sym = yahooToSym[q.symbol];
      if (!sym) return;
      const price = q.regularMarketPrice;
      if (!price || price <= 0) return;
      const prev = q.regularMarketPreviousClose || price;
      result[sym] = {
        symbol: sym, price,
        change: price - prev,
        changePct: ((price - prev) / prev) * 100,
        volume: q.regularMarketVolume || 0,
        high: q.regularMarketDayHigh || price,
        low: q.regularMarketDayLow || price,
        open: q.regularMarketOpen || price,
        close: prev,
        week52High: q.fiftyTwoWeekHigh || 0,
        week52Low: q.fiftyTwoWeekLow || 0,
        marketCap: q.marketCap || 0,
      };
    });
  }));

  // Step 2: v8 chart fallback for any symbol that v7 returned nothing for
  const missing = requested.filter(sym => !result[sym]);
  if (missing.length > 0) {
    await Promise.all(missing.map(async sym => {
      const meta = await fetchChartFallback(symToYahoo[sym]);
      if (!meta) return;
      const price = meta.regularMarketPrice;
      const prev = meta.previousClose || meta.chartPreviousClose || price;
      result[sym] = {
        symbol: sym, price,
        change: price - prev,
        changePct: ((price - prev) / prev) * 100,
        volume: meta.regularMarketVolume || 0,
        high: meta.regularMarketDayHigh || price,
        low: meta.regularMarketDayLow || price,
        open: meta.regularMarketOpen || price,
        close: prev,
        week52High: meta.fiftyTwoWeekHigh || 0,
        week52Low: meta.fiftyTwoWeekLow || 0,
        marketCap: 0,
      };
    }));
  }

  // Step 3: MCX commodities — derive live INR prices from COMEX/NYMEX + USD/INR
  const stillMissing = requested.filter(sym => !result[sym]);
  if (stillMissing.length > 0) {
    let derived: Record<string, { price: number; prev: number }> = {};
    try {
      const intlRates = await fetchIntlRates();
      derived = deriveMCXPrices(intlRates);
    } catch(e) {}

    stillMissing.forEach(sym => {
      const d = derived[sym];
      const dp = DEFAULT_PRICES[sym];
      const price  = d?.price  || dp;
      const prev   = d?.prev   || dp;
      if(!price) return;
      const change = parseFloat((price - prev).toFixed(2));
      result[sym] = {
        symbol: sym, price,
        change,
        changePct: parseFloat(((change / (prev || price)) * 100).toFixed(2)),
        volume: 0,
        high: parseFloat((price * 1.002).toFixed(2)),
        low:  parseFloat((price * 0.998).toFixed(2)),
        open: prev,
        close: prev,
        week52High: 0, week52Low: 0, marketCap: 0,
      };
    });
  }

  res.json(result);
};
