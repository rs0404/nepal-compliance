# IRD Bridge (Chrome and Firefox extension)

IRD Bridge connects Nepal Compliance (ERPNext) to the IRD website through the
user's own browser. IRD's pages are protected by reCAPTCHA and browser
sessions, so the ERP server cannot call them. The extension runs them in an
IRD tab and hands the result back to the ERP page.

It covers **PAN search** (https://ird.gov.np/pan-search/).

## Where a PAN search starts

| Where | What the user does | What happens |
| --- | --- | --- |
| Customer, Supplier or Company form | **IRD → Search PAN on IRD** | Uses the VAT/PAN field, or the standard **Tax ID** when that is empty, and asks for a PAN only when neither holds nine digits. Shows IRD's answer and offers to apply the PAN, the registered name and (for suppliers) the VAT-registered flag. |
| IRD PAN Lookup list | **Search PAN on IRD** | Asks for a PAN and shows IRD's answer. |
| IRD PAN Lookup form | **Refresh from IRD** | Searches that PAN again and updates the record. |
| The extension's popup | Types a PAN and clicks **Search** | Shows IRD's answer in the popup. On an allowed ERP tab the answer is also saved in the ERP and shown there. |
| Other apps | Call `nepal_compliance.ird_bridge.lookup_pan(pan)` | Resolves with the ERP's saved answer when there is one, and only opens IRD for a PAN the ERP has not seen. Made for checks that run as the user types. |

Every answer is saved as an **IRD PAN Lookup** record, one per PAN. Code that
cannot use the extension at all, such as a storefront serving guests, can read
those records.

## How a PAN search works

1. `nepal_compliance/public/js/ird_bridge.js` posts a message on the
   `nc-ird-bridge` channel. `src/erp_content.js` (which runs only on ERP sites
   allowed in the popup) relays it to `src/background.js`. A search from the
   popup goes to the background directly.
2. The background opens `https://ird.gov.np/pan-search/?pan=<PAN>` in a
   background tab, next to the tab the search came from. It then runs
   `src/shared/pan_search_page.js` in the page. That script fills in the PAN
   and presses IRD's own Search button.
3. IRD's page runs its invisible reCAPTCHA and calls `/api/getPanSearch/`. If
   IRD has not answered after 8 seconds, the tab is brought forward so the
   user can complete a captcha challenge. The extension reads a copy of IRD's
   JSON answer.
4. The IRD tab is closed and the JSON goes back to the ERP page. The page
   posts it to `nepal_compliance.ird_bridge.record_pan_lookup`, which parses
   it, saves an **IRD PAN Lookup** record and returns a summary.

A browser closes an extension's popup as soon as another tab comes forward, so
a popup search that needs a captcha finishes in the background. The popup
shows the last result when it is opened again. That result is kept in the
browser's session storage and is gone when the browser closes; **Clear result**
removes it sooner.

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

**Chrome / Edge / Brave:** unzip `ird-bridge-chrome-<version>.zip` (or use
`dist/chrome`), open `chrome://extensions`, turn on Developer mode, click
**Load unpacked** and pick the folder.

**Firefox (128+):** open `about:debugging#/runtime/this-firefox`, click **Load
Temporary Add-on…** and pick `manifest.json` in the unzipped
`ird-bridge-firefox-<version>.zip` (or `dist/firefox`). Temporary add-ons are
removed when Firefox restarts. A permanent install needs the add-on signed by
AMO (it can be unlisted).

## Set up

1. Open your ERP site, then open the IRD Bridge popup.
2. Click **Allow this ERP site** and accept the browser prompt.
3. If the popup says it is not allowed to open ird.gov.np, click **Grant IRD
   access**.
4. Reload the ERP page.

The popup's own PAN search needs only step 3.

## Tests

`npm test` runs, with Node alone:

- `test/protocol.test.mjs` and `test/pan_summary.test.mjs`: the shared helpers
  and the popup's reading of IRD's answer.
- `test/background.test.mjs`: `src/background.js` against a stubbed extension
  API. It covers which messages are accepted, a search from an ERP page, and
  a search from the popup, including what is handed to an ERP tab.
- `test/build.test.mjs`: the Chrome and Firefox manifests, the built files
  and the zips.

### Manual browser harness

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
`/api/getPanSearch/`. The parsers rely on the JSON keys `panDetails`,
`panRegistrationDetail`, `businessDetail` and `panTaxClearance`, and on IRD's
account type and status codes. If any of these change, the ERP shows "The IRD
PAN search page has changed…", and these need updating:

- `src/shared/pan_search_page.js`: the page script.
- `nepal_compliance/ird_bridge.py`: the ERP's parser and code tables.
- `src/shared/pan_summary.js`: the popup's summary and the same code tables.
