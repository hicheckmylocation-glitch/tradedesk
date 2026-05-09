import json
import mimetypes
import os
import re
import threading
import time
import math
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / 'public'
STATE_FILE = ROOT / 'data' / 'td_state.json'
STOCKS_FILE = ROOT / 'api' / '_stockUniverse.js'


def parse_stock_universe():
    raw = STOCKS_FILE.read_text(encoding='utf-8')
    stocks = []
    quote_symbols = {}
    default_prices = {}
    for block in re.findall(r"\{([^{}]+)\}", raw):
        symbol = re.search(r"symbol: '([^']+)'", block)
        name = re.search(r"name: '([^']+)'", block)
        sector = re.search(r"sector: '([^']+)'", block)
        if not symbol or not name or not sector:
            continue
        yahoo = re.search(r"yahoo: '([^']+)'", block)
        default_price = re.search(r"defaultPrice: ([0-9.]+)", block)
        symbol = symbol.group(1)
        stock = {'symbol': symbol, 'name': name.group(1), 'sector': sector.group(1)}
        if default_price:
            stock['defaultPrice'] = float(default_price.group(1))
            default_prices[symbol] = stock['defaultPrice']
        stocks.append(stock)
        quote_symbols[symbol] = yahoo.group(1) if yahoo else f'{symbol}.NS'
    return stocks, quote_symbols, default_prices


STOCKS, QUOTE_SYMBOLS, DEFAULT_PRICES = parse_stock_universe()
GOLD_SYMBOLS = {'GOLD', 'GOLDM', 'GOLDPETAL'}
TROY = 31.1035
GOLD_PREM = 1.035
STATE_LOCK = threading.Lock()
DEFAULT_STATE = {
    'cash': 1000000,
    'portfolio': {},
    'orders': [],
    'nextId': 1,
    'scannerOn': False,
    'scannerRisk': 5000,
    'scannerLog': [],
    'scannerTraded': {},
    'updatedAt': 0,
}


def json_response(handler, status, payload):
    body = json.dumps(payload).encode('utf-8')
    handler.send_response(status)
    handler.send_header('Content-Type', 'application/json; charset=utf-8')
    handler.send_header('Access-Control-Allow-Origin', '*')
    handler.send_header('Cache-Control', 'no-store')
    handler.send_header('Content-Length', str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def read_state():
    with STATE_LOCK:
      if not STATE_FILE.exists():
          return dict(DEFAULT_STATE)
      try:
          payload = json.loads(STATE_FILE.read_text(encoding='utf-8'))
      except (OSError, json.JSONDecodeError):
          return dict(DEFAULT_STATE)
      state = dict(DEFAULT_STATE)
      state.update(payload)
      return state


def write_state(payload):
    with STATE_LOCK:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps(payload, indent=2), encoding='utf-8')


def fetch_json(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=6) as response:
        return json.loads(response.read().decode('utf-8'))


def fetch_batch_v7(yahoo_symbols):
    """Fetch up to 40 Yahoo Finance symbols in a single HTTP request (v7 batch API)."""
    fields = 'regularMarketPrice,regularMarketPreviousClose,regularMarketDayHigh,regularMarketDayLow,regularMarketOpen,regularMarketVolume,fiftyTwoWeekHigh,fiftyTwoWeekLow,marketCap'
    joined = ','.join(yahoo_symbols)
    url = (
        f'https://query2.finance.yahoo.com/v7/finance/quote'
        f'?symbols={urllib.parse.quote(joined)}'
        f'&fields={urllib.parse.quote(fields)}'
        f'&formatted=false&lang=en&region=IN'
    )
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json'})
        with urllib.request.urlopen(req, timeout=12) as r:
            data = json.loads(r.read().decode('utf-8'))
        return data.get('quoteResponse', {}).get('result') or []
    except Exception:
        return []


