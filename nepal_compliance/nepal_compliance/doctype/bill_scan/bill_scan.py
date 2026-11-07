# Copyright (c) 2026, Yarsa Labs Pvt. Ltd. and contributors
# For license information, please see LICENSE at the root of this repository

from frappe.model.document import Document

from nepal_compliance.bill_scan import clear_learned_index


class BillScan(Document):
    def on_update(self):
        clear_learned_index()

    def on_trash(self):
        clear_learned_index()
