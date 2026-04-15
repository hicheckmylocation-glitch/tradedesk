export default async function handler(req, res) {
  const STOCKS = {
    RELIANCE: { name: "Reliance Industries", sector: "Energy" },
    TCS: { name: "Tata Consultancy Services", sector: "IT" },
    HDFCBANK: { name: "HDFC Bank", sector: "Banking" },
    INFY: { name: "Infosys", sector: "IT" },
    ICICIBANK: { name: "ICICI Bank", sector: "Banking" }
  };

  const result = {};

  Object.keys(STOCKS).forEach(symbol => {
    result[symbol] = {
      symbol,
      name: STOCKS[symbol].name,
      sector: STOCKS[symbol].sector,
      price: 0,
      change: 0,
      changePct: 0
    };
  });

  res.status(200).json(result);
}
