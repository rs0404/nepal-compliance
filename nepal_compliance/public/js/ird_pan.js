// "Search PAN on IRD" on Customer, Supplier and Company, through the IRD
// Bridge extension (see public/js/ird_bridge.js).
(function () {
	const PARTY = {
		Customer: { pan_field: "customer_vat_number", name_field: "customer_name" },
		Supplier: { pan_field: "supplier_vat_number", name_field: "supplier_name" },
		Company: { pan_field: "company_vat_number", name_field: null },
	};

	const valid_pan = (value) => /^\d{9}$/.test(String(value || "").trim());
	// The VAT/PAN field first, then ERPNext's standard Tax ID.
	const pan_values = (frm, config) =>
		[config.pan_field, "tax_id"].map((field) => String(frm.doc[field] || "").trim()).filter(Boolean);
	const current_pan = (frm, config) => pan_values(frm, config).find(valid_pan) || "";
	const same_name = (a, b) =>
		String(a || "").trim().replace(/\s+/g, " ").toLowerCase() ===
		String(b || "").trim().replace(/\s+/g, " ").toLowerCase();

	function apply_options(frm, config, pan, summary) {
		const options = [];
		if (String(frm.doc[config.pan_field] || "").trim() !== pan) {
			options.push({ fieldname: "set_pan", label: __("Set PAN to {0}", [pan]), default: 1 });
		}
		if (
			config.name_field &&
			summary.trade_name_en &&
			!same_name(frm.doc[config.name_field], summary.trade_name_en)
		) {
			options.push({
				fieldname: "set_name",
				label: __("Use the IRD registered name: {0}", [frappe.utils.escape_html(summary.trade_name_en)]),
				default: !frm.doc[config.name_field],
			});
		}
		// The non-VAT (PAN bill) flag only applies to Company suppliers.
		if (frm.doctype === "Supplier" && frm.doc.supplier_type === "Company" && !summary.is_personal_pan) {
			const not_vat = summary.vat_registered ? 0 : 1;
			if (cint(frm.doc.is_not_vat_registered) !== not_vat) {
				options.push({
					fieldname: "set_vat_flag",
					label: not_vat
						? __("Mark as not VAT registered (IRD shows no active VAT account)")
						: __("Mark as VAT registered (IRD shows an active VAT account)"),
					default: 1,
				});
			}
		}
		return options;
	}

	async function apply(frm, config, values, summary) {
		const changes = {};
		if (values.set_pan) changes[config.pan_field] = summary.pan;
		if (values.set_name) changes[config.name_field] = summary.trade_name_en;
		if (values.set_vat_flag) changes.is_not_vat_registered = summary.vat_registered ? 0 : 1;
		if (!Object.keys(changes).length) return;
		await frm.set_value(changes);
		frappe.show_alert({ message: __("IRD details applied. Save to keep them."), indicator: "blue" });
	}

	// app_include_js only loads on a full page load, so a desk opened before
	// this app was updated has the form script but not the bridge.
	async function load_bridge() {
		if (!window.nepal_compliance?.ird_bridge?.search_and_show) {
			await frappe.require("/assets/nepal_compliance/js/ird_bridge.js");
		}
		return nepal_compliance.ird_bridge;
	}

	function run_search(frm, config, pan) {
		load_bridge()
			.then((bridge) =>
				bridge.search_and_show(
					pan,
					(summary) => apply_options(frm, config, pan, summary),
					(values, summary) => apply(frm, config, values, summary)
				)
			)
			.then((summary) => summary && summary.found && show_cached_status(frm, config))
			.catch((e) => {
				console.error(e);
				if (frappe.msg_dialog?.display) return;
				frappe.msgprint({ title: __("IRD PAN Search"), indicator: "red", message: e.message || String(e) });
			});
	}

	function on_search_click(frm, config) {
		const current = current_pan(frm, config);
		if (current) {
			run_search(frm, config, current);
			return;
		}
		frappe.prompt(
			{
				fieldname: "pan",
				fieldtype: "Data",
				label: __("PAN"),
				reqd: 1,
				length: 9,
				default: pan_values(frm, config)[0] || "",
			},
			(values) => run_search(frm, config, String(values.pan).trim()),
			__("Search PAN on IRD"),
			__("Search")
		);
	}

	function show_cached_status(frm, config) {
		const pan = current_pan(frm, config);
		if (!pan) return;
		frappe
			.xcall("nepal_compliance.ird_bridge.get_cached_pan_lookup", { pan })
			.then((lookup) => {
				if (!lookup || current_pan(frm, config) !== pan) return;
				const esc = frappe.utils.escape_html;
				const active = lookup.pan_status === "Active";
				const parts = [
					`${__("IRD")}: <b>${esc(lookup.pan_status || __("Unknown"))}</b>`,
					lookup.is_personal_pan
						? __("Personal PAN")
						: lookup.vat_registered
						? __("VAT registered")
						: __("Not VAT registered"),
					esc(lookup.trade_name_en || ""),
					__("checked {0}", [comment_when(lookup.last_checked_on)]),
				].filter(Boolean);
				frm.dashboard.set_headline_alert(parts.join(" · "), active ? "green" : "red");
			})
			.catch(() => {});
	}

	Object.entries(PARTY).forEach(([doctype, config]) => {
		frappe.ui.form.on(doctype, {
			refresh(frm) {
				frm.add_custom_button(__("Search PAN on IRD"), () => on_search_click(frm, config), __("IRD"));
				show_cached_status(frm, config);
			},
		});
	});
})();
