// Runs on ERP sites the user allowed in the popup. Relays window messages on
// the "nc-ird-bridge" channel between the ERP page and the extension.
// Classic script (not a module): content scripts cannot import.
(function () {
	if (window.__ncIrdBridgeContent) return;
	window.__ncIrdBridgeContent = true;

	const api = globalThis.browser ?? globalThis.chrome;
	const CHANNEL = "nc-ird-bridge";

	document.documentElement.dataset.ncIrdBridge = api.runtime.getManifest().version;

	window.addEventListener("message", (event) => {
		if (event.source !== window || event.origin !== window.location.origin) return;
		const msg = event.data;
		if (!msg || msg.channel !== CHANNEL || msg.direction !== "to-extension" || !msg.id) return;

		const reply = (body) =>
			window.postMessage(
				Object.assign({ channel: CHANNEL, direction: "to-erp", id: msg.id }, body),
				window.location.origin
			);
		const fail = (code, err) =>
			reply({ ok: false, error: { code, message: String((err && err.message) || err || "") } });

		let sent;
		try {
			sent = api.runtime.sendMessage({
				channel: CHANNEL,
				direction: "to-background",
				action: String(msg.action || ""),
				payload: msg.payload && typeof msg.payload === "object" ? msg.payload : {},
			});
		} catch (err) {
			// The extension was reloaded or updated since this page loaded.
			fail("extension_reloaded", err);
			return;
		}
		sent.then(
			(response) => reply(response && typeof response === "object" ? response : { ok: false, error: { code: "error" } }),
			(err) => fail("extension_reloaded", err)
		);
	});
})();
