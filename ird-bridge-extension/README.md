# IRD Bridge (Chrome and Firefox extension)

IRD Bridge connects Nepal Compliance (ERPNext) to the IRD website through the
user's own browser. IRD's pages are protected by reCAPTCHA and browser
sessions, so the ERP server cannot call them. The extension runs them in an
IRD tab and hands the result back to the ERP page.

This first version covers **PAN search** (https://ird.gov.np/pan-search/).

## How a PAN search works

1. In the ERP, the user clicks **IRD → Search PAN on IRD** on a Customer,
   Supplier or Company, or **Search PAN on IRD** on the IRD PAN Lookup list.
2. `nepal_compliance/public/js/ird_bridge.js` posts a message on the
   `nc-ird-bridge` channel. `src/erp_content.js` (which runs only on ERP sites
   allowed in the popup) relays it to `src/background.js`.
3. The background opens `https://ird.gov.np/pan-search/?pan=<PAN>` in a
   background tab, next to the ERP tab. It then runs
   `src/shared/pan_search_page.js` in the page. That script fills in the PAN
   and presses IRD's own Search button.
4. IRD's page runs its invisible reCAPTCHA and calls `/api/getPanSearch/`. If
   IRD has not answered after 8 seconds, the tab is brought forward so the
   user can complete a captcha challenge. The extension reads a copy of IRD's
   JSON answer.
5. The IRD tab is closed and the JSON goes back to the ERP page. The page
   posts it to `nepal_compliance.ird_bridge.record_pan_lookup`, which parses
   it, saves an **IRD PAN Lookup** record and returns a summary. The user can
   apply the IRD name, the PAN and (for suppliers) the VAT-registered flag to
   the form.

The extension never stores IRD passwords and never bypasses reCAPTCHA. It
only uses IRD's page the way a person would.

## Build

Requires Node 18+. There are no dependencies.

```bash
npm run build      # dist/chrome and dist/firefox
npm run package    # also dist/ird-bridge-<browser>-<version>.zip
npm test
```

## Install for testing

**Chrome / Edge / Brave:** open `chrome://extensions`, turn on Developer mode,
click **Load unpacked** and pick `dist/chrome`.

**Firefox (128+):** open `about:debugging#/runtime/this-firefox`, click **Load
Temporary Add-on…** and pick `dist/firefox/manifest.json`. Temporary add-ons
are removed when Firefox restarts. A permanent install needs the add-on
signed by AMO (it can be unlisted).

## Set up

1. Open your ERP site, then open the IRD Bridge popup.
2. Click **Allow this ERP site** and accept the browser prompt.
3. If the popup says it is not allowed to open ird.gov.np, click **Grant IRD
   access**.
4. Reload the ERP page.

## Manual browser harness

`test/fixtures/pan_search.html` is a stand-in for IRD's PAN search page
(found / notfound / html / slowcaptcha modes). `test/fixtures/harness.html`
runs the ERP bridge against the real content script with a stubbed extension
API. Serve the repository root over HTTP (for example
`python3 -m http.server 8765` from the repository root) and open
`/ird-bridge-extension/test/fixtures/harness.html`. Its results print on the
page.

## If IRD changes its page

The page script relies on these parts of IRD's PAN search page: the
`#form`, `#pan` and `#submit` elements, `window.grecaptcha`, and a `fetch` to
`/api/getPanSearch/`. The server-side parser relies on the JSON keys
`panDetails`, `panRegistrationDetail`, `businessDetail` and
`panTaxClearance`. If any of these change, the ERP shows "The IRD PAN search
page has changed…", and `src/shared/pan_search_page.js` and
`nepal_compliance/ird_bridge.py` need updating.
