#!/usr/bin/env python3
"""Web twin, in a real browser (local Playwright, Chromium): estimate without an account, Save,
OAuth sign-up on the demo authorization server (the page is a CIMD client), return to the page,
the same estimate saved, Save again returns the same record, sign-up cancelled, returning account,
refusal, host tabs. Writes tests/out/twin-<label>.json and screenshots.

Usage: python3 tests/twin_playwright.py [page-url] [screenshot-dir]
"""
import json, os, re, sys, time
from playwright.sync_api import sync_playwright, expect

URL = sys.argv[1] if len(sys.argv) > 1 else 'https://theaipipe.com/demos/tax-estimate-mcp/'
SHOTS = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), 'out', 'shots')
os.makedirs(SHOTS, exist_ok=True)
OUT = os.path.join(os.path.dirname(__file__), 'out')
expected = json.load(open(os.path.join(os.path.dirname(__file__), 'fixtures', 'expected.json')))['expected']
results = []


def check(name, ok, note=''):
    results.append({'name': name, 'ok': bool(ok), 'note': note})
    print(('PASS ' if ok else 'FAIL ') + name + (f' :: {note}' if note else ''))


def money(n):
    return '${:,}'.format(n)


with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={'width': 1440, 'height': 1000})
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(URL)
    amount = page.get_by_test_id('amount')
    expect(amount).to_have_text(money(expected['p01']['amount']), timeout=15000)
    check('Maya: estimate shown without an account, equal to the IRS-derived reference', True, amount.inner_text())
    page.screenshot(path=os.path.join(SHOTS, 'twin-1440-estimate.png'), full_page=True)

    page.get_by_label(re.compile('Jordan and Sam')).check()
    expect(amount).to_have_text(money(expected['p02']['amount']), timeout=15000)
    check('Jordan and Sam: estimate updates to the reference', True, amount.inner_text())
    page.locator('.txc-more summary').click()
    expect(page.locator('.txc-draft')).to_contain_text('Aug 28, 2026')
    check('View assumptions opens and shows the draft status of the 2026 tables', True)

    # Save: OAuth sign-up and back
    t0 = time.time()
    page.get_by_test_id('save').click()
    page.wait_for_url(re.compile(r'^https://tax-mcp-demo\.theaipipe\.com/authorize'), timeout=15000)
    body = page.locator('main').inner_text()
    check('sign-up page names the requesting app from its verified CIMD domain', 'The web estimator (theaipipe.com)' in body, re.sub(r'\s+', ' ', body)[:160])
    check('sign-up page has no SSN field and no FileTax logo', page.locator('input').count() >= 1 and 'social security number' not in body.lower() and page.locator('img').count() == 0)
    page.screenshot(path=os.path.join(SHOTS, 'signup-1440.png'), full_page=True)
    email = f'twin-{int(time.time())}@example.com'
    page.get_by_label('Email for the demo account').fill(email)
    page.get_by_role('button', name='Create account and save').click()
    page.wait_for_url(re.compile(r'^https://theaipipe\.com/demos/tax-estimate-mcp/'), timeout=15000)
    saved = page.get_by_test_id('saved')
    expect(saved).to_contain_text('Saved', timeout=15000)
    elapsed = time.time() - t0
    check('back on the page, the same estimate saved', page.get_by_test_id('amount').inner_text() == money(expected['p02']['amount']), f'{elapsed:.1f} s from click to saved (scripted, no typing delay)')
    check('the authorization code left the address bar', '?code=' not in page.url and 'code=' not in page.url)
    record = re.search(r'record (sav_[a-z0-9]+)', saved.inner_text()).group(1)
    check('journey shows the four steps done', page.locator('#journey li.done').count() == 4)
    page.screenshot(path=os.path.join(SHOTS, 'twin-1440-saved.png'), full_page=True)
    page.get_by_test_id('save-again').click()
    expect(page.get_by_test_id('saved')).to_contain_text('Already saved', timeout=15000)
    check('Save again returns the same record', record in page.get_by_test_id('saved').inner_text(), record)
    page.locator('#events summary').click()
    ev = page.locator('#events-json').inner_text()
    check('Meta server event preview shown, not sent, without amounts or email', 'preview_not_sent' in ev and str(expected['p02']['amount']) not in ev.replace(',', '') and '@' not in ev, 'events: ' + ', '.join(re.findall(r'"event_name": "(\w+)"', ev)))

    # returning visitor: new estimate, Save, the authorization page offers the existing account
    page.get_by_label(re.compile('Ana')).check()
    expect(page.get_by_test_id('amount')).to_have_text(money(expected['p03']['amount']), timeout=15000)
    page.goto(URL)  # fresh page: the token was in memory only
    page.get_by_label(re.compile('Ana')).check()
    expect(page.get_by_test_id('amount')).to_have_text(money(expected['p03']['amount']), timeout=15000)
    page.get_by_test_id('save').click()
    page.wait_for_url(re.compile(r'^https://tax-mcp-demo\.theaipipe\.com/authorize'), timeout=15000)
    cont = page.get_by_role('button', name=re.compile('Continue with Demo account'))
    check('returning visitor is offered the existing demo account', cont.count() == 1)
    cont.click()
    page.wait_for_url(re.compile(r'^https://theaipipe\.com/demos/tax-estimate-mcp/'), timeout=15000)
    expect(page.get_by_test_id('saved')).to_contain_text('Saved', timeout=15000)
    check('second estimate saved into the same account', True, page.get_by_test_id('saved').inner_text().split('\n')[0])

    # cancel
    page.goto(URL)
    expect(page.get_by_test_id('amount')).to_be_visible(timeout=15000)
    page.get_by_test_id('save').click()
    page.wait_for_url(re.compile(r'^https://tax-mcp-demo\.theaipipe\.com/authorize'), timeout=15000)
    page.get_by_role('button', name='Cancel and go back without saving').click()
    page.wait_for_url(re.compile(r'^https://theaipipe\.com/demos/tax-estimate-mcp/'), timeout=15000)
    expect(page.locator('.txc-act')).to_contain_text('Sign-up cancelled. Nothing was saved.', timeout=15000)
    check('cancelled sign-up: nothing saved, said so', True)

    # refusal
    page.locator('.edit summary').click()
    page.fill('#wages', '18000')
    page.fill('#withheld', '900')
    page.click('#recalc')
    expect(page.locator('.txc-refused')).to_contain_text('Earned Income Credit', timeout=15000)
    check('edited profile in the EIC range is refused with the reason', True)

    # host tabs
    page.get_by_role('tab', name='Claude').click()
    check('Claude tab shows its panel and the prefilled Add to Claude link', page.locator('#panel-claude').is_visible() and 'modal=add-custom-connector' in page.get_by_role('link', name='Add to Claude').get_attribute('href'))
    page.get_by_role('tab', name='ChatGPT').click()
    check('ChatGPT tab shows its panel', page.locator('#panel-chatgpt').is_visible())
    check('no JavaScript errors', not errors, '; '.join(errors)[:200])

    # phone width
    m = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    mp = m.new_page()
    mp.goto(URL)
    expect(mp.get_by_test_id('amount')).to_be_visible(timeout=15000)
    sw = mp.evaluate('document.documentElement.scrollWidth')
    check('390 px: no horizontal scroll', sw <= 390, f'scrollWidth {sw}')
    mp.screenshot(path=os.path.join(SHOTS, 'twin-390.png'), full_page=True)
    mp.get_by_test_id('save').click()
    mp.wait_for_url(re.compile(r'^https://tax-mcp-demo\.theaipipe\.com/authorize'), timeout=15000)
    mp.screenshot(path=os.path.join(SHOTS, 'signup-390.png'), full_page=True)
    browser.close()

passed = sum(r['ok'] for r in results)
print(f'\n{passed}/{len(results)} browser checks passed on {URL}')
json.dump({'target': URL, 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'browser': 'Chromium (Playwright), desktop 1440 and 390 px', 'pass': passed, 'total': len(results), 'results': results}, open(os.path.join(OUT, 'twin-production.json'), 'w'), indent=2)
sys.exit(0 if passed == len(results) else 1)
