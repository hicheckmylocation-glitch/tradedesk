import json
import mimetypes
import os
import re
import threading
import time
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
    pattern = re.compile(
        r"\{ symbol: '([^']+)', name: '([^']+)', sector: '([^']+)'(?:, yahoo: '([^']+)')? \}"
    )
    stocks = []
    quote_symbols = {}
    for symbol, name, sector, yahoo in pattern.findall(raw):
        stocks.append({'symbol': symbol, 'name': name, 'sector': sector})
        quote_symbols[symbol] = yahoo or f'{symbol}.NS'
    return stocks, quote_symbols


STOCKS, QUOTE_SYMBOLS = parse_stock_universe()
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


def fetch_history(symbol, interval, range_value, period1=None, period2=None):
    yahoo_symbol = QUOTE_SYMBOLS.get(symbol, f'{symbol}.NS')
    if period1 and period2:
        time_part = f'period1={period1}&period2={period2}'
    else:
        time_part = f'range={urllib.parse.quote(range_value)}'
    url = (
        f'https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(yahoo_symbol)}'
        f'?interval={urllib.parse.quote(interval)}&{time_part}&includePrePost=false'
    )
    data = fetch_json(url)
    result = ((data.get('chart') or {}).get('result') or [None])[0]
    if not result:
        return {'error': 'No data'}, 404
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