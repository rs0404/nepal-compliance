frappe.listview_settings["IRD PAN Lookup"] = {
	onload(listview) {
		listview.page.add_inner_button(__("Search PAN on IRD"), () => {
			frappe.prompt(
				{ fieldname: "pan", fieldtype: "Data", label: __("PAN"), reqd: 1, length: 9 },
				(values) =>
					nepal_compliance.ird_bridge
						.search_and_show(String(values.pan).trim())
						.then(() => listview.refresh()),
				__("Search PAN on IRD"),
				__("Search")
			);
		});
	},
};
