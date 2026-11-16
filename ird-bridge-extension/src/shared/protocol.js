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
