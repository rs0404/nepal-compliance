import { panSearchInPage } from "./shared/pan_search_page.js";
import {
	CHANNEL,
	IRD_PERMISSION,
	PAN_SEARCH_URL,
	bridgeError,
	contentScriptId,
	isValidPan,
	originMatchPattern,
	originOf,
} from "./shared/protocol.js";

const api = globalThis.browser ?? globalThis.chrome;

const PAGE_LOAD_TIMEOUT_MS = 45000;
const PAN_SEARCH_TIMEOUT_MS = 150000;
// Bring the IRD tab forward if IRD has not answered by then, so the user can
// complete a reCAPTCHA challenge if one is shown.
const SHOW_TAB_AFTER_MS = 8000;
const KEEPALIVE_MS = 20000;

// ---------------------------------------------------------------- ERP sites

async function getErpOrigins() {
	const { erpOrigins } = await api.storage.local.get("erpOrigins");
	return Array.isArray(erpOrigins) ? erpOrigins : [];
}

async function setErpOrigins(origins) {
	await api.storage.local.set({ erpOrigins: [...new Set(origins)].sort() });
}

function contentScriptFor(origin) {
	return {
		id: contentScriptId(origin),
		matches: [originMatchPattern(origin)],
		js: ["erp_content.js"],
		runAt: "document_idle",
	};
}

// Keep the registered content scripts equal to the stored ERP origins
// (Firefox does not keep dynamic registrations across browser restarts).
async function syncContentScripts() {
	const origins = await getErpOrigins();
	const wanted = new Map(origins.map((origin) => [contentScriptId(origin), origin]));
	const registered = await api.scripting.getRegisteredContentScripts();
	const registeredIds = new Set(registered.map((script) => script.id));

	const stale = registered.map((s) => s.id).filter((id) => id.startsWith("erp:") && !wanted.has(id));
	if (stale.length) await api.scripting.unregisterContentScripts({ ids: stale });

	const missing = [];
	for (const [id, origin] of wanted) {
		if (registeredIds.has(id)) continue;
		const granted = await api.permissions.contains({ origins: [originMatchPattern(origin)] });
		if (granted) missing.push(contentScriptFor(origin));
	}
	if (missing.length) await api.scripting.registerContentScripts(missing);
}

async function addErpSite(origin, tabId) {
	if (!originOf(origin) || originOf(origin) !== origin) return bridgeError("bad_origin");
	const granted = await api.permissions.contains({ origins: [originMatchPattern(origin)] });
	if (!granted) return bridgeError("not_granted");
	await setErpOrigins([...(await getErpOrigins()), origin]);
	await syncContentScripts();
	if (tabId != null) {
		await api.scripting.executeScript({ target: { tabId }, files: ["erp_content.js"] }).catch(() => {});
	}
	return { ok: true, data: { origins: await getErpOrigins() } };
}

async function removeErpSite(origin) {
	const remaining = (await getErpOrigins()).filter((o) => o !== origin);
	await setErpOrigins(remaining);
	await syncContentScripts();
	// Only drop the host permission if no other allowed origin shares the host.
	const pattern = originMatchPattern(origin);
	if (!remaining.some((o) => originMatchPattern(o) === pattern)) {
		await api.permissions.remove({ origins: [pattern] }).catch(() => {});
	}
	return { ok: true, data: { origins: remaining } };
}

// ---------------------------------------------------------------- IRD tabs

function waitForTabComplete(tabId, timeoutMs) {
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			clearTimeout(timer);
			api.tabs.onUpdated.removeListener(onUpdated);
			api.tabs.onRemoved.removeListener(onRemoved);
		};
		const onUpdated = (id, info) => {
			if (id === tabId && info.status === "complete") {
				cleanup();
				resolve();
			}
		};
		const onRemoved = (id) => {
			if (id === tabId) {
				cleanup();
				reject(Object.assign(new Error("tab_closed"), { code: "tab_closed" }));
			}
		};
		const timer = setTimeout(() => {
			cleanup();
			reject(Object.assign(new Error("timeout"), { code: "timeout" }));
		}, timeoutMs);
		api.tabs.onUpdated.addListener(onUpdated);
		api.tabs.onRemoved.addListener(onRemoved);
		api.tabs.get(tabId).then((tab) => {
			if (tab.status === "complete") {
				cleanup();
				resolve();
			}
		}, () => {});
	});
}

function whenTabClosed(tabId) {
	let onRemoved;
	const promise = new Promise((resolve) => {
		onRemoved = (id) => {
			if (id === tabId) resolve(bridgeError("tab_closed"));
		};
		api.tabs.onRemoved.addListener(onRemoved);
	});
	return { promise, dispose: () => api.tabs.onRemoved.removeListener(onRemoved) };
}

// One IRD search at a time, so searches never share a tab or a captcha.
let queue = Promise.resolve();
function serialised(task) {
	const run = queue.then(task, task);
	queue = run.catch(() => {});
	return run;
}

