const axios = require("axios");

const NSE_STOCKS = {
  "NIFTY":      { name:"Nifty 50 Index",             sector:"Index"        },
  "BANKNIFTY":  { name:"Bank Nifty Index",            sector:"Index"        },
  "FINNIFTY":   { name:"Nifty Financial Services",    sector:"Index"        },
  "MIDCPNIFTY": { name:"Nifty Midcap Select",         sector:"Index"        },
  "RELIANCE":   { name:"Reliance Industries",         sector:"Energy"       },
  "TCS":        { name:"Tata Consultancy Services",   sector:"IT"           },
  "HDFCBANK":   { name:"HDFC Bank",                   sector:"Banking"      },
  "INFY":       { name:"Infosys",                     sector:"IT"           },
  "ICICIBANK":  { name:"ICICI Bank",                  sector:"Banking"      },
  "HINDUNILVR": { name:"Hindustan Unilever",          sector:"FMCG"         },
  "BAJFINANCE": { name:"Bajaj Finance",               sector:"Finance"      },
  "WIPRO":      { name:"Wipro",                       sector:"IT"           },
  "SBIN":       { name:"State Bank of India",         sector:"Banking"      },
  "AXISBANK":   { name:"Axis Bank",                   sector:"Banking"      },
  "MARUTI":     { name:"Maruti Suzuki",               sector:"Auto"         },
  "TATAMOTORS": { name:"Tata Motors",                 sector:"Auto"         },
  "SUNPHARMA":  { name:"Sun Pharmaceutical",          sector:"Pharma"       },
  "NESTLEIND":  { name:"Nestle India",                sector:"FMCG"         },
  "KOTAKBANK":  { name:"Kotak Mahindra Bank",         sector:"Banking"      },
  "LT":         { name:"Larsen & Toubro",             sector:"Infra"        },
  "HCLTECH":    { name:"HCL Technologies",            sector:"IT"           },
  "TITAN":      { name:"Titan Company",               sector:"Consumer"     },
  "ULTRACEMCO": { name:"UltraTech Cement",            sector:"Cement"       },
  "ADANIENT":   { name:"Adani Enterprises",           sector:"Conglomerate" },
  "BHARTIARTL": { name:"Bharti Airtel",               sector:"Telecom"      },
  "ITC":        { name:"ITC",                         sector:"FMCG"         },
  "NTPC":       { name:"NTPC",                        sector:"Utilities"    },
  "ONGC":       { name:"Oil & Natural Gas Corp",      sector:"Energy"       },
  "DRREDDY":    { name:"Dr. Reddy's Laboratories",    sector:"Pharma"       },
  "CIPLA":      { name:"Cipla",                       sector:"Pharma"       },
  "DLF":        { name:"DLF",                         sector:"Real Estate"  },
  "ZOMATO":     { name:"Zomato",                      sector:"Internet"     },
  "DMART":      { name:"Avenue Supermarts",           sector:"Retail"       },
  "IRCTC":      { name:"IRCTC",                       sector:"Travel"       },
  "TATAPOWER":  { name:"Tata Power",                  sector:"Utilities"    },
  "TATASTEEL":  { name:"Tata Steel",                  sector:"Metals"       },
  "HINDALCO":   { name:"Hindalco Industries",         sector:"Metals"       },
  "VEDL":       { name:"Vedanta",                     sector:"Metals"       },
  "BAJAJ-AUTO": { name:"Bajaj Auto",                  sector:"Auto"         },
  "EICHERMOT":  { name:"Eicher Motors",               sector:"Auto"         },
  "HEROMOTOCO": { name:"Hero MotoCorp",               sector:"Auto"         },
  "ASIANPAINT": { name:"Asian Paints",                sector:"Consumer"     },
  "PIDILITIND": { name:"Pidilite Industries",         sector:"Consumer"     },
  "HAVELLS":    { name:"Havells India",               sector:"Consumer"     },
  "DABUR":      { name:"Dabur India",                 sector:"FMCG"         },
  "MARICO":     { name:"Marico",                      sector:"FMCG"         },
  "COLPAL":     { name:"Colgate-Palmolive India",     sector:"FMCG"         },
  "BRITANNIA":  { name:"Britannia Industries",        sector:"FMCG"         },
  "PNB":        { name:"Punjab National Bank",        sector:"Banking"      },
  "BANKBARODA": { name:"Bank of Baroda",              sector:"Banking"      },
  "CANBK":      { name:"Canara Bank",                 sector:"Banking"      },
  "IDFCFIRSTB": { name:"IDFC First Bank",             sector:"Banking"      },
  "YESBANK":    { name:"Yes Bank",                    sector:"Banking"      },
  "FEDERALBNK": { name:"Federal Bank",               sector:"Banking"      },
  "INDUSINDBK": { name:"IndusInd Bank",               sector:"Banking"      },
  "TECHM":      { name:"Tech Mahindra",               sector:"IT"           },
  "MPHASIS":    { name:"Mphasis",                     sector:"IT"           },
  "LTIM":       { name:"LTIMindtree",                 sector:"IT"           },
  "PERSISTENT": { name:"Persistent Systems",          sector:"IT"           },
  "COFORGE":    { name:"Coforge",                     sector:"IT"           },
  "NAUKRI":     { name:"Info Edge (Naukri)",          sector:"Internet"     },
  "PAYTM":      { name:"One 97 Communications",       sector:"Fintech"      },
  "ZYDUSLIFE":  { name:"Zydus Lifesciences",          sector:"Pharma"       },
  "LUPIN":      { name:"Lupin",                       sector:"Pharma"       },
  "AUROPHARMA": { name:"Aurobindo Pharma",            sector:"Pharma"       },
  "GAIL":       { name:"GAIL India",                  sector:"Energy"       },
  "BPCL":       { name:"Bharat Petroleum",            sector:"Energy"       },
  "COALINDIA":  { name:"Coal India",                  sector:"Mining"       },
  "RECLTD":     { name:"REC",                         sector:"Finance"      },
  "PFC":        { name:"Power Finance Corp",          sector:"Finance"      },
  "HDFCLIFE":   { name:"HDFC Life Insurance",         sector:"Insurance"    },
  "SBILIFE":    { name:"SBI Life Insurance",          sector:"Insurance"    },
  "ICICIGI":    { name:"ICICI Lombard",               sector:"Insurance"    },
  "MRF":        { name:"MRF",                         sector:"Auto"         },
  "BOSCHLTD":   { name:"Bosch",                       sector:"Auto"         },
  "SIEMENS":    { name:"Siemens India",               sector:"Industrial"   },
  "ABB":        { name:"ABB India",                   sector:"Industrial"   },
  "CUMMINSIND": { name:"Cummins India",               sector:"Industrial"   },
  "DIXON":      { name:"Dixon Technologies",          sector:"Consumer"     },
  "POLYCAB":    { name:"Polycab India",               sector:"Industrial"   },
  "GODREJPROP": { name:"Godrej Properties",           sector:"Real Estate"  },
  "TRENT":      { name:"Trent",                       sector:"Retail"       },
  "JUBLFOOD":   { name:"Jubilant FoodWorks",          sector:"Consumer"     },
  "BEL":        { name:"Bharat Electronics",          sector:"Defence"      },
  "TATAELXSI":  { name:"Tata Elxsi",                  sector:"IT"           },
  "CDSL":       { name:"CDSL",                        sector:"Finance"      },
  "ADANIGREEN": { name:"Adani Green Energy",          sector:"Utilities"    },
  "ADANIPOWER": { name:"Adani Power",                 sector:"Utilities"    },
  "JSWSTEEL":   { name:"JSW Steel",                   sector:"Metals"       },
  "SAIL":       { name:"Steel Authority of India",    sector:"Metals"       },
  "JINDALSTEL": { name:"Jindal Steel & Power",        sector:"Metals"       },
  "GODREJCP":   { name:"Godrej Consumer Products",   sector:"FMCG"         },
  "PAGEIND":    { name:"Page Industries",             sector:"Retail"       },
  "SRF":        { name:"SRF",                         sector:"Chemicals"    },
};

