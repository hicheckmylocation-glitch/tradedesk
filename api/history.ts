const https = require("https");

const SYM_MAP = { "NIFTY":"^NSEI","BANKNIFTY":"^NSEBANK","FINNIFTY":"^CNXFIN" };

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (r) => {
      let d = "";
      r.on("data", c => d += c);
      r.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    }).on("error", reject).setTimeout(9000, function(){ this.destroy(); });
  });
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=60");
  const symbol = req.query.symbol || "RELIANCE";
  const interval = req.query.interval || "5m";
  const range = req.query.range || "5d";
  const ySym = SYM_MAP[symbol] || (symbol + ".NS");
  try {
    const data = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${ySym}?interval=${interval}&range=${range}&includePrePost=false`);
    const result = data?.chart?.result?.[0];
    if (!result) return res.status(404).json({ error: "No data" });
    const ts = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    const candles = ts.map((t, i) => ({
      time: t * 1000,
      open: q.open?.[i] || null,
      high: q.high?.[i] || null,
      low: q.low?.[i] || null,
      close: q.close?.[i] || null,
      vol: q.volume?.[i] || 0,
    })).filter(c => c.open && c.close);
    res.json({ candles, source: "yahoo", count: candles.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};
