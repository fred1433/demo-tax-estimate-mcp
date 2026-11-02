#!/usr/bin/env python3
"""Regression checks of the review pass (Nov 2, 2026) on the demo page, in local headless Chromium.

Blockers 0, 3, 4, 5 and 10 on the web twin, and the page order (points 6, 8, 9, 11 quater, 12).
Network faults are injected with Playwright routes: a slow response, a lost response, an aborted call.

Usage: python3 tests/twin_fixes.py [page-url] [--site page/site]
With --site, requests to the page URL are answered from that local folder (same origin as the live
page, so the live OAuth server and its CORS rules apply unchanged): it tests a build before deploying.
"""
import asyncio, json, mimetypes, os, re, sys, time
from playwright.async_api import async_playwright, expect

args = [a for a in sys.argv[1:]]
SITE = None
if '--site' in args:
    i = args.index('--site'); SITE = os.path.abspath(args[i + 1]); del args[i:i + 2]
URL = args[0] if args else 'https://theaipipe.com/demos/tax-estimate-mcp/'
OUT = os.path.join(os.path.dirname(__file__), 'out')
os.makedirs(OUT, exist_ok=True)
results = []


def check(name, ok, note=''):
    results.append({'name': name, 'ok': bool(ok), 'note': note})
    print(('PASS ' if ok else 'FAIL ') + name + (f' :: {note}' if note else ''), flush=True)


async def serve_local(route):
    path = route.request.url.split('?')[0][len(URL):] or 'index.html'
    if path.endswith('/'):
        path += 'index.html'
    f = os.path.join(SITE, path)
    if not os.path.isfile(f):
        return await route.fulfill(status=404, body='not found')
    ctype = mimetypes.guess_type(f)[0] or 'application/octet-stream'
    if f.endswith('.js'):
        ctype = 'text/javascript'
    await route.fulfill(status=200, body=open(f, 'rb').read(), headers={'Content-Type': ctype, 'Cache-Control': 'no-store'})


async def back_to_local(route):
    # Playwright does not route the target of a server redirect, so the sign-up page's redirect
    # back to the demo page is replayed as a client-side navigation, which is routed to SITE.
    if route.request.method != 'POST':
        return await route.continue_()
    resp = await route.fetch(max_redirects=0)
    loc = resp.headers.get('location', '')
    if resp.status in (301, 302, 303) and loc.startswith(URL):
        return await route.fulfill(status=200, headers={'Content-Type': 'text/html'}, body=f'<script>location.replace({json.dumps(loc)})</script>')
    await route.fulfill(response=resp)


async def new_page(browser, **ctx):
    c = await browser.new_context(**ctx)
    if SITE:
        await c.route(re.compile('^' + re.escape(URL) + r'.*'), serve_local)
        await c.route(re.compile(r'^https://tax-mcp-demo\.theaipipe\.com/authorize'), back_to_local)
    p = await c.new_page()
    p.errors = []
    p.on('pageerror', lambda e: p.errors.append(str(e)))
    return c, p


async def amount(p):
    return (await p.get_by_test_id('amount').inner_text()).strip()