async function panSearch(pan, erpTab) {
	if (!isValidPan(pan)) return bridgeError("bad_pan", "PAN must be exactly 9 digits.");
	if (!(await api.permissions.contains(IRD_PERMISSION))) return bridgeError("no_ird_permission");

	return serialised(async () => {
		const keepalive = setInterval(() => api.runtime.getPlatformInfo(), KEEPALIVE_MS);
		let tabId = null;
		let shown = false;
		let showTimer = null;
		let closed = null;
		try {
			const tab = await api.tabs.create({
				url: `${PAN_SEARCH_URL}?pan=${pan}`,
				active: false,
				windowId: erpTab?.windowId,
				index: erpTab ? erpTab.index + 1 : undefined,
			});
			tabId = tab.id;
			closed = whenTabClosed(tabId);
			await waitForTabComplete(tabId, PAGE_LOAD_TIMEOUT_MS);

			showTimer = setTimeout(() => {
				shown = true;
				api.tabs.update(tabId, { active: true }).catch(() => {});
			}, SHOW_TAB_AFTER_MS);

			const injection = api.scripting
				.executeScript({
					target: { tabId },
					world: "MAIN",
					func: panSearchInPage,
					args: [pan, PAN_SEARCH_TIMEOUT_MS],
				})
				.then((results) => results?.[0]?.result || bridgeError("page_changed"));

			return await Promise.race([injection, closed.promise]);
		} catch (err) {
			return bridgeError(err?.code || "error", String(err?.message || err));
		} finally {
			clearInterval(keepalive);
			clearTimeout(showTimer);
			closed?.dispose();
			if (shown && erpTab) api.tabs.update(erpTab.id, { active: true }).catch(() => {});
			if (tabId != null) api.tabs.remove(tabId).catch(() => {});
		}
	});
}

// ---------------------------------------------------------------- popup search

// The popup closes as soon as the IRD tab comes forward for a captcha, so the
// last search is kept for the popup to show when it is opened again. Session
// storage where the browser has it, so results do not outlive the browser.
const searchStore = api.storage.session ?? api.storage.local;

async function popupPanSearch(pan, tabId) {
	const tab = tabId == null ? null : await api.tabs.get(tabId).catch(() => null);
	await searchStore.set({ lastSearch: { pan, state: "searching", at: Date.now() } });
	const result = await panSearch(pan, tab);

	// On an allowed ERP tab, hand the answer to the ERP too, which saves it as
	// an IRD PAN Lookup and shows it.
	let sentToErp = false;
	const origin = originOf(tab?.url);
	if (result.ok && origin && (await getErpOrigins()).includes(origin)) {
		sentToErp = await api.tabs
			.sendMessage(tab.id, {
				channel: CHANNEL,
				direction: "to-content",
				event: "pan_result",
				payload: { pan, response: result.data.response },
			})
			.then((reply) => Boolean(reply?.ok), () => false);
	}

	const lastSearch = { pan, state: "done", at: Date.now(), result, sentToErp };
	await searchStore.set({ lastSearch });
	return { ok: true, data: lastSearch };
}

async function getLastSearch() {
	const { lastSearch } = await searchStore.get("lastSearch");
	return lastSearch || null;
}

// ---------------------------------------------------------------- messages

async function fromErp(msg, sender) {
	const origin = originOf(sender.url || sender.tab?.url);
	if (!origin || !(await getErpOrigins()).includes(origin)) return bridgeError("not_allowed");

	switch (msg.action) {
		case "ping":
			return { ok: true, data: { version: api.runtime.getManifest().version } };
		case "pan_search":
			return panSearch(String(msg.payload?.pan || ""), sender.tab);
		default:
			return bridgeError("unknown_action");
	}
}

async function fromPopup(msg) {
	switch (msg.action) {
		case "status":
			return {
				ok: true,
				data: {
					version: api.runtime.getManifest().version,
					irdAccess: await api.permissions.contains(IRD_PERMISSION),
					origins: await getErpOrigins(),
					lastSearch: await getLastSearch(),
				},
			};
		case "pan_search":
			return popupPanSearch(String(msg.pan || ""), msg.tabId);
		case "clear_search":
			await searchStore.remove("lastSearch");
			return { ok: true, data: {} };
		case "add_site":
			return addErpSite(msg.origin, msg.tabId);
		case "remove_site":
			return removeErpSite(msg.origin);
		default:
			return bridgeError("unknown_action");
	}
}

function isOwnExtensionPage(sender) {
	return sender.id === api.runtime.id && !sender.tab && String(sender.url || "").startsWith(api.runtime.getURL(""));
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	if (!msg || msg.channel !== CHANNEL || sender.id !== api.runtime.id) return false;
	let handler;
	if (msg.direction === "to-background" && sender.tab) {
		handler = fromErp(msg, sender);
	} else if (msg.direction === "popup" && isOwnExtensionPage(sender)) {
		handler = fromPopup(msg);
	} else {
		return false;
	}
	handler.then(sendResponse, (err) => sendResponse(bridgeError("error", String(err?.message || err))));
	return true;
});

api.runtime.onInstalled.addListener(() => syncContentScripts().catch(console.error));
api.runtime.onStartup.addListener(() => syncContentScripts().catch(console.error));
