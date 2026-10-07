import unittest
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from pypdf import PdfReader

from nepal_compliance import invoice_pdf


def _pdf(*pages):
    """A PDF with one page per entry, each page holding those lines of text."""
    objects = ["<< /Type /Catalog /Pages 2 0 R >>", None, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    kids = []
    for lines in pages:
        text = " ".join(f"({line}) Tj 0 -20 Td" for line in lines)
        stream = f"BT /F1 12 Tf 72 720 Td {text} ET"
        objects.append(f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream")
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
            f"/Resources << /Font << /F1 3 0 R >> >> /Contents {len(objects)} 0 R >>"
        )
        kids.append(f"{len(objects)} 0 R")
    objects[1] = f"<< /Type /Pages /Kids [{' '.join(kids)}] /Count {len(kids)} >>"

    out, offsets = "%PDF-1.4\n", []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n{body}\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n"
    out += "".join(f"{offset:010d} 00000 n \n" for offset in offsets)
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"
    return out.encode("latin-1")


def _page_texts(pdf):
    return [page.extract_text() for page in PdfReader(BytesIO(pdf)).pages]


TAX_INVOICE = _pdf(["ABC Traders", "TAX INVOICE", "Invoice No: 1"])
REPRINT = _pdf(["ABC Traders", "INVOICE", "COPY OF ORIGINAL 1"])


def _invoice(attached=None):
    doc = MagicMock()
    doc.doctype = "Sales Invoice"
    doc.name = "SINV/082-083/0001"
    doc.company = "ABC Traders"
    doc.get.side_effect = lambda field: attached if field == "attach_sales_invoice" else None
    return doc


class TestAttachInvoicePdf(unittest.TestCase):
    def _attach(self, doc, enabled=True, default_format="VAT Invoice - Standard", company_format=None,
                rendered=TAX_INVOICE, render_error=None, save_error=None):
        print_doc = SimpleNamespace(flags=SimpleNamespace())
        file = MagicMock(file_url="/private/files/SINV-082-083-0001.pdf")
        file.insert.side_effect = save_error
        db = MagicMock()
        db.get_single_value.return_value = int(enabled)
        tags = MagicMock()
        frappe = invoice_pdf.frappe
        with patch.object(frappe, "db", db), \
             patch.object(frappe, "get_meta", return_value=SimpleNamespace(default_print_format=default_format)), \
             patch.object(frappe, "get_print", return_value=rendered, side_effect=render_error) as get_print, \
             patch.object(frappe, "get_doc", side_effect=lambda *args: print_doc if len(args) == 2 else file) as get_doc, \
             patch.object(frappe, "bold", side_effect=lambda text: text), \
             patch.object(invoice_pdf, "DocTags", return_value=tags), \
             patch.object(invoice_pdf, "get_sales_invoice_print_format", return_value=company_format) as company, \
             patch.object(frappe, "log_error") as log_error, \
             patch.object(frappe, "msgprint") as msgprint:
            invoice_pdf.attach_invoice_pdf(doc, "on_submit")
        return SimpleNamespace(print_doc=print_doc, file=file, get_print=get_print, get_doc=get_doc, db=db,
                               tags=tags, log_error=log_error, msgprint=msgprint, company=company)

    def assertNotAttached(self, doc, run):
        doc.db_set.assert_not_called()
        run.tags.add.assert_called_once_with(doc.name, "Tax Invoice Not Attached")
        run.log_error.assert_called_once()
        self.assertIn("Tax Invoice Not Attached", run.msgprint.call_args.args[0])

    def test_tax_invoice_pdf_is_attached(self):
        doc = _invoice()
        run = self._attach(doc)

        run.get_print.assert_called_once_with(
            "Sales Invoice", doc.name, "VAT Invoice - Standard", doc=run.print_doc, as_pdf=True
        )
        file_values = run.get_doc.call_args_list[-1].args[0]
        self.assertEqual(file_values["attached_to_field"], "attach_sales_invoice")
        self.assertEqual(file_values["file_name"], "SINV-082-083-0001.pdf")
        self.assertEqual(file_values["is_private"], 1)
        self.assertEqual(file_values["content"], TAX_INVOICE)
        doc.db_set.assert_called_once_with("attach_sales_invoice", run.file.file_url, update_modified=False)
        run.tags.add.assert_not_called()

    def test_invoice_copy_is_left_out_of_the_attachment(self):
        run = self._attach(_invoice(), rendered=_pdf(["TAX INVOICE"], ["INVOICE"]))

        pages = _page_texts(run.get_doc.call_args_list[-1].args[0]["content"])
        self.assertEqual(len(pages), 1)
        self.assertIn("TAX INVOICE", pages[0])

    def test_render_asks_for_the_tax_invoice_only(self):
        run = self._attach(_invoice())

        self.assertTrue(run.print_doc.flags.tax_invoice_only)

    def test_company_print_format_comes_first(self):
        run = self._attach(_invoice(), company_format="ABC Tax Invoice")

        run.company.assert_called_once_with("ABC Traders")
        self.assertEqual(run.get_print.call_args.args[2], "ABC Tax Invoice")

    def test_no_default_format_renders_frappe_standard(self):
        run = self._attach(_invoice(), default_format=None)

        self.assertEqual(run.get_print.call_args.args[2], "Standard")

    def test_a_pdf_that_is_not_a_tax_invoice_is_never_attached(self):
        # e.g. the draft was printed, so the format now prints COPY OF ORIGINAL
        doc = _invoice()
        run = self._attach(doc, rendered=REPRINT)

        run.get_doc.assert_called_once()  # only the print copy, no File
        self.assertNotAttached(doc, run)
        self.assertIn("VAT Invoice - Standard", run.msgprint.call_args.args[0])

    def test_render_failure_tags_the_invoice_without_blocking_the_submission(self):
        doc = _invoice()
        run = self._attach(doc, render_error=RuntimeError("wkhtmltopdf failed"))

        self.assertNotAttached(doc, run)
        run.db.rollback.assert_not_called()

    def test_save_failure_rolls_back_the_file_and_tags_the_invoice(self):
        doc = _invoice()
        run = self._attach(doc, save_error=OSError("disk full"))

        run.db.rollback.assert_called_once_with(save_point="attach_invoice_pdf")
        self.assertNotAttached(doc, run)

    def test_setting_off_does_nothing(self):
        doc = _invoice()
        run = self._attach(doc, enabled=False)

        run.get_print.assert_not_called()
        doc.db_set.assert_not_called()
        run.tags.add.assert_not_called()

    def test_existing_attachment_is_never_replaced(self):
        # A manual invoice's hand bill scan must stay.
        doc = _invoice(attached="/private/files/hand-bill.jpg")
        run = self._attach(doc)

        run.get_print.assert_not_called()
        doc.db_set.assert_not_called()
        run.tags.add.assert_not_called()


class TestClearNotAttachedTag(unittest.TestCase):
    def _clear(self, attached, changed=True, tags=",Tax Invoice Not Attached"):
        doc = _invoice(attached)
        doc.has_value_changed.return_value = changed
        doc_tags = MagicMock()
        doc_tags.get_tags.return_value = tags
        with patch.object(invoice_pdf, "DocTags", return_value=doc_tags):
            invoice_pdf.clear_not_attached_tag(doc, "on_update_after_submit")
        return doc_tags

    def test_attaching_a_file_later_removes_the_tag(self):
        doc_tags = self._clear("/private/files/tax-invoice.pdf")

        doc_tags.remove.assert_called_once_with("SINV/082-083/0001", "Tax Invoice Not Attached")

    def test_tag_stays_while_nothing_is_attached(self):
        self._clear(None).remove.assert_not_called()

    def test_other_updates_leave_tags_alone(self):
        self._clear("/private/files/tax-invoice.pdf", changed=False).remove.assert_not_called()
        self._clear("/private/files/tax-invoice.pdf", tags=",Urgent").remove.assert_not_called()


class TestTaxInvoiceOnly(unittest.TestCase):
    def test_invoice_copy_after_the_tax_invoice_is_dropped(self):
        pdf = _pdf(["ABC Traders", "TAX INVOICE", "Invoice No: 1"], ["ABC Traders", "INVOICE", "Invoice No: 1"])

        pages = _page_texts(invoice_pdf.tax_invoice_only(pdf))

        self.assertEqual(len(pages), 1)
        self.assertIn("TAX INVOICE", pages[0])

    def test_a_long_tax_invoice_keeps_all_its_pages(self):
        pdf = _pdf(
            ["TAX INVOICE", "Item 1"], ["Item 40", "Invoice No: 1"],
            ["INVOICE", "Item 1"], ["Item 40"],
        )

        pages = _page_texts(invoice_pdf.tax_invoice_only(pdf))

        self.assertEqual(len(pages), 2)
        self.assertIn("Item 40", pages[1])

    def test_title_case_and_spacing_do_not_matter(self):
        pdf = _pdf(["Tax  Invoice"], ["Invoice"])

        self.assertEqual(len(_page_texts(invoice_pdf.tax_invoice_only(pdf))), 1)

    def test_a_tax_invoice_alone_is_returned_as_it_is(self):
        pdf = _pdf(["TAX INVOICE", "Item 1"], ["Item 40"])

        self.assertIs(invoice_pdf.tax_invoice_only(pdf), pdf)

    def test_anything_but_a_tax_invoice_is_rejected(self):
        for pages in (
            [["INVOICE", "COPY OF ORIGINAL 1"]],  # a reprint
            [["CREDIT NOTE"]],
            [["Sales Invoice", "Invoice No: 1"]],  # a format with no TAX INVOICE title
            [["INVOICE"], ["TAX INVOICE"]],  # the tax invoice must come first
        ):
            self.assertIsNone(invoice_pdf.tax_invoice_only(_pdf(*pages)), pages)
