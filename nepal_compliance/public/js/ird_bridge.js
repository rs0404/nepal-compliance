// ERP side of the IRD Bridge browser extension.
//
// The extension's content script runs on ERP sites the user has allowed. It
// marks <html data-nc-ird-bridge="<version>"> and relays window messages on
// the "nc-ird-bridge" channel to the extension, which does the IRD work in an
// IRD tab of the same browser and answers on the same channel.
frappe.provide("nepal_compliance.ird_bridge");

(function () {
	// Loaded on every desk page, and again by forms that find it missing.
	if (nepal_compliance.ird_bridge.search_pan) return;

	const CHANNEL = "nc-ird-bridge";
	const PING_TIMEOUT_MS = 2000;
	const PAN_SEARCH_TIMEOUT_MS = 3 * 60 * 1000;
	const pending = new Map();
	let sequence = 0;

	const ERROR_MESSAGES = {
		no_ird_permission: __(
			"The IRD Bridge extension is not allowed to open ird.gov.np. Open the extension's popup and click Grant IRD access."
		),
		timeout: __("IRD did not answer in time. Please try again."),
		tab_closed: __("The IRD tab was closed before the search finished."),
		page_changed: __(
			"The IRD PAN search page has changed and the extension could not use it. Please update the IRD Bridge extension."
		),
		ird_error: __("IRD's PAN search returned an error. Please try again."),
		not_allowed: __(
			"This ERP site is not allowed in the IRD Bridge extension. Open its popup here and click Allow this ERP site."
		),
		extension_reloaded: __("The IRD Bridge extension was updated or reloaded. Reload this page and try again."),
	};

	class IRDBridgeError extends Error {
		constructor(code, message) {
			super(message || ERROR_MESSAGES[code] || code);
			this.code = code;
		}
	}

	window.addEventListener("message", (event) => {
		if (event.source !== window || event.origin !== window.location.origin) return;
		const msg = event.data;
		if (!msg || msg.channel !== CHANNEL || msg.direction !== "to-erp") return;
		if (msg.event === "pan_result") {
			on_popup_result(msg.payload);
			return;
		}
		if (!msg.id) return;
		const entry = pending.get(msg.id);
		if (!entry) return;
		pending.delete(msg.id);
		clearTimeout(entry.timer);
		if (msg.ok) {
			entry.resolve(msg.data);
		} else {
			const error = msg.error || {};
			entry.reject(new IRDBridgeError(error.code || "error", error.message));
		}
	});

	function request(action, payload, timeout_ms) {
		return new Promise((resolve, reject) => {
			const id = `${Date.now()}-${++sequence}`;
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new IRDBridgeError("timeout"));
			}, timeout_ms);
			pending.set(id, { resolve, reject, timer });
			window.postMessage(
				{ channel: CHANNEL, direction: "to-extension", id, action, payload: payload || {} },
				window.location.origin
			);
		});
	}

	function installed_version() {
		return document.documentElement.dataset.ncIrdBridge || null;
	}

	async function is_available() {
		if (!installed_version()) return false;
		try {
			await request("ping", {}, PING_TIMEOUT_MS);
			return true;
		} catch (e) {
			return false;
		}
	}

	function show_install_help() {
		frappe.msgprint({
			title: __("IRD Bridge extension not found"),
			indicator: "orange",
			message: `
				<p>${__(
					"PAN search on IRD runs through the IRD Bridge browser extension (Chrome or Firefox)."
				)}</p>
				<ol>
					<li>${__(
						"Get the IRD Bridge package for your browser from your system administrator and unzip it."
					)}</li>
					<li>${__(
						"Chrome, Edge or Brave: open <b>chrome://extensions</b>, turn on <b>Developer mode</b>, click <b>Load unpacked</b> and pick the unzipped folder."
					)}</li>
					<li>${__(
						"Firefox: open <b>about:debugging#/runtime/this-firefox</b>, click <b>Load Temporary Add-on</b> and pick <b>manifest.json</b> in the unzipped folder."
					)}</li>
					<li>${__(
						"Come back to this ERP tab, click the IRD Bridge icon in the toolbar and click <b>Allow this ERP site</b>. If it shows <b>Grant IRD access</b>, click that too."
					)}</li>
					<li>${__("Reload this page and try again.")}</li>
				</ol>
				<p class="text-muted">${__(
					"Already installed? Then this ERP site is not allowed yet, or the page was open before it was allowed: do the last two steps."
				)}</p>`,
		});
	}

	// The saved IRD result for a PAN when the ERP has one, else a fresh search.
	// For checks that run as the user types, where opening IRD each time for a
	// PAN the ERP already knows would only slow them down.
	async function lookup_pan(pan) {
		pan = String(pan || "").replace(/\s+/g, "");
		const cached = await frappe
			.xcall("nepal_compliance.ird_bridge.get_cached_pan_lookup", { pan })
			.catch(() => null);
		if (cached) return Object.assign({ found: true, cached: true }, cached);
		return search_pan(pan);
	}

	// A PAN searched from the extension's popup while this ERP tab was open:
	// save it like any other search and show it.
	async function on_popup_result(payload) {
		const pan = String((payload && payload.pan) || "");
		if (!/^\d{9}$/.test(pan) || !payload.response) return;
		const r = await frappe.call({
			method: "nepal_compliance.ird_bridge.record_pan_lookup",
			args: { pan, response: JSON.stringify(payload.response) },
		});
		show_result(r.message);
	}

	// Runs IRD's PAN search in the browser and caches the answer in the ERP.
	// Resolves with the server's summary ({found, pan, trade_name_en, ...}).
	async function search_pan(pan) {
		pan = String(pan || "").replace(/\s+/g, "");
		if (!/^\d{9}$/.test(pan)) {
			frappe.throw(__("PAN must be exactly 9 digits."));
		}
		if (!(await is_available())) {
			show_install_help();
			throw new IRDBridgeError("not_installed", __("IRD Bridge extension not found."));
		}

		frappe.dom.freeze(
			__(
				"Searching PAN {0} on IRD… If IRD shows a captcha in its tab, complete it there.",
				[pan]
			)
		);
		try {
			const result = await request("pan_search", { pan }, PAN_SEARCH_TIMEOUT_MS);
			const r = await frappe.call({
				method: "nepal_compliance.ird_bridge.record_pan_lookup",
				args: { pan, response: JSON.stringify(result.response) },
				freeze: false,
			});
			return r.message;
		} finally {
			frappe.dom.unfreeze();
		}
	}

	function details_html(summary) {
		const esc = (v) => frappe.utils.escape_html(v == null || v === "" ? "-" : String(v));
		const row = (label, value) => `<tr><th style="width:40%">${esc(label)}</th><td>${value}</td></tr>`;
		const status_color = summary.pan_status === "Active" ? "green" : "red";
		const registrations = (summary.registrations || [])
			.map(
				(r) =>
					`<tr><td>${esc(r.account_type)}</td><td>${esc(r.registration_date)}</td><td>${esc(
						r.filing_period
					)}</td><td>${esc(r.status)}</td></tr>`
			)
			.join("");
		return `
			<table class="table table-bordered table-sm">
				${row(__("PAN"), esc(summary.pan))}
				${row(__("Name (English)"), esc(summary.trade_name_en))}
				${row(__("Name (Nepali)"), esc(summary.trade_name_np))}
				${row(__("Address"), esc([summary.address, summary.ward_no && __("Ward {0}", [summary.ward_no])].filter(Boolean).join(", ")))}
				${row(__("IRD Office"), esc(summary.ird_office))}
				${row(__("PAN Status"), `<span class="indicator-pill ${status_color}">${esc(summary.pan_status)}</span>`)}
				${row(__("VAT Registered"), summary.vat_registered ? __("Yes") : __("No"))}
				${summary.tax_clearance_status ? row(__("Tax Clearance"), esc(`${summary.tax_clearance_status} (${summary.tax_clearance_fiscal_year || "-"})`)) : ""}
			</table>
			${
				registrations
					? `<table class="table table-bordered table-sm">
						<thead><tr><th>${__("Account Type")}</th><th>${__("Reg. Date")}</th><th>${__(
							"Filing Period"
						)}</th><th>${__("Status")}</th></tr></thead>
						<tbody>${registrations}</tbody></table>`
					: ""
			}`;
	}

	// Shows a found PAN. `apply_options` are checkboxes {fieldname, label,
	// default}; `on_apply(values)` is called with the ticked ones.
	function show_result(summary, apply_options, on_apply) {
		if (!summary || !summary.found) {
			frappe.msgprint({
				title: __("PAN not found"),
				indicator: "red",
				message: __("IRD has no record of PAN {0}.", [frappe.utils.escape_html(summary?.pan || "")]),
			});
			return;
		}
		const fields = [{ fieldtype: "HTML", fieldname: "details", options: details_html(summary) }];
		(apply_options || []).forEach((opt) =>
			fields.push({ fieldtype: "Check", fieldname: opt.fieldname, label: opt.label, default: opt.default ? 1 : 0 })
		);
		const can_apply = Boolean(apply_options && apply_options.length && on_apply);
		const dialog = new frappe.ui.Dialog({
			title: __("IRD PAN Search: {0}", [summary.pan]),
			size: "large",
			fields,
			primary_action_label: can_apply ? __("Apply") : __("Close"),
			primary_action(values) {
				dialog.hide();
				if (can_apply) on_apply(values);
			},
			secondary_action_label: __("Open IRD Record"),
			secondary_action() {
				dialog.hide();
				frappe.set_route("Form", "IRD PAN Lookup", summary.lookup || summary.pan);
			},
		});
		dialog.show();
	}

	// search_pan + show_result, reporting bridge errors to the user.
	async function search_and_show(pan, get_apply_options, on_apply) {
		let summary;
		try {
			summary = await search_pan(pan);
		} catch (e) {
			if (e instanceof IRDBridgeError) {
				if (e.code !== "not_installed") {
					frappe.msgprint({ title: __("IRD PAN Search"), indicator: "red", message: e.message });
				}
				return null;
			}
			throw e;
		}
		const options = summary && summary.found && get_apply_options ? get_apply_options(summary) : [];
		show_result(summary, options, on_apply && ((values) => on_apply(values, summary)));
		return summary;
	}

	Object.assign(nepal_compliance.ird_bridge, {
		IRDBridgeError,
		installed_version,
		is_available,
		lookup_pan,
		search_pan,
		search_and_show,
		show_result,
		show_install_help,
	});
})();
