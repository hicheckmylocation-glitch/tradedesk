const https = require("https");
const { QUOTE_SYMBOLS } = require('./_stockUniverse');

function fetchChart(yahooSym) {
  return new Promise((resolve) => {
    const path = "/v8/finance/chart/" + yahooSym + "?range=1d&interval=1d&includePrePost=false";
    const req = https.get(
      { hostname: "query1.finance.yahoo.com", path, headers: { "User-Agent": "Mozilla/5.0" }, timeout: 8000 },
      (r) => {
        let d = "";
        r.on("data", c => d += c);
        r.on("end", () => {
          try {
            const meta = JSON.parse(d)?.chart?.result?.[0]?.meta;
            resolve(meta || null);
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

  const requested = req.query.symbols ? req.query.symbols.split(",") : Object.keys(QUOTE_SYMBOLS);
  const result = {};

  await Promise.all(
    requested.map(async sym => {
      const yahooSym = QUOTE_SYMBOLS[sym] || (sym + ".NS");
      const meta = await fetchChart(yahooSym);
      if (meta && meta.regularMarketPrice) {
        const prev = meta.previousClose || meta.chartPreviousClose || meta.regularMarketPrice;
        result[sym] = {
          symbol: sym,
          price: meta.regularMarketPrice,
          change: meta.regularMarketPrice - prev,
          changePct: ((meta.regularMarketPrice - prev) / prev) * 100,
          volume: meta.regularMarketVolume || 0,
          high: meta.regularMarketDayHigh || 0,
          low: meta.regularMarketDayLow || 0,
          open: meta.regularMarketOpen || 0,
          close: prev,
          week52High: meta.fiftyTwoWeekHigh || 0,
          week52Low: meta.fiftyTwoWeekLow || 0,
          marketCap: 0,
        };
      }
    })
  );

  res.json(result);
};