def fetch_quote(symbol):
    yahoo_symbol = QUOTE_SYMBOLS.get(symbol, f'{symbol}.NS')
    # Use 5d range so we always have recent closes available when market is closed
    # (weekends, holidays, pre-market). encodeURIComponent handles & in M&M.NS etc.
    url = f'https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(yahoo_symbol)}?range=5d&interval=1d&includePrePost=false'
    data = fetch_json(url)
    chart_result = ((data.get('chart') or {}).get('result') or [None])[0] or {}
    meta = chart_result.get('meta') or {}
    price = meta.get('regularMarketPrice')
    # Fallback: walk backwards through daily closes to find the last valid price
    if not price:
        closes = (((chart_result.get('indicators') or {}).get('quote') or [{}])[0].get('close') or [])
        for c in reversed(closes):
            if c is not None and c > 0:
                price = c
                break
    if not price:
        return None
    prev = meta.get('previousClose') or meta.get('chartPreviousClose') or price
    return {
        'symbol': symbol,
        'price': price,
        'change': price - prev,
        'changePct': ((price - prev) / prev * 100) if prev else 0,
        'volume': meta.get('regularMarketVolume') or 0,
        'high': meta.get('regularMarketDayHigh') or price,
        'low': meta.get('regularMarketDayLow') or price,
        'open': meta.get('regularMarketOpen') or price,
        'close': prev,
        'week52High': meta.get('fiftyTwoWeekHigh') or 0,
        'week52Low': meta.get('fiftyTwoWeekLow') or 0,
        'marketCap': 0,
    }


def chart_candles(data):
    result = ((data.get('chart') or {}).get('result') or [None])[0]
    if not result:
        return []
    timestamps = result.get('timestamp') or []
    quote = ((result.get('indicators') or {}).get('quote') or [{}])[0]
    candles = []
    for index, ts in enumerate(timestamps):
        open_val = (quote.get('open') or [None])[index]
        close_val = (quote.get('close') or [None])[index]
        high_val = (quote.get('high') or [None])[index]
        low_val = (quote.get('low') or [None])[index]
        vol_val = (quote.get('volume') or [0])[index]
        if open_val is None or close_val is None:
            continue
        candles.append({
            'time': ts * 1000,
            'open': open_val,
            'high': high_val,
            'low': low_val,
            'close': close_val,
            'vol': vol_val or 0,
        })
    return candles


def derive_gold_price(usd_per_oz, usd_inr, symbol):
    per_10g = (usd_per_oz / TROY) * 10 * usd_inr * GOLD_PREM
    return per_10g / 10 if symbol == 'GOLDPETAL' else per_10g


def moving_fallback_price(default_price, symbol):
    now = int(time.time())
    day = now // 86400
    minute = now // 60
    seed = sum(ord(ch) for ch in symbol)
    day_wave = math.sin((day + seed) * 1.7) * 0.006
    minute_wave = math.sin((minute + seed) / 11) * 0.0025
    prev_wave = math.sin((day - 1 + seed) * 1.7) * 0.006
    return {
        'price': round(default_price * (1 + day_wave + minute_wave), 2),
        'prev': round(default_price * (1 + prev_wave), 2),
    }


def fetch_derived_gold_quote(symbol):
    quotes = fetch_batch_v7(['GC=F', 'INR=X'])
    rates = {q.get('symbol'): q for q in quotes}
    gc = rates.get('GC=F') or {}
    inr = rates.get('INR=X') or {}
    gc_price = gc.get('regularMarketPrice')
    if not gc_price:
        return None
    gc_prev = gc.get('regularMarketPreviousClose') or gc_price
    usd_inr = inr.get('regularMarketPrice') or 84
    prev_inr = inr.get('regularMarketPreviousClose') or usd_inr
    price = round(derive_gold_price(gc_price, usd_inr, symbol), 2)
    prev = round(derive_gold_price(gc_prev, prev_inr, symbol), 2)
    change = round(price - prev, 2)
    return {
        'symbol': symbol,
        'price': price,
        'change': change,
        'changePct': round((change / (prev or price)) * 100, 2),
        'volume': gc.get('regularMarketVolume') or 0,
        'high': round(derive_gold_price(gc.get('regularMarketDayHigh') or gc_price, usd_inr, symbol), 2),
        'low': round(derive_gold_price(gc.get('regularMarketDayLow') or gc_price, usd_inr, symbol), 2),
        'open': round(derive_gold_price(gc.get('regularMarketOpen') or gc_price, usd_inr, symbol), 2),
        'close': prev,
        'week52High': 0,
        'week52Low': 0,
        'marketCap': 0,
    }


