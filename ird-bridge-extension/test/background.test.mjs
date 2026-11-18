// Drives src/background.js through a stubbed extension API: the messages it
// accepts, the popup's PAN search, and what it hands to an ERP tab.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

const EXT_ID = "test-extension";
const EXT_URL = "chrome-extension://test-extension/";
const ERP = "https://erp.example.com";
const IRD_ANSWER = { data: { panDetails: [{ pan: "123456789", trade_Name_Eng: "Fixture Traders" }] } };

const state = {};
const event = () => ({ addListener() {}, removeListener() {} });
const stored = (bucket) => ({
	async get(key) {
		return key in bucket ? { [key]: bucket[key] } : {};
	},
	async set(values) {
		Object.assign(bucket, values);
	},
	async remove(key) {
		delete bucket[key];
	},
});

let onMessage;
globalThis.chrome = {
	runtime: {
		id: EXT_ID,
		getURL: (path) => EXT_URL + path,
		getManifest: () => ({ version: "9.9.9" }),
		getPlatformInfo: async () => ({}),
		onMessage: { addListener: (fn) => (onMessage = fn) },
		onInstalled: event(),
		onStartup: event(),
	},
	storage: { local: stored((state.local = {})), session: stored((state.session = {})) },
	permissions: { contains: async () => state.irdAccess, remove: async () => true },
	scripting: {
		getRegisteredContentScripts: async () => [],
		registerContentScripts: async () => {},
		unregisterContentScripts: async () => {},
		async executeScript(details) {
			state.injected.push(details);
			return [{ result: state.pageResult }];
		},
	},
	tabs: {
		onUpdated: event(),
		onRemoved: event(),
		async create(options) {
			state.created.push(options);
			return { id: 99 };
		},
		async get(id) {
			if (id === 99) return { id, status: "complete" };
			if (!state.tabs[id]) throw new Error("no tab");
			return state.tabs[id];
		},
		async update(id, changes) {
			state.updated.push([id, changes]);
		},
		async remove(id) {
			state.removed.push(id);
		},
		async sendMessage(id, message) {
			state.sentToTab.push([id, message]);
			return { ok: true };
		},
	},
};

await import("../src/background.js");

function ask(message, sender) {
	return new Promise((resolve) => {
		const handled = onMessage({ channel: "nc-ird-bridge", ...message }, sender, resolve);
		if (!handled) resolve("ignored");
	});
}
const fromPopup = (message) => ask({ direction: "popup", ...message }, { id: EXT_ID, url: EXT_URL + "popup.html" });
const fromTab = (message, url) =>
	ask({ direction: "to-background", ...message }, { id: EXT_ID, url, tab: { id: 7, index: 2, windowId: 1, url } });

beforeEach(() => {
	for (const key of Object.keys(state.local)) delete state.local[key];
	for (const key of Object.keys(state.session)) delete state.session[key];
	state.local.erpOrigins = [ERP];
	Object.assign(state, {
		irdAccess: true,
		pageResult: { ok: true, data: { response: IRD_ANSWER } },
		tabs: { 7: { id: 7, index: 2, windowId: 1, url: `${ERP}/app/customer` }, 8: { id: 8, index: 0, windowId: 1, url: "https://other.example.com/" } },
		created: [],
		injected: [],
		updated: [],
		removed: [],
		sentToTab: [],
	});
});

test("messages from other extensions, web pages posing as the popup, and other channels are ignored", async () => {
	assert.equal(await ask({ direction: "popup", action: "status" }, { id: "someone-else", url: EXT_URL + "popup.html" }), "ignored");
	assert.equal(await ask({ direction: "popup", action: "status" }, { id: EXT_ID, url: EXT_URL + "popup.html", tab: { id: 7 } }), "ignored");
	assert.equal(onMessage({ channel: "other", direction: "popup", action: "status" }, { id: EXT_ID }, () => {}), false);
});

test("an ERP page that is not allowed gets not_allowed", async () => {
	const reply = await fromTab({ action: "pan_search", payload: { pan: "123456789" } }, "https://other.example.com/app");
	assert.equal(reply.error.code, "not_allowed");
	assert.equal(state.created.length, 0);
});

test("an allowed ERP page searches a PAN in an IRD tab next to it", async () => {
	const reply = await fromTab({ action: "pan_search", payload: { pan: "123456789" } }, `${ERP}/app/customer`);
	assert.deepEqual(reply, { ok: true, data: { response: IRD_ANSWER } });
	assert.deepEqual(state.created, [
		{ url: "https://ird.gov.np/pan-search/?pan=123456789", active: false, windowId: 1, index: 3 },
	]);
	assert.equal(state.injected[0].world, "MAIN");
	assert.deepEqual(state.injected[0].args.slice(0, 1), ["123456789"]);
	assert.deepEqual(state.removed, [99]);
});

test("a bad PAN and missing IRD access are refused before any tab opens", async () => {
	assert.equal((await fromTab({ action: "pan_search", payload: { pan: "12" } }, `${ERP}/app`)).error.code, "bad_pan");
	state.irdAccess = false;
	const reply = await fromTab({ action: "pan_search", payload: { pan: "123456789" } }, `${ERP}/app`);
	assert.equal(reply.error.code, "no_ird_permission");
	assert.equal(state.created.length, 0);
});

test("a popup search on an allowed ERP tab keeps the result and hands it to the ERP", async () => {
	const reply = await fromPopup({ action: "pan_search", pan: "123456789", tabId: 7 });
	assert.equal(reply.ok, true);
	assert.equal(reply.data.state, "done");
	assert.equal(reply.data.sentToErp, true);
	assert.deepEqual(reply.data.result.data.response, IRD_ANSWER);
	assert.deepEqual(state.sentToTab, [
		[7, { channel: "nc-ird-bridge", direction: "to-content", event: "pan_result", payload: { pan: "123456789", response: IRD_ANSWER } }],
	]);

	// Kept in session storage, not on disk, and shown again by the next popup.
	assert.equal(state.local.lastSearch, undefined);
	const status = await fromPopup({ action: "status" });
	assert.equal(status.data.version, "9.9.9");
	assert.equal(status.data.lastSearch.pan, "123456789");
	assert.deepEqual(status.data.origins, [ERP]);

	await fromPopup({ action: "clear_search" });
	assert.equal((await fromPopup({ action: "status" })).data.lastSearch, null);
});

test("a popup search on any other tab is not sent anywhere", async () => {
	const reply = await fromPopup({ action: "pan_search", pan: "123456789", tabId: 8 });
	assert.equal(reply.data.result.ok, true);
	assert.equal(reply.data.sentToErp, false);
	assert.equal(state.sentToTab.length, 0);
});

test("a failed popup search is kept with its error and is not sent to the ERP", async () => {
	state.pageResult = { ok: false, error: { code: "page_changed", message: "" } };
	const reply = await fromPopup({ action: "pan_search", pan: "123456789", tabId: 7 });
	assert.equal(reply.data.result.error.code, "page_changed");
	assert.equal(reply.data.sentToErp, false);
	assert.equal(state.sentToTab.length, 0);
	assert.equal((await fromPopup({ action: "status" })).data.lastSearch.result.error.code, "page_changed");
});
