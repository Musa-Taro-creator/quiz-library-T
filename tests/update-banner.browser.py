"""The "new version" banner appears when the page on screen is older than the server's copy,
including when the browser opened an older cached copy after the server was updated.
No network: the server's newest copy is simulated.
"""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
PAGE = (ROOT / 'index.html').read_text().replace('const MOCK_MODE=false;', 'const MOCK_MODE=true;', 1)
MINE = re.search(r'name="ql-shell-generation" content="([^"]+)"', PAGE).group(1)
checks = []
def ok(s): checks.append(s); print('PASS:', s, flush=True)
def run(server_version):
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        context = browser.new_context(viewport={'width': 1024, 'height': 800}, service_workers='block')
        page = context.new_page(); errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        newest = PAGE.replace(f'content="{MINE}"', f'content="{server_version}"')
        def route(r):
            url = r.request.url
            if url.startswith('http://127.0.0.1:8833/'):
                name = url.split('8833/', 1)[1].split('?', 1)[0]
                if name in ('', 'index.html'):
                    # the update check (?_qlv) reaches the server's newest copy; the page itself is the copy on screen
                    body = newest if '_qlv=' in url else PAGE
                    r.fulfill(status=200, content_type='text/html', body=body, headers={'ETag': '"same-etag"', 'Last-Modified': 'Mon, 09 Nov 2026 16:08:13 GMT'})
                elif (ROOT / name).is_file(): r.fulfill(status=200, body=(ROOT / name).read_bytes())
                else: r.fulfill(status=404, body='')
            elif r.request.resource_type == 'script': r.fulfill(status=200, content_type='application/javascript', body='')
            else: r.abort()
        context.route('**/*', route)
        page.goto('http://127.0.0.1:8833/')
        page.wait_for_timeout(6000)   # first check runs 3 s after start
        shown = page.locator('#qlUpdateRefreshBtn').count() > 0
        browser.close()
        assert not errors, errors
        return shown
# Server has a newer version, ETag/Last-Modified unchanged since page load (the case the old checker missed)
assert run(MINE + '-newer') is True
ok('An older page on screen shows "New version available" when the server has a newer copy')
assert run(MINE) is False
ok('No banner when the page on screen is already the newest version')
print(f'{len(checks)} checks passed')
