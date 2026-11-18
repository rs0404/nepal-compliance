// Shared constants and helpers. Keep the channel name in sync with
// nepal_compliance/public/js/ird_bridge.js and src/erp_content.js.
export const CHANNEL = "nc-ird-bridge";

export const IRD_ORIGIN = "https://ird.gov.np";
export const IRD_PERMISSION = { origins: [`${IRD_ORIGIN}/*`] };
export const PAN_SEARCH_URL = `${IRD_ORIGIN}/pan-search/`;

export function isValidPan(pan) {
	return typeof pan === "string" && /^\d{9}$/.test(pan);
}

// The http(s) origin of a URL, or null.
export function originOf(url) {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
		return parsed.origin;
	} catch (e) {
		return null;
	}
}

// Match patterns cannot carry a port, so the pattern covers every port of the
// host; the background re-checks the exact origin on every message.
export function originMatchPattern(origin) {
	const parsed = new URL(origin);
	return `${parsed.protocol}//${parsed.hostname}/*`;
}

export function contentScriptId(origin) {
	return `erp:${origin}`;
}

export function bridgeError(code, message) {
	return { ok: false, error: { code, message: message || "" } };
}

// What the popup shows for a failed search. The ERP has its own wording in
// nepal_compliance/public/js/ird_bridge.js.
const SEARCH_ERRORS = {
	bad_pan: "PAN must be exactly 9 digits.",
	no_ird_permission: "The extension is not allowed to open ird.gov.np. Click Grant IRD access below.",
	timeout: "IRD did not answer in time. Please try again.",
	tab_closed: "The IRD tab was closed before the search finished.",
	page_changed: "IRD's PAN search page has changed. Please update the IRD Bridge extension.",
	ird_error: "IRD's PAN search returned an error. Please try again.",
};

export function searchErrorMessage(error) {
	return SEARCH_ERRORS[error?.code] || error?.message || error?.code || "The search failed.";
}
