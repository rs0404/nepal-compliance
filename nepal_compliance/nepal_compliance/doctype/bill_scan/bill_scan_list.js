// Copyright (c) 2026, Yarsa Labs Pvt. Ltd. and contributors
// For license information, please see LICENSE at the root of this repository

frappe.listview_settings["Bill Scan"] = {
    onload(listview) {
        if (!frappe.model.can_create("Bill Scan")) return;
        listview.page.add_inner_button(__("Learn From Past Bills"), () => {
            frappe.prompt(
                {
                    fieldtype: "Int",
                    fieldname: "limit",
                    label: __("Number of Bills"),
                    default: 20,
                    description: __("Reads bills attached to submitted Purchase Invoices in this browser, so their suppliers are recognised on the next upload."),
                },
                ({ limit }) => {
                    frappe.require("/assets/nepal_compliance/js/bill_scan.js", () =>
                        nepal_compliance.bill_scan.learn_past_bills(limit).then(() => listview.refresh())
                    );
                },
                __("Learn From Past Bills")
            );
        });
    },
};
