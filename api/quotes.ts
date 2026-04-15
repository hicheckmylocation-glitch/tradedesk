const https = require('https');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const symbols = req.query.symbols
    ? req.query.symbols.split(',').map(s => s.trim() + '.NS').join(',')
    : 'RELIANCE.NS,TCS.NS,HDFCBANK.NS,INFY.NS';

  const url = `https://query1.finance.yahoo.com/v8/finance/quote?symbols=${symbols}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketOpen,regularMarketDayHigh,regularMarketDayLow,regularMarketVolume,regularMarketPreviousClose`;

  https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => {
    let data = '';
    r.on('data', chunk => data += chunk);
    r.on('end', () => {
      try {
        const json = JSON.parse(data);
        const results = json.quoteResponse.result.map(q => ({
          symbol: q.symbol.replace('.NS',''),
          price: q.regularMarketPrice,
          change: q.regularMarketChange,
          changePct: q.regularMarketChangePercent,
          open: q.regularMarketOpen,
          high: q.regularMarketDayHigh,
          low: q.regularMarketDayLow,
          volume: q.regularMarketVolume,
          prevClose: q.regularMarketPreviousClose,
        }));
        res.json({ success: true, data: results });
      } catch(e) {
        res.json({ success: false, error: e.message });
      }
    });
  }).on('error', e => res.json({ success: false, error: e.message }));
};
