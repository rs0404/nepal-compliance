// Injected into IRD's PAN search page (https://ird.gov.np/pan-search/) in the
// page's MAIN world by background.js. It must stay self-contained: the
// browser serialises the function, so it cannot use imports or outer names.
//
// It uses IRD's page exactly as a person would: fill the PAN box and press
// Search. The page then runs its own invisible reCAPTCHA (a person completes
// any challenge in the tab) and calls /api/getPanSearch/. A wrapper around
// window.fetch reads that answer for the ERP. Nothing is sent to IRD that the
// page itself does not send.
export function panSearchInPage(pan, timeoutMs) {
	const READY_TIMEOUT_MS = 20000;
	const POLL_MS = 250;
	const API_PATH = /\/api\/getPanSearch\/?(\?|$)/;

	return new Promise((resolve) => {
		let poll = null;
		let readyTimer = null;
		let listener = null;
		const hook = window.__ncIrdBridgeFetchHook;

		const done = (result) => {
			clearTimeout(timer);
			clearTimeout(readyTimer);
			clearInterval(poll);
			if (listener) window.__ncIrdBridgeFetchHook.listeners.delete(listener);
			resolve(result);
		};
		const timer = setTimeout(
			() => done({ ok: false, error: { code: "timeout", message: "" } }),
			timeoutMs
		);

		if (!hook) {
			const originalFetch = window.fetch;
			const state = { listeners: new Set() };
			window.__ncIrdBridgeFetchHook = state;
			window.fetch = function (input, init) {
				const url = typeof input === "string" ? input : input && input.url;
				const promise = originalFetch.apply(this, arguments);
				if (url && API_PATH.test(String(url))) {
					promise
						.then((response) => response.clone().json())
						.then(
							(json) => state.listeners.forEach((fn) => fn({ ok: true, json })),
							(err) => state.listeners.forEach((fn) => fn({ ok: false, err: String(err) }))
						);
				}
				return promise;
			};
		}

		listener = (event) => {
			if (event.ok) {
				done({ ok: true, data: { response: event.json } });
			} else {
				done({ ok: false, error: { code: "ird_error", message: event.err } });
			}
		};
		window.__ncIrdBridgeFetchHook.listeners.add(listener);

		const isReady = () => {
			const form = document.getElementById("form");
			const input = document.getElementById("pan");
			const recaptcha = window.grecaptcha;
			return form && input && recaptcha && typeof recaptcha.execute === "function";
		};

		const submit = () => {
			const input = document.getElementById("pan");
			input.value = pan;
			input.dispatchEvent(new Event("input", { bubbles: true }));
			const button = document.getElementById("submit");
			if (button) {
				button.click();
			} else {
				document.getElementById("form").requestSubmit();
			}
		};

		readyTimer = setTimeout(() => {
			if (!isReady()) done({ ok: false, error: { code: "page_changed", message: "" } });
		}, READY_TIMEOUT_MS);

		if (isReady()) {
			submit();
		} else {
			poll = setInterval(() => {
				if (!isReady()) return;
				clearInterval(poll);
				clearTimeout(readyTimer);
				submit();
			}, POLL_MS);
		}
	});
}