async def main():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        ctx = {'runs': None}

        async def s0():
            runs = ctx['runs']
            c, p = await new_page(browser, viewport={'width': 1440, 'height': 1000})
            await p.goto(URL)
            await expect(p.get_by_test_id('amount')).to_have_text('$1,219', timeout=15000)
            runs = ctx['runs'] = await p.evaluate("fetch('data/host-runs.json').then(r => r.json())")
            tabs = await p.get_by_role('tab').all_inner_texts()
            sel = await p.get_by_role('tab', name='Claude').get_attribute('aria-selected')
            check('6: the Claude tab comes first and is selected on arrival', tabs[:1] == ['Claude'] and sel == 'true', f'tabs {tabs}, Claude selected={sel}')
            status = await p.locator('#host-status').inner_text() if await p.locator('#host-status').count() else ''
            check('6: two status lines under the title, one per host', 'Claude: returns to the conversation and saves automatically.' in status and 'ChatGPT: account linking works; reopen the conversation and press Save again.' in status, status[:160])
            order = await p.evaluate("[...document.querySelectorAll('main > section')].map(s => s.id || s.className)")
            check('6: order is title, hosts, then the playable twin', order.index('hosts') < order.index('try') if 'hosts' in order and 'try' in order else False, str(order))
            cal_near = await p.locator('main a[href="https://cal.theaipipe.com"]').count()
            check('6: a call link next to the demonstration, besides the footer one', cal_near >= 1, f'{cal_near} in main')
            claude_meta = await p.locator('.rec[data-host=claude]').inner_text()
            check('8: the Claude video note is shown under the video', runs['claude']['video_note'] in claude_meta)
            check('11 quater: "Recorded <date> on <surface>."', f"Recorded {runs['claude']['date']} on {runs['claude']['surface']}." in claude_meta, claude_meta[:120])
            det = p.locator('details.test-details')
            is_open = await det.evaluate('d => d.open') if await det.count() else None
            det_text = await det.inner_text() if await det.count() else ''
            await p.get_by_role('tab', name='ChatGPT').click()
            gpt_meta = await p.locator('.rec[data-host=chatgpt]').inner_text()
            check('8: the ChatGPT video note and repeat-save result are shown', runs['chatgpt']['video_note'] in gpt_meta and runs['chatgpt']['repeat_save'] in gpt_meta)
            all_labels = [r['label'] for h in ('claude', 'chatgpt') for r in runs[h]['runs']]
            if await det.count():
                await det.evaluate('d => d.open = true')
                det_text = await p.locator('details.test-details').evaluate('d => d.innerText')
            check('8: timings and checks sit in a closed "Test details" panel, every run listed with its label', is_open is False and all(l in det_text for l in all_labels) and '116 s' in det_text and '54 s' in det_text, f'open={is_open}')
            prompt = await p.locator('#prompt-text').inner_text()
            check('9: the sample prompt gives the answers the tool requires', re.search(r'under 65.*not blind.*dependent.*no other income', prompt, re.I) is not None, prompt[:120])
            await p.screenshot(path=os.path.join(OUT, 'fixes-1440.png'), full_page=True)
            await c.close()

        try:
            await s0()
        except Exception as e:
            check('section aborted: page order and host section (1440)', False, str(e).split(chr(10))[0][:160])

        async def s1():
            runs = ctx['runs']
            c, p = await new_page(browser, viewport={'width': 1440, 'height': 1000})
            ctx['c'], ctx['p'] = c, p
            await p.goto(URL)
            await expect(p.get_by_test_id('amount')).to_have_text('$1,219', timeout=15000)

            async def slow_jordan(route):
                body = json.loads(route.request.post_data or '{}')
                if body.get('w2_wages') == 128000:
                    await asyncio.sleep(2.0)
                await route.continue_()
            await p.route('**/api/web/estimate', slow_jordan)
            await p.get_by_label(re.compile('Jordan and Sam')).check()
            await p.wait_for_timeout(150)
            busy = await p.locator('#card .txc').get_attribute('aria-busy')
            save_enabled = await p.get_by_test_id('save').is_enabled() if await p.get_by_test_id('save').count() else False
            await p.get_by_label(re.compile('Ana')).check()
            check('3: while a new estimate is computing, the card says so and Save is unavailable', busy == 'true' and not save_enabled, f'aria-busy={busy}, save enabled={save_enabled}')
            await p.wait_for_timeout(3500)
            final = await amount(p) if await p.get_by_test_id('amount').count() else ''
            check('3: answers out of order (Jordan late, Ana first): the card ends on Ana', final == '$2,369', final)
            await p.unroute('**/api/web/estimate')

        try:
            await s1()
        except Exception as e:
            check('section aborted: 3: stale response ignored', False, str(e).split(chr(10))[0][:160])

        async def s2():
            runs = ctx['runs']
            c, p = ctx['c'], ctx['p']
            await p.get_by_label(re.compile('Maya')).check()
            await expect(p.get_by_test_id('amount')).to_have_text('$1,219', timeout=15000)
            await p.locator('.edit summary').click()
            await p.fill('#withheld', '')
            await p.click('#recalc')
            await p.wait_for_timeout(1500)
            err = await p.locator('#withheld-error').inner_text() if await p.locator('#withheld-error').count() else ''
            card = await p.locator('#card').inner_text()
            check('4: empty withholding is an error next to the field, never $0 withheld', bool(err.strip()) and 'owed' not in card and await amount(p) == '$1,219', f'error="{err.strip()}"')
            for val, label in [('1e6', '"1e6"'), ('-5', 'negative'), ('58400.5', 'decimal')]:
                await p.fill('#withheld', '6050')
                await p.fill('#wages', val)
                await p.click('#recalc')
                await p.wait_for_timeout(800)
                werr = await p.locator('#wages-error').inner_text() if await p.locator('#wages-error').count() else ''
                pr = await p.locator('#prompt-text').inner_text()
                check(f'0: {label} wages refused in the twin', bool(werr.strip()) and '$-5' not in pr and '$1 wages' not in pr, f'error="{werr.strip()}"')
            await p.fill('#wages', '50000')
            await p.fill('#withheld', '60000')
            await p.click('#recalc')
            await expect(p.locator('.txc-refused')).to_contain_text('withheld', timeout=15000)
            check('0: withholding above wages is refused by the server, with the reason', True)
            await p.fill('#withheld', '')
            await p.fill('#wages', '58400')
            await p.fill('#withheld', '6050')
            await p.click('#recalc')
            await expect(p.get_by_test_id('amount')).to_have_text('$1,219', timeout=15000)
            check('4: 0 or a valid value is still accepted after an error', not await p.locator('#withheld-error').is_visible() if await p.locator('#withheld-error').count() else True)

        try:
            await s2()
        except Exception as e:
            check('section aborted: 4 and 0: empty, absurd and negative inputs', False, str(e).split(chr(10))[0][:160])

        async def s3():
            runs = ctx['runs']
            c, p = ctx['c'], ctx['p']
            await p.route('**/api/web/estimate', lambda r: r.abort('failed'))
            await p.get_by_label(re.compile('Ana')).check()
            await expect(p.locator('#card [role=alert]')).to_be_visible(timeout=10000)
            retry = p.get_by_test_id('retry-estimate')
            check('5: a failed estimate is shown, with a retry', await retry.count() == 1, (await p.locator('#card').inner_text())[:100])
            await p.unroute('**/api/web/estimate')
            if await retry.count():
                await retry.click()
            await expect(p.get_by_test_id('amount')).to_have_text('$2,369', timeout=15000)

            # sign up for real, but lose the first Save response
            await p.get_by_label(re.compile('Maya')).check()
            await expect(p.get_by_test_id('amount')).to_have_text('$1,219', timeout=15000)
            await p.locator('.edit summary').evaluate('s => s.parentElement.open = true')
            await p.fill('#wages', '70000')
            await p.click('#recalc')
            await expect(p.locator('#card .txc')).not_to_have_attribute('aria-busy', 'true', timeout=15000)
            await expect(p.get_by_test_id('amount')).to_be_visible(timeout=15000)
            edited_amount = await amount(p)
            state = {'n': 0}

            async def lose_first(route):
                state['n'] += 1
                if state['n'] == 1:
                    resp = await route.fetch()  # the server does the save...
                    return await route.abort('failed')  # ...and the answer is lost
                await route.continue_()
            await p.route('**/api/web/save', lose_first)
            await p.get_by_test_id('save').click()
            await p.wait_for_url(re.compile(r'^https://tax-mcp-demo\.theaipipe\.com/authorize'), timeout=15000)
            await p.get_by_label('Email for the demo account').fill(f'fixes-{int(time.time())}@example.com')
            await p.get_by_role('button', name='Create account and save').click()
            await p.wait_for_url(re.compile('^' + re.escape(URL)), timeout=15000)
            await expect(p.locator('#card [role=alert]')).to_contain_text('interrupted', timeout=15000)
            msg = await p.locator('#card').inner_text()
            check('5: a lost Save response says the confirmation was interrupted, not "nothing was saved"', 'The save confirmation was interrupted. Try again.' in msg and 'Nothing was saved' not in msg)
            prompt = await p.locator('#prompt-text').inner_text()
            wages_val = await p.input_value('#wages')
            check('10: back from sign-up, the edited inputs and prompt are kept', 'Edited' in prompt and '70,000' in prompt and wages_val == '70000' and await amount(p) == edited_amount, f'wages field {wages_val}; prompt: {prompt[:80]}')
            await p.get_by_test_id('retry').click()
            await expect(p.get_by_test_id('saved')).to_contain_text('Already saved', timeout=15000)
            check('5: Try again reuses the same reference and finds the record already saved', True, (await p.get_by_test_id('saved').inner_text()).split('\n')[0])
            await p.unroute('**/api/web/save')

        try:
            await s3()
        except Exception as e:
            check('section aborted: 5: failed calls have a way out', False, str(e).split(chr(10))[0][:160])

        async def s4():
            runs = ctx['runs']
            c, p = ctx['c'], ctx['p']
            await p.get_by_label(re.compile('Jordan and Sam')).check()
            await expect(p.get_by_test_id('amount')).to_have_text('$2,997', timeout=15000)
            step1 = await p.locator('#journey [data-step=estimate]').inner_text()
            await p.get_by_test_id('save').click()
            await expect(p.get_by_test_id('saved')).to_contain_text('Saved', timeout=15000)
            step3 = await p.locator('#journey [data-step=signup]').inner_text()
            done3 = await p.locator('#journey [data-step=signup]').get_attribute('class')
            check('10: with a connected account, step 1 does not say "no account" and step 3 says the account is reused', 'no account' not in step1 and 'Using the connected demo account' in step3 and 'done' in (done3 or ''), f'1="{step1.strip()}" 3="{step3.strip()}"')
            check('no JavaScript errors (1440)', not p.errors, '; '.join(p.errors)[:200])
            await c.close()

        try:
            await s4()
        except Exception as e:
            check('section aborted: 10: with a connected account', False, str(e).split(chr(10))[0][:160])

        async def s5():
            runs = ctx['runs']
            c, p = await new_page(browser, viewport={'width': 1440, 'height': 1000})
            await p.goto(URL)
            await expect(p.get_by_test_id('amount')).to_have_text('$1,219', timeout=15000)
            await p.route('**/oauth/token', lambda r: r.abort('failed'))
            await p.get_by_test_id('save').click()
            await p.wait_for_url(re.compile(r'^https://tax-mcp-demo\.theaipipe\.com/authorize'), timeout=15000)
            await p.get_by_label('Email for the demo account').fill(f'fixes-tok-{int(time.time())}@example.com')
            await p.get_by_role('button', name='Create account and save').click()
            await p.wait_for_url(re.compile('^' + re.escape(URL)), timeout=15000)
            await expect(p.locator('#card [role=alert]')).to_be_visible(timeout=15000)
            check('5: a failed token exchange is shown, with a retry button', await p.get_by_test_id('retry').count() == 1, (await p.locator('#card [role=alert]').inner_text())[:100])
            await c.close()

        try:
            await s5()
        except Exception as e:
            check('section aborted: token exchange failure', False, str(e).split(chr(10))[0][:160])

        async def s6():
            runs = ctx['runs']
            c, p = await new_page(browser, viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
            await p.goto(URL)
            await expect(p.get_by_test_id('amount')).to_be_visible(timeout=15000)
            y_status = await p.evaluate("(() => { const e = document.querySelector('#host-status'); return e ? e.getBoundingClientRect().bottom + scrollY : 1e9 })()")
            y_tab = await p.evaluate("(() => { const e = document.querySelector('#tab-claude'); return e ? e.getBoundingClientRect().bottom + scrollY : 1e9 })()")
            sw = await p.evaluate('document.documentElement.scrollWidth')
            check('12: at 390 px the status lines and the Claude tab are within the first two screens', y_status <= 2 * 844 and y_tab <= 2 * 844, f'status bottom {y_status:.0f}px, tab bottom {y_tab:.0f}px')
            check('12: no horizontal scroll at 390 px', sw <= 390, f'scrollWidth {sw}')
            await p.screenshot(path=os.path.join(OUT, 'fixes-390.png'), full_page=True)
            await c.close()

        try:
            await s6()
        except Exception as e:
            check('section aborted: 12: phone width', False, str(e).split(chr(10))[0][:160])

        async def s7():
            runs = ctx['runs']
            c, p = await new_page(browser, viewport={'width': 1440, 'height': 1000})
            await p.goto(URL + 'proofs.html')
            text = await p.locator('main').inner_text()
            check('1: proofs page reports the host runs from host-runs.json, no stale "not run" line', 'not yet run' not in text and runs['claude']['surface'] in text and runs['chatgpt']['surface'] in text)
            notes = await p.locator('ul.checks .m').all_inner_texts()
            bad = [n for n in notes if not n.startswith('[') or (len(n) > 224 and not n.endswith('[…]]'))]
            check('18 ter: proofs notes are whole, or cut at a word with an explicit ellipsis', notes and not bad and 'scop)' not in text, f'{len(notes)} notes, {len(bad)} bad')
            await c.close()


        try:
            await s7()
        except Exception as e:
            check('section aborted: proofs page', False, str(e).split(chr(10))[0][:160])

        await browser.close()

    passed = sum(r['ok'] for r in results)
    print(f'\n{passed}/{len(results)} checks passed on {URL}' + (f' (page files from {SITE})' if SITE else ''))
    json.dump({'target': URL, 'site': SITE, 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'pass': passed, 'total': len(results), 'results': results},
              open(os.path.join(OUT, 'twin-fixes-' + ('local' if SITE else 'production') + '.json'), 'w'), indent=2)
    sys.exit(0 if passed == len(results) else 1)

asyncio.run(main())
