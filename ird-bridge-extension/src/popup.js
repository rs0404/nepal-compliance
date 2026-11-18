import { summarisePanResponse } from "./shared/pan_summary.js";
import {
	CHANNEL,
	IRD_ORIGIN,
	IRD_PERMISSION,
	isValidPan,
	originMatchPattern,
	originOf,
	searchErrorMessage,
} from "./shared/protocol.js";

const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

// A search that has not finished after this long was lost (browser closed, or
// the extension was reloaded).
const SEARCH_STALE_MS = 4 * 60 * 1000;

let activeTab = null;
let tabOrigin = null;

function send(action, extra) {
	return api.runtime.sendMessage({ channel: CHANNEL, direction: "popup", action, ...extra });
}

function showError(message) {
	$("error").textContent = message || "";
	$("error").hidden = !message;
}

function line(label, value, className) {
	const row = document.createElement("div");
	row.className = "row";
	const key = document.createElement("span");
	key.className = "muted";
	key.textContent = label;
	const val = document.createElement("span");
	val.textContent = value;
	if (className) val.className = className;
	row.append(key, val);
	return row;
}

function note(message, className) {
	const p = document.createElement("p");
	p.className = className || "muted";
	p.textContent = message;
	return p;
}

function renderSearch(lastSearch) {
	const box = $("pan-result");
	box.replaceChildren();
	const searching = lastSearch?.state === "searching" && Date.now() - lastSearch.at < SEARCH_STALE_MS;
	$("pan-search").disabled = searching;
	$("pan-clear").hidden = !lastSearch || lastSearch.state !== "done";
	if (!lastSearch || (lastSearch.state === "searching" && !searching)) return;

	if (searching) {
		box.append(
			note(
				`Searching PAN ${lastSearch.pan} on IRD… If IRD shows a captcha in its tab, complete it there, then open this popup again.`
			)
		);
		return;
	}

	const { pan, result, sentToErp } = lastSearch;
	if (!result?.ok) {
		box.append(note(searchErrorMessage(result?.error), "error"));
		return;
	}
	const summary = summarisePanResponse(pan, result.data?.response);
	if (!summary.found) {
		box.append(note(`IRD has no record of PAN ${pan}.`, "error"));
		return;
	}

	box.append(line("PAN", summary.pan));
	if (summary.nameEn) box.append(line("Name", summary.nameEn));
	if (summary.nameNp) box.append(line("Name (Nepali)", summary.nameNp));
	if (summary.address) box.append(line("Address", summary.address));
	if (summary.office) box.append(line("IRD office", summary.office));
	box.append(line("Status", summary.status || "Unknown", summary.status === "Active" ? "ok" : "error"));
	box.append(
		line("VAT registered", summary.isPersonalPan ? "No (personal PAN)" : summary.vatRegistered ? "Yes" : "No")
	);
	for (const row of summary.registrations) {
		box.append(line(row.type, [row.status, row.registrationDate].filter(Boolean).join(" · ")));
	}
	if (sentToErp) box.append(note("Saved to the ERP in this tab as an IRD PAN Lookup.", "ok"));
}

async function render() {
	const status = await send("status");
	if (!status?.ok) {
		showError(status?.error?.message || "The extension did not answer.");
		return;
	}
	const { version, irdAccess, origins, lastSearch } = status.data;
	$("version").textContent = `v${version}`;

	$("ird-status").textContent = irdAccess ? "Allowed to open ird.gov.np" : "Not allowed to open ird.gov.np";
	$("ird-status").className = irdAccess ? "ok" : "error";
	$("grant-ird").hidden = irdAccess;

	$("tab-origin").textContent = tabOrigin || "This tab is not a web page.";
	const allowed = tabOrigin && origins.includes(tabOrigin);
	$("allow-site").hidden = !tabOrigin || allowed || tabOrigin === IRD_ORIGIN;
	$("tab-status").textContent = allowed ? "Allowed. Reload the ERP page if it was open before." : "";

	const list = $("sites");
	list.replaceChildren();
	for (const origin of origins) {
		const item = document.createElement("li");
		const label = document.createElement("span");
		label.textContent = origin;
		const remove = document.createElement("button");
		remove.className = "link";
		remove.textContent = "Remove";
		remove.addEventListener("click", async () => {
			const result = await send("remove_site", { origin });
			if (!result?.ok) showError(result?.error?.message || result?.error?.code);
			await render();
		});
		item.append(label, remove);
		list.append(item);
	}
	$("no-sites").hidden = origins.length > 0;

	renderSearch(lastSearch);
}

// permissions.request must be the first call in a click handler (Firefox
// rejects it after an await), so these handlers call it before anything else.
$("grant-ird").addEventListener("click", () => {
	api.permissions.request(IRD_PERMISSION).then(render, (err) => showError(String(err?.message || err)));
});

$("allow-site").addEventListener("click", () => {
	if (!tabOrigin) return;
	api.permissions
		.request({ origins: [originMatchPattern(tabOrigin)] })
		.then(async (granted) => {
			if (!granted) {
				showError("Permission was not granted.");
				return;
			}
			const result = await send("add_site", { origin: tabOrigin, tabId: activeTab?.id });
			showError(result?.ok ? "" : result?.error?.message || result?.error?.code);
			await render();
		})
		.catch((err) => showError(String(err?.message || err)));
});

$("pan-form").addEventListener("submit", (event) => {
	event.preventDefault();
	const pan = $("pan").value.replace(/\s+/g, "");
	if (!isValidPan(pan)) {
		showError("PAN must be exactly 9 digits.");
		return;
	}
	showError("");
	renderSearch({ pan, state: "searching", at: Date.now() });
	send("pan_search", { pan, tabId: activeTab?.id })
		.then((reply) => (reply?.ok ? renderSearch(reply.data) : showError(searchErrorMessage(reply?.error))))
		.catch((err) => showError(String(err?.message || err)));
});

$("pan-clear").addEventListener("click", async () => {
	await send("clear_search");
	$("pan").value = "";
	renderSearch(null);
});

(async () => {
	[activeTab] = await api.tabs.query({ active: true, currentWindow: true });
	tabOrigin = originOf(activeTab?.url);
	await render();
	$("pan").focus();
})().catch((err) => showError(String(err?.message || err)));
