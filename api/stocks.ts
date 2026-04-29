const { getStocks } = require('./_stockUniverse');

module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json(getStocks());
};
