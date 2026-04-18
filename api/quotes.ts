const https = require("https");

const STOCKS = {"NIFTY":"^NSEI","BANKNIFTY":"^NSEBANK","FINNIFTY":"^NSEFIN","MIDCPNIFTY":"^NSEI","RELIANCE":"RELIANCE.NS","TCS":"TCS.NS","HDFCBANK":"HDFCBANK.NS","INFY":"INFY.NS","ICICIBANK":"ICICIBANK.NS","HINDUNILVR":"HINDUNILVR.NS","BAJFINANCE":"BAJFINANCE.NS","WIPRO":"WIPRO.NS","SBIN":"SBIN.NS","AXISBANK":"AXISBANK.NS","MARUTI":"MARUTI.NS","TATAMOTORS":"TATAMOTORS.NS","SUNPHARMA":"SUNPHARMA.NS","NESTLEIND":"NESTLEIND.NS","KOTAKBANK":"KOTAKBANK.NS","LT":"LT.NS","HCLTECH":"HCLTECH.NS","TITAN":"TITAN.NS","ULTRACEMCO":"ULTRACEMCO.NS","ADANIENT":"ADANIENT.NS","BHARTIARTL":"BHARTIARTL.NS","ITC":"ITC.NS","NTPC":"NTPC.NS","ONGC":"ONGC.NS","DRREDDY":"DRREDDY.NS","CIPLA":"CIPLA.NS","DLF":"DLF.NS","ZOMATO":"ZOMATO.NS","DMART":"DMART.NS","IRCTC":"IRCTC.NS","TATAPOWER":"TATAPOWER.NS","TATASTEEL":"TATASTEEL.NS","HINDALCO":"HINDALCO.NS","VEDL":"VEDL.NS","BAJAJ-AUTO":"BAJAJ-AUTO.NS","EICHERMOT":"EICHERMOT.NS","HEROMOTOCO":"HEROMOTOCO.NS","ASIANPAINT":"ASIANPAINT.NS","HAVELLS":"HAVELLS.NS","DABUR":"DABUR.NS","MARICO":"MARICO.NS","BRITANNIA":"BRITANNIA.NS","COLPAL":"COLPAL.NS","PNB":"PNB.NS","BANKBARODA":"BANKBARODA.NS","YESBANK":"YESBANK.NS","INDUSINDBK":"INDUSINDBK.NS","TECHM":"TECHM.NS","LTIM":"LTIM.NS","PERSISTENT":"PERSISTENT.NS","ZYDUSLIFE":"ZYDUSLIFE.NS","LUPIN":"LUPIN.NS","GAIL":"GAIL.NS","BPCL":"BPCL.NS","COALINDIA":"COALINDIA.NS","RECLTD":"RECLTD.NS","PFC":"PFC.NS","HDFCLIFE":"HDFCLIFE.NS","SBILIFE":"SBILIFE.NS","MRF":"MRF.NS","SIEMENS":"SIEMENS.NS","ABB":"ABB.NS","DIXON":"DIXON.NS","POLYCAB":"POLYCAB.NS","TRENT":"TRENT.NS","BEL":"BEL.NS","ADANIGREEN":"ADANIGREEN.NS","ADANIPOWER":"ADANIPOWER.NS","JSWSTEEL":"JSWSTEEL.NS","SAIL":"SAIL.NS","GODREJCP":"GODREJCP.NS","PAYTM":"PAYTM.NS","NAUKRI":"NAUKRI.NS","PIDILITIND":"PIDILITIND.NS"};

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

  const requested = req.query.symbols ? req.query.symbols.split(",") : Object.keys(STOCKS);
  const result = {};

  await Promise.all(
    requested.map(async sym => {
      const yahooSym = STOCKS[sym] || (sym + ".NS");
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
