import { CHANNEL, IRD_ORIGIN, IRD_PERMISSION, originMatchPattern, originOf } from "./shared/protocol.js";

const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

let activeTab = null;
let tabOrigin = null;

function send(action, extra) {
	return api.runtime.sendMessage({ channel: CHANNEL, direction: "popup", action, ...extra });
}

function showError(message) {
	$("error").textContent = message || "";
	$("error").hidden = !message;
}

async function render() {
	const status = await send("status");
	if (!status?.ok) {
		showError(status?.error?.message || "The extension did not answer.");
		return;
	}
	const { version, irdAccess, origins } = status.data;
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

(async () => {
	[activeTab] = await api.tabs.query({ active: true, currentWindow: true });
	tabOrigin = originOf(activeTab?.url);
	await render();
})().catch((err) => showError(String(err?.message || err)));
