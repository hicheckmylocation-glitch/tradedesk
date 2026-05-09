const https = require("https");
const { QUOTE_SYMBOLS, STOCKS } = require('./_stockUniverse');

const SYM_MAP = { "NIFTY":"^NSEI","BANKNIFTY":"^NSEBANK","FINNIFTY":"^CNXFIN" };
const GOLD_SYMBOLS = new Set(['GOLD', 'GOLDM', 'GOLDPETAL']);
const TROY = 31.1035;
const GOLD_PREM = 1.035;
const DEFAULT_PRICES = Object.fromEntries(STOCKS.filter(s => s.defaultPrice).map(s => [s.symbol, s.defaultPrice]));

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (r) => {
      let d = "";
      r.on("data", c => d += c);
      r.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    }).on("error", reject).setTimeout(9000, function(){ this.destroy(); });
  });
}

function candlesFromChart(data) {
  const result = data?.chart?.result?.[0];
  if (!result) return [];
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  return ts.map((t, i) => ({
    time: t * 1000,
    open: q.open?.[i] || null,
    high: q.high?.[i] || null,
    low: q.low?.[i] || null,
    close: q.close?.[i] || null,
    vol: q.volume?.[i] || 0,
  })).filter(c => c.open && c.close);
}

function deriveGoldPrice(usdPerOz, usdInr, symbol) {
  const per10g = (usdPerOz / TROY) * 10 * usdInr * GOLD_PREM;
  return symbol === 'GOLDPETAL' ? per10g / 10 : per10g;
}

async function getDerivedGoldHistory(symbol, timeParam, interval) {
  const [goldData, inrData] = await Promise.all([
    get(`https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=${encodeURIComponent(interval)}&${timeParam}&includePrePost=false`),
    get(`https://query1.finance.yahoo.com/v8/finance/chart/INR%3DX?interval=${encodeURIComponent(interval)}&${timeParam}&includePrePost=false`),
  ]);
  const gold = candlesFromChart(goldData);
  const inr = candlesFromChart(inrData);
  if (!gold.length) return [];
  let lastInr = inr.find(c => c.close)?.close || 84;
  let inrIndex = 0;
  return gold.map(c => {
    while (inrIndex < inr.length && inr[inrIndex].time <= c.time) {
      lastInr = inr[inrIndex].close || lastInr;
      inrIndex++;
    }
    return {
      time: c.time,
      open: parseFloat(deriveGoldPrice(c.open, lastInr, symbol).toFixed(2)),
      high: parseFloat(deriveGoldPrice(c.high, lastInr, symbol).toFixed(2)),
      low: parseFloat(deriveGoldPrice(c.low, lastInr, symbol).toFixed(2)),
      close: parseFloat(deriveGoldPrice(c.close, lastInr, symbol).toFixed(2)),
      vol: c.vol || 0,
    };
  });
}

function fallbackGoldHistory(symbol, interval, range) {
  const base = DEFAULT_PRICES[symbol] || (symbol === 'GOLDPETAL' ? 15250 : 152500);
  const intervalMinutes = { '1m': 1, '5m': 5, '10m': 10, '15m': 15, '30m': 30, '60m': 60, '1h': 60 }[interval] || 5;
  const count = { '1d': 80, '5d': 160, '7d': 220, '60d': 260, '2y': 320 }[range] || 160;
  const now = Date.now();
  const seed = symbol.split('').reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  const candles = [];
  let close = base * (1 + Math.sin((Math.floor(now / 86400000) + seed) * 1.7) * 0.006);
  for (let i = count - 1; i >= 0; i--) {
    const time = now - i * intervalMinutes * 60000;
    const wave = Math.sin((Math.floor(time / 60000) + seed) / 11) * 0.0018;
    const drift = Math.sin((Math.floor(time / 86400000) + seed) * 1.7) * 0.0005;
    const open = close;
    close = Math.max(base * 0.95, open * (1 + wave + drift));
    const spread = Math.max(base * 0.0008, Math.abs(close - open) * 1.4);
    candles.push({
      time,
      open: parseFloat(open.toFixed(2)),
      high: parseFloat((Math.max(open, close) + spread).toFixed(2)),
      low: parseFloat((Math.min(open, close) - spread).toFixed(2)),
      close: parseFloat(close.toFixed(2)),
      vol: 0,
    });
  }
  return candles;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=60");
  const symbol = req.query.symbol || "RELIANCE";
  const interval = req.query.interval || "5m";
  const range = req.query.range || "5d";
  const period1 = req.query.period1 ? parseInt(req.query.period1) : null;
  const period2 = req.query.period2 ? parseInt(req.query.period2) : null;
  const ySym = SYM_MAP[symbol] || QUOTE_SYMBOLS[symbol] || (symbol + ".NS");
  const timeParam = (period1 && period2)
    ? `period1=${period1}&period2=${period2}`
    : `range=${range}`;
  try {
    if (GOLD_SYMBOLS.has(symbol)) {
      try {
        const candles = await getDerivedGoldHistory(symbol, timeParam, interval);
        if (candles.length > 3) {
          res.json({ candles, source: "derived-gold", count: candles.length });
          return;
        }
      } catch(e) {}
      const candles = fallbackGoldHistory(symbol, interval, range);
      res.json({ candles, source: "fallback-gold", count: candles.length });
      return;
    }
    const data = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym)}?interval=${encodeURIComponent(interval)}&${timeParam}&includePrePost=false`);
    const candles = candlesFromChart(data);
    if (!candles.length) return res.status(404).json({ error: "No data" });
    res.json({ candles, source: "yahoo", count: candles.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};
