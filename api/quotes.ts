const https = require("https");
const { QUOTE_SYMBOLS } = require('./_stockUniverse');

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

  res.json(result);
};
