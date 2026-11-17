// Copyright (c) 2026, Yarsa Labs Pvt. Ltd. and contributors
// For license information, please see LICENSE at the root of this repository

frappe.ui.form.on("IRD PAN Lookup", {
	refresh(frm) {
		if (frm.is_new()) return;
		frm.add_custom_button(__("Refresh from IRD"), () => {
			nepal_compliance.ird_bridge
				.search_and_show(frm.doc.pan)
				.then((summary) => summary && summary.found && frm.reload_doc());
		});
	},
});
