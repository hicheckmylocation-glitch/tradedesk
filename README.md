# TradeDesk — Deploy to Vercel (Free)

## Folder Structure
```
vercel-deploy/
├── vercel.json        ← Vercel config
├── package.json       ← Dependencies
├── api/
│   ├── quotes.js      ← /api/quotes — live NSE prices
│   ├── history.js     ← /api/history — OHLCV candles
│   └── stocks.js      ← /api/stocks — stock list
└── public/
    └── index.html     ← Full trading platform
```

---

## Deploy in 3 Steps (5 minutes, completely free)

### Step 1 — Create GitHub Repository
1. Go to github.com → New repository → name it `tradedesk`
2. Upload ALL files from this folder maintaining the structure above
3. Click Commit

### Step 2 — Deploy on Vercel
1. Go to **vercel.com** → Sign up free (use GitHub login)
2. Click **"New Project"**
3. Import your `tradedesk` GitHub repo
4. Click **"Deploy"** — no settings to change!
5. Done! Vercel gives you a URL like `tradedesk.vercel.app`

### Step 3 — Open Your Platform
- Open `https://tradedesk.vercel.app`
- Real Yahoo Finance data loads automatically
- Real candle charts, live prices, everything works ✅

---

## What You Get on Vercel (Free Tier)
- ✅ 100GB bandwidth/month
- ✅ Custom domain support
- ✅ HTTPS automatically
- ✅ Auto-deploys when you push to GitHub
- ✅ No credit card needed
- ✅ Always on (no sleeping like Render)

---

## How Data Works
```
Your Browser
    ↓ fetch("/api/quotes")
Vercel Serverless Function (api/quotes.js)
    ↓ axios.get(Yahoo Finance)
Yahoo Finance API
    ↓ real NSE prices (15-min delay)
Your Browser ← renders live prices + charts
```

No CORS issues because the request goes server→Yahoo, not browser→Yahoo.