def fetch_derived_gold_history(symbol, interval, time_part):
    gold = chart_candles(fetch_json(
        f'https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval={urllib.parse.quote(interval)}&{time_part}&includePrePost=false'
    ))
    inr = chart_candles(fetch_json(
        f'https://query1.finance.yahoo.com/v8/finance/chart/INR%3DX?interval={urllib.parse.quote(interval)}&{time_part}&includePrePost=false'
    ))
    if not gold:
        return []
    last_inr = next((c['close'] for c in inr if c.get('close')), 84)
    inr_index = 0
    candles = []
    for c in gold:
        while inr_index < len(inr) and inr[inr_index]['time'] <= c['time']:
            last_inr = inr[inr_index].get('close') or last_inr
            inr_index += 1
        candles.append({
            'time': c['time'],
            'open': round(derive_gold_price(c['open'], last_inr, symbol), 2),
            'high': round(derive_gold_price(c['high'], last_inr, symbol), 2),
            'low': round(derive_gold_price(c['low'], last_inr, symbol), 2),
            'close': round(derive_gold_price(c['close'], last_inr, symbol), 2),
            'vol': c.get('vol') or 0,
        })
    return candles


def fallback_gold_history(symbol, interval, range_value):
    base = DEFAULT_PRICES.get(symbol, 15250 if symbol == 'GOLDPETAL' else 152500)
    interval_minutes = {'1m': 1, '5m': 5, '10m': 10, '15m': 15, '30m': 30, '60m': 60, '1h': 60}.get(interval, 5)
    count = {'1d': 80, '5d': 160, '7d': 220, '60d': 260, '2y': 320}.get(range_value, 160)
    now = int(time.time() * 1000)
    seed = sum(ord(ch) for ch in symbol)
    close = base * (1 + math.sin(((now // 86400000) + seed) * 1.7) * 0.006)
    candles = []
    for i in range(count - 1, -1, -1):
        ts = now - i * interval_minutes * 60000
        wave = math.sin(((ts // 60000) + seed) / 11) * 0.0018
        drift = math.sin(((ts // 86400000) + seed) * 1.7) * 0.0005
        open_val = close
        close = max(base * 0.95, open_val * (1 + wave + drift))
        spread = max(base * 0.0008, abs(close - open_val) * 1.4)
        candles.append({
            'time': ts,
            'open': round(open_val, 2),
            'high': round(max(open_val, close) + spread, 2),
            'low': round(min(open_val, close) - spread, 2),
            'close': round(close, 2),
            'vol': 0,
        })
    return candles


def fetch_history(symbol, interval, range_value, period1=None, period2=None):
    yahoo_symbol = QUOTE_SYMBOLS.get(symbol, f'{symbol}.NS')
    if period1 and period2:
        time_part = f'period1={period1}&period2={period2}'
    else:
        time_part = f'range={urllib.parse.quote(range_value)}'
    if symbol in GOLD_SYMBOLS:
        try:
            candles = fetch_derived_gold_history(symbol, interval, time_part)
        except Exception:
            candles = []
        if len(candles) > 3:
            return {'candles': candles, 'source': 'derived-gold', 'count': len(candles)}, 200
        candles = fallback_gold_history(symbol, interval, range_value)
        return {'candles': candles, 'source': 'fallback-gold', 'count': len(candles)}, 200
    url = (
        f'https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(yahoo_symbol)}'
        f'?interval={urllib.parse.quote(interval)}&{time_part}&includePrePost=false'
    )
    data = fetch_json(url)
    candles = chart_candles(data)
    if not candles:
        return {'error': 'No data'}, 404
    return {'candles': candles, 'source': 'yahoo', 'count': len(candles)}, 200


class PreviewHandler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == '/api/stocks':
            return json_response(self, 200, STOCKS)
        if parsed.path == '/api/state':
            return json_response(self, 200, read_state())
        if parsed.path == '/api/quotes':
            query = urllib.parse.parse_qs(parsed.query)
            requested = query.get('symbols', [''])[0]
            symbols = [item for item in requested.split(',') if item] or list(QUOTE_SYMBOLS.keys())

            # Build bidirectional symbol maps
            sym_to_yahoo = {s: QUOTE_SYMBOLS.get(s, f'{s}.NS') for s in symbols}
            yahoo_to_sym = {v: k for k, v in sym_to_yahoo.items()}
            all_yahoo = [sym_to_yahoo[s] for s in symbols]

            result = {}

            # Step 1: batch v7 (40 symbols per HTTP request)
            BATCH = 40
            batches = [all_yahoo[i:i+BATCH] for i in range(0, len(all_yahoo), BATCH)]
            for batch in batches:
                quotes = fetch_batch_v7(batch)
                for q in quotes:
                    our_sym = yahoo_to_sym.get(q.get('symbol', ''))
                    if not our_sym:
                        continue
                    price = q.get('regularMarketPrice') or 0
                    if price <= 0:
                        continue
                    prev = q.get('regularMarketPreviousClose') or price
                    result[our_sym] = {
                        'symbol': our_sym, 'price': price,
                        'change': price - prev,
                        'changePct': ((price - prev) / prev * 100) if prev else 0,
                        'volume': q.get('regularMarketVolume') or 0,
                        'high': q.get('regularMarketDayHigh') or price,
                        'low': q.get('regularMarketDayLow') or price,
                        'open': q.get('regularMarketOpen') or price,
                        'close': prev,
                        'week52High': q.get('fiftyTwoWeekHigh') or 0,
                        'week52Low': q.get('fiftyTwoWeekLow') or 0,
                        'marketCap': q.get('marketCap') or 0,
                    }

            # Step 2: v8 chart fallback for anything v7 missed
            missing = [s for s in symbols if s not in result]
            lock = threading.Lock()
            def fetch_one(symbol):
                try:
                    quote = fetch_quote(symbol)
                except Exception:
                    quote = None
                if quote:
                    with lock:
                        result[symbol] = quote
            with ThreadPoolExecutor(max_workers=20) as pool:
                list(pool.map(fetch_one, missing))
            for symbol in symbols:
                if symbol in GOLD_SYMBOLS:
                    try:
                        quote = fetch_derived_gold_quote(symbol)
                    except Exception:
                        quote = None
                    if quote:
                        result[symbol] = quote
                    elif symbol not in result and symbol in DEFAULT_PRICES:
                        fallback = moving_fallback_price(DEFAULT_PRICES[symbol], symbol)
                        price = fallback['price']
                        prev = fallback['prev']
                        change = round(price - prev, 2)
                        result[symbol] = {
                            'symbol': symbol, 'price': price,
                            'change': change,
                            'changePct': round((change / (prev or price)) * 100, 2),
                            'volume': 0, 'high': price, 'low': price, 'open': price, 'close': prev,
                            'week52High': 0, 'week52Low': 0, 'marketCap': 0,
                        }
            return json_response(self, 200, result)
        if parsed.path == '/api/history':
            query = urllib.parse.parse_qs(parsed.query)
            symbol = query.get('symbol', ['RELIANCE'])[0]
            interval = query.get('interval', ['5m'])[0]
            range_value = query.get('range', ['5d'])[0]
            period1 = query.get('period1', [None])[0]
            period2 = query.get('period2', [None])[0]
            try:
                payload, status = fetch_history(symbol, interval, range_value, period1, period2)
            except Exception as error:
                payload, status = {'error': str(error)}, 500
            return json_response(self, status, payload)
        return self.serve_static(parsed.path)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != '/api/state':
            return json_response(self, 404, {'error': 'Not found'})
        length = int(self.headers.get('Content-Length', '0'))
        raw = self.rfile.read(length) if length else b'{}'
        try:
            payload = json.loads(raw.decode('utf-8'))
        except json.JSONDecodeError:
            return json_response(self, 400, {'error': 'Invalid JSON'})
        current = read_state()
        if (current.get('updatedAt') or 0) > (payload.get('updatedAt') or 0):
            return json_response(self, 409, current)
        write_state(payload)
        return json_response(self, 200, payload)

    def serve_static(self, path):
        target = 'index.html' if path in ('', '/') else path.lstrip('/')
        file_path = (PUBLIC_DIR / target).resolve()
        if not str(file_path).startswith(str(PUBLIC_DIR.resolve())) or not file_path.exists() or file_path.is_dir():
            self.send_error(404, 'Not found')
            return
        content = file_path.read_bytes()
        mime_type, _ = mimetypes.guess_type(str(file_path))
        self.send_response(200)
        self.send_header('Content-Type', (mime_type or 'application/octet-stream') + ('; charset=utf-8' if mime_type and (mime_type.startswith('text/') or mime_type in ('application/javascript', 'application/json')) else ''))
        self.send_header('Content-Length', str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def log_message(self, format, *args):
        return


def main():
    port = int(os.environ.get('TRADEDESK_PORT', '8123'))
    server = ThreadingHTTPServer(('127.0.0.1', port), PreviewHandler)
    print(f'TradeDesk preview running on http://127.0.0.1:{port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
