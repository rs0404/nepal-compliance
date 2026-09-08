from erpnext.accounts.doctype.purchase_invoice.purchase_invoice import PurchaseInvoice

from nepal_compliance.utils import apply_taxable_amount_as_tds_base


class CustomPurchaseInvoice(PurchaseInvoice):
    def set_tax_withholding(self):
        """Use Taxable Amount as the TDS base when the withholding category requires it."""
        apply_taxable_amount_as_tds_base(self)
        super().set_tax_withholding()
        # ERPNext recalculates tax_withholding_net_total from all Apply TDS
        # items after inserting the Actual TDS row. Restore the configured
        # taxable base so the invoice records the amount actually used.
        apply_taxable_amount_as_tds_base(self)
