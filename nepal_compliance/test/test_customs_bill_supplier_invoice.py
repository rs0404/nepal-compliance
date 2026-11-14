import unittest
from unittest.mock import patch

from erpnext.accounts.doctype.purchase_invoice.purchase_invoice import PurchaseInvoice

from nepal_compliance.overrides.purchase_invoice import CustomPurchaseInvoice


def make_invoice(customs_declaration_number=None):
    invoice = object.__new__(CustomPurchaseInvoice)
    invoice.customs_declaration_number = customs_declaration_number
    return invoice


class TestCustomsBillSupplierInvoice(unittest.TestCase):
    @patch.object(PurchaseInvoice, "validate_supplier_invoice")
    def test_customs_bill_skips_the_unique_supplier_invoice_check(self, erpnext_check):
        make_invoice("M41921").validate_supplier_invoice()
        erpnext_check.assert_not_called()

    @patch.object(PurchaseInvoice, "validate_supplier_invoice")
    def test_other_bills_keep_the_check(self, erpnext_check):
        make_invoice().validate_supplier_invoice()
        erpnext_check.assert_called_once()


if __name__ == "__main__":
    unittest.main()
