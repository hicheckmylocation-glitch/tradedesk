const https = require('https');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const symbol = (req.query.symbol || 'RELIANCE') + '.NS';
  const interval = req.query.interval || '5m';
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=1d`;

  https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => {
    let data = '';
    r.on('data', chunk => data += chunk);
    r.on('end', () => {
      try {
        const json = JSON.parse(data);
        const result = json.chart.result[0];
        const timestamps = result.timestamp;
        const ohlcv = result.indicators.quote[0];
        const candles = timestamps.map((t, i) => ({
          t: t * 1000,
          o: ohlcv.open[i],
          h: ohlcv.high[i],
          l: ohlcv.low[i],
          c: ohlcv.close[i],
          v: ohlcv.volume[i],
        })).filter(c => c.o && c.h && c.l && c.c);
        res.json({ success: true, data: candles });
      } catch(e) {
        res.json({ success: false, error: e.message });
      }
    });
  }).on('error', e => res.json({ success: false, error: e.message }));
};
