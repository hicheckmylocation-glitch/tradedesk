const axios = require("axios");

function getYahooSymbol(sym) {
  const map = { 'NIFTY':'^NSEI','BANKNIFTY':'^NSEBANK','FINNIFTY':'^NSEFIN','MIDCPNIFTY':'^NSEI' };
  return map[sym] || (sym + '.NS');
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=60');

  // Vercel dynamic routes: /api/history/TCS → req.query.symbol = 'TCS'
  const symbol = req.query.symbol || req.url.split('/').pop().split('?')[0];
  const interval = req.query.interval || '5m';
  const range    = req.query.range    || '5d';
  const yahooSym = getYahooSymbol(symbol);

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSym}?interval=${interval}&range=${range}&includePrePost=false`;
    const response = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 10000,
    });

    const result = response.data?.chart?.result?.[0];
    if(!result) return res.status(404).json({ error: 'No data' });

    const timestamps = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    const opens  = q.open   || [];
    const highs  = q.high   || [];
    const lows   = q.low    || [];
    const closes = q.close  || [];
    const vols   = q.volume || [];

    const candles = timestamps.map((ts, i) => ({
      time:  ts * 1000,
      open:  opens[i]  || null,
      high:  highs[i]  || null,
      low:   lows[i]   || null,
      close: closes[i] || null,
      vol:   vols[i]   || 0,
    })).filter(c => c.open && c.high && c.low && c.close);

    res.json({ candles, source: 'yahoo', symbol, interval, count: candles.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};
