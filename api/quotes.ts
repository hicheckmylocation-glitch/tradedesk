const https = require("https");

const STOCKS = {"NIFTY":"^NSEI","BANKNIFTY":"^NSEBANK","FINNIFTY":"^NSEFIN","MIDCPNIFTY":"^NSEI","RELIANCE":"RELIANCE.NS","TCS":"TCS.NS","HDFCBANK":"HDFCBANK.NS","INFY":"INFY.NS","ICICIBANK":"ICICIBANK.NS","HINDUNILVR":"HINDUNILVR.NS","BAJFINANCE":"BAJFINANCE.NS","WIPRO":"WIPRO.NS","SBIN":"SBIN.NS","AXISBANK":"AXISBANK.NS","MARUTI":"MARUTI.NS","TATAMOTORS":"TATAMOTORS.NS","SUNPHARMA":"SUNPHARMA.NS","NESTLEIND":"NESTLEIND.NS","KOTAKBANK":"KOTAKBANK.NS","LT":"LT.NS","HCLTECH":"HCLTECH.NS","TITAN":"TITAN.NS","ULTRACEMCO":"ULTRACEMCO.NS","ADANIENT":"ADANIENT.NS","BHARTIARTL":"BHARTIARTL.NS","ITC":"ITC.NS","NTPC":"NTPC.NS","ONGC":"ONGC.NS","DRREDDY":"DRREDDY.NS","CIPLA":"CIPLA.NS","DLF":"DLF.NS","ZOMATO":"ZOMATO.NS","DMART":"DMART.NS","IRCTC":"IRCTC.NS","TATAPOWER":"TATAPOWER.NS","TATASTEEL":"TATASTEEL.NS","HINDALCO":"HINDALCO.NS","VEDL":"VEDL.NS","BAJAJ-AUTO":"BAJAJ-AUTO.NS","EICHERMOT":"EICHERMOT.NS","HEROMOTOCO":"HEROMOTOCO.NS","ASIANPAINT":"ASIANPAINT.NS","HAVELLS":"HAVELLS.NS","DABUR":"DABUR.NS","MARICO":"MARICO.NS","BRITANNIA":"BRITANNIA.NS","COLPAL":"COLPAL.NS","PNB":"PNB.NS","BANKBARODA":"BANKBARODA.NS","YESBANK":"YESBANK.NS","INDUSINDBK":"INDUSINDBK.NS","TECHM":"TECHM.NS","LTIM":"LTIM.NS","PERSISTENT":"PERSISTENT.NS","ZYDUSLIFE":"ZYDUSLIFE.NS","LUPIN":"LUPIN.NS","GAIL":"GAIL.NS","BPCL":"BPCL.NS","COALINDIA":"COALINDIA.NS","RECLTD":"RECLTD.NS","PFC":"PFC.NS","HDFCLIFE":"HDFCLIFE.NS","SBILIFE":"SBILIFE.NS","MRF":"MRF.NS","SIEMENS":"SIEMENS.NS","ABB":"ABB.NS","DIXON":"DIXON.NS","POLYCAB":"POLYCAB.NS","TRENT":"TRENT.NS","BEL":"BEL.NS","ADANIGREEN":"ADANIGREEN.NS","ADANIPOWER":"ADANIPOWER.NS","JSWSTEEL":"JSWSTEEL.NS","SAIL":"SAIL.NS","GODREJCP":"GODREJCP.NS","PAYTM":"PAYTM.NS","NAUKRI":"NAUKRI.NS","PIDILITIND":"PIDILITIND.NS"};

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } }, (r) => {
      let d = "";
      r.on("data", c => d += c);
      r.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    }).on("error", reject).setTimeout(9000, function(){ this.destroy(); });
  });
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=30");
  const requested = req.query.symbols ? req.query.symbols.split(",") : Object.keys(STOCKS);
  const result = {};
  try {
    const batches = [];
    for (let i = 0; i < requested.length; i += 40) batches.push(requested.slice(i, i + 40));
    await Promise.all(batches.map(async batch => {
      const yahooSyms = batch.map(s => STOCKS[s] || (s + ".NS")).join(",");
      const data = await get(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${yahooSyms}`);
      const quotes = data?.quoteResponse?.result || [];
      quotes.forEach(q => {
        const sym = Object.keys(STOCKS).find(k => STOCKS[k] === q.symbol) || q.symbol.replace(".NS","");
        result[sym] = {
          symbol: sym,
          price: q.regularMarketPrice || 0,
          change: q.regularMarketChange || 0,
          changePct: q.regularMarketChangePercent || 0,
          volume: q.regularMarketVolume || 0,
          high: q.regularMarketDayHigh || 0,
          low: q.regularMarketDayLow || 0,
          open: q.regularMarketOpen || 0,
          close: q.regularMarketPreviousClose || 0,
          week52High: q.fiftyTwoWeekHigh || 0,
          week52Low: q.fiftyTwoWeekLow || 0,
          marketCap: q.marketCap || 0,
        };
      });
    }));
    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};
