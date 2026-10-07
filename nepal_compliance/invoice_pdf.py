"""Attach the TAX INVOICE PDF of each submitted Sales Invoice.

The PDF is rendered in the invoice's print format (its company's format in
Nepal Compliance Settings, else the Sales Invoice default) through Frappe's
printview page like any other print, so it records an Access Log "Print" row for the
submitting user. The attached PDF is therefore the original TAX INVOICE, and
later prints are copies.

Only a TAX INVOICE is ever attached. When the print format does not produce
one, or the PDF cannot be made, nothing is attached and the invoice is tagged
"Tax Invoice Not Attached", so these invoices can be found from the list view.
"""

import re
from io import BytesIO

import frappe
from frappe import _
from frappe.desk.doctype.tag.tag import DocTags
from frappe.utils import cint, strip_html
from pypdf import PdfReader, PdfWriter

from nepal_compliance.print_seal import get_sales_invoice_print_format

SETTINGS = "Nepal Compliance Settings"
FIELD = "attach_sales_invoice"
NOT_ATTACHED_TAG = "Tax Invoice Not Attached"


def attach_invoice_pdf(doc, method=None):
    """Sales Invoice on_submit: save the TAX INVOICE PDF to Attach Sales Invoice.

    Skipped when the setting is off or a file is already attached (a manual
    invoice's hand bill scan). A failure never blocks the submission.
    """
    if doc.doctype != "Sales Invoice" or doc.get(FIELD):
        return
    if not cint(frappe.db.get_single_value(SETTINGS, "attach_invoice_pdf_on_submit")):
        return

    print_format = (
        get_sales_invoice_print_format(doc.company) or frappe.get_meta(doc.doctype).default_print_format or "Standard"
    )
    try:
        pdf = tax_invoice_only(_render(doc, print_format))
    except Exception:
        _not_attached(doc, _("Its PDF could not be made in print format {0}.").format(frappe.bold(print_format)))
        return
    if pdf is None:
        _not_attached(
            doc,
            _("Print format {0} does not print it as a TAX INVOICE. Use a print format titled TAX INVOICE.").format(
                frappe.bold(print_format)
            ),
            with_traceback=False,
        )
        return

    frappe.db.savepoint("attach_invoice_pdf")
    try:
        file_url = _save_file(doc, pdf)
    except Exception:
        frappe.db.rollback(save_point="attach_invoice_pdf")
        _not_attached(doc, _("Its PDF could not be saved."))
        return
    doc.db_set(FIELD, file_url, update_modified=False)


def clear_not_attached_tag(doc, method=None):
    """Sales Invoice on_update_after_submit: drop the tag once a file is attached."""
    if doc.get(FIELD) and doc.has_value_changed(FIELD):
        tags = DocTags(doc.doctype)
        if NOT_ATTACHED_TAG in tags.get_tags(doc.name).split(","):
            tags.remove(doc.name, NOT_ATTACHED_TAG)


def _not_attached(doc, reason, with_traceback=True):
    """Tag the invoice, log why, and tell the user no TAX INVOICE was attached."""
    DocTags(doc.doctype).add(doc.name, NOT_ATTACHED_TAG)
    title = f"Tax Invoice not attached to {doc.name}"
    # Without a message, log_error records the current traceback.
    frappe.log_error(
        title, None if with_traceback else strip_html(reason),
        reference_doctype=doc.doctype, reference_name=doc.name,
    )
    frappe.msgprint(
        _("Sales Invoice {0} was submitted without its TAX INVOICE attached. {1} It is tagged {2}.").format(
            frappe.bold(doc.name), reason, frappe.bold(NOT_ATTACHED_TAG)
        ),
        title=_("Tax Invoice Not Attached"),
        indicator="orange",
    )


def _render(doc, print_format):
    # A fresh copy keeps the render's flags and link titles off the submitting doc.
    print_doc = frappe.get_doc(doc.doctype, doc.name)
    # The bundled formats then print the TAX INVOICE without its INVOICE copy.
    print_doc.flags.tax_invoice_only = True
    return frappe.get_print(doc.doctype, doc.name, print_format, doc=print_doc, as_pdf=True)


def _save_file(doc, pdf):
    file = frappe.get_doc({
        "doctype": "File",
        "file_name": "{0}.pdf".format(doc.name.replace(" ", "-").replace("/", "-")),
        "attached_to_doctype": doc.doctype,
        "attached_to_name": doc.name,
        "attached_to_field": FIELD,
        "is_private": 1,
        "content": pdf,
    })
    file.insert(ignore_permissions=True)
    return file.file_url


def tax_invoice_only(pdf):
    """Return the TAX INVOICE pages of pdf, or None when it is not a TAX INVOICE.

    The first page must carry the title TAX INVOICE. Any INVOICE copy printed
    after it (by formats that ignore doc.flags.tax_invoice_only) is cut off at
    the first later page titled INVOICE. Titles are matched as whole lines,
    ignoring case and spacing, so "Invoice No" and the like never match.
    """
    reader = PdfReader(BytesIO(pdf))
    titles = [
        {re.sub(r"\s+", "", line).upper() for line in (page.extract_text() or "").splitlines()}
        for page in reader.pages
    ]
    if not titles or "TAXINVOICE" not in titles[0]:
        return None

    copy_starts = next(
        (index for index, lines in enumerate(titles) if "INVOICE" in lines and "TAXINVOICE" not in lines), None
    )
    if copy_starts is None:
        return pdf

    writer = PdfWriter()
    for page in reader.pages[:copy_starts]:
        writer.add_page(page)
    with BytesIO() as output:
        writer.write(output)
        return output.getvalue()