function getYahooSymbol(sym) {
  const map = { 'NIFTY':'^NSEI','BANKNIFTY':'^NSEBANK','FINNIFTY':'^NSEFIN','MIDCPNIFTY':'^NSEI' };
  return map[sym] || (sym + '.NS');
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=30');

  const { symbols } = req.query;
  const symList = symbols
    ? symbols.split(',').filter(s => NSE_STOCKS[s])
    : Object.keys(NSE_STOCKS);

  try {
    // Batch in groups of 50
    const batches = [];
    for(let i=0; i<symList.length; i+=50) batches.push(symList.slice(i,i+50));
    const result = {};

    await Promise.all(batches.map(async batch => {
      const yahooSyms = batch.map(getYahooSymbol).join(',');
      const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${yahooSyms}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketVolume,regularMarketDayHigh,regularMarketDayLow,regularMarketOpen,regularMarketPreviousClose,fiftyTwoWeekHigh,fiftyTwoWeekLow,marketCap`;
      const response = await axios.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/json' },
        timeout: 8000,
      });
      const quotes = response.data?.quoteResponse?.result || [];
      quotes.forEach(q => {
        const sym = Object.keys(NSE_STOCKS).find(s => getYahooSymbol(s) === q.symbol) || q.symbol.replace('.NS','');
        if(!NSE_STOCKS[sym]) return;
        result[sym] = {
          symbol: sym,
          name: NSE_STOCKS[sym].name,
          sector: NSE_STOCKS[sym].sector,
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
