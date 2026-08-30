import hashlib
import json

import frappe
from frappe import _
from frappe.utils import flt, getdate
from frappe.utils.background_jobs import enqueue

from nepal_compliance.utils import set_taxable_amounts

BATCH_SIZE = 500
PREVIEW_TABLE_LIMIT = 100
DOCTYPE_ORDER = ("Sales Invoice", "Purchase Invoice")


def _job_id(operation, from_date, to_date):
    """Return a deterministic per-user job ID for one operation and date range."""
    user = frappe.session.user or "Guest"
    user_key = hashlib.sha256(user.encode()).hexdigest()[:16]
    return f"taxable-summary-{operation}-{user_key}-{from_date}-{to_date}"


def _ensure_permission():
    """Require write access on Settings and on Sales/Purchase Invoice."""
    if not frappe.has_permission("Nepal Compliance Settings", "write"):
        frappe.throw(
            _("Not permitted to recompute taxable summary."), frappe.PermissionError
        )
    for doctype in DOCTYPE_ORDER:
        if not frappe.has_permission(doctype, "write"):
            frappe.throw(
                _("Not permitted to update {0}.").format(doctype),
                frappe.PermissionError,
            )


def _resolve_dates(from_date, to_date):
    """Parse and validate the posting-date range used by preview and apply."""
    from_date = getdate(from_date) if from_date else None
    to_date = getdate(to_date) if to_date else None
    if not from_date or not to_date:
        frappe.throw(_("From Posting Date and To Posting Date are required."))
    if from_date > to_date:
        frappe.throw(_("From Posting Date cannot be after To Posting Date."))
    return from_date, to_date


def _invoice_filters(from_date, to_date):
    """Submitted Sales/Purchase Invoice filters for the posting-date range."""
    return {
        "docstatus": 1,
        "posting_date": ["between", [from_date, to_date]],
    }


def _count_invoices(from_date, to_date):
    """Count submitted sales and purchase invoices in the date range."""
    return sum(
        frappe.db.count(doctype, _invoice_filters(from_date, to_date))
        for doctype in DOCTYPE_ORDER
    )


def _iter_invoice_rows(from_date, to_date):
    """Yield (doctype, row) for submitted invoices, in batches of BATCH_SIZE."""
    fields = [
        "name",
        "company",
        "posting_date",
        "taxable_amount",
        "non_taxable_amount",
        "vat_amount",
        "summary_grand_total",
        "item_vat_detail",
    ]
    for doctype in DOCTYPE_ORDER:
        start = 0
        while True:
            rows = frappe.get_all(
                doctype,
                filters=_invoice_filters(from_date, to_date),
                fields=fields,
                limit_start=start,
                limit_page_length=BATCH_SIZE,
                order_by="posting_date, name",
            )
            if not rows:
                break
            for row in rows:
                yield doctype, row
            if len(rows) < BATCH_SIZE:
                break
            start += BATCH_SIZE


def _amt(value):
    """Round a money field to 2 decimals, preserving None."""
    return None if value is None else flt(value, 2)


def _norm_vat_detail(value):
    """Stable JSON for comparing stored item VAT maps."""
    if value is None or value == "":
        return None
    parsed = value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError):
            return str(value)
    if not isinstance(parsed, dict):
        return str(value)
    return json.dumps(parsed, sort_keys=True, default=str)


def _figures_changed(old, new):
    """True when taxable figures, grand total, or item VAT detail would change."""
    return (
        _amt(old.taxable_amount) != _amt(new.taxable_amount)
        or _amt(old.non_taxable_amount) != _amt(new.non_taxable_amount)
        or _amt(old.vat_amount) != _amt(new.vat_amount)
        or _amt(old.summary_grand_total) != _amt(new.summary_grand_total)
        or _norm_vat_detail(old.item_vat_detail)
        != _norm_vat_detail(new.item_vat_detail)
    )


def _compute_refresh_row(doctype, row):
    """Recompute one invoice's taxable summary and classify the result."""
    if not frappe.has_permission(doctype, "write", doc=row.name):
        return "denied", None, None

    doc = frappe.get_doc(doctype, row.name)
    set_taxable_amounts(doc, None)
    if doc.get("taxable_amount") is None:
        return "skipped", None, doc

    if not _figures_changed(row, doc):
        return "unchanged", None, doc

    return (
        "changed",
        {
            "doctype": doctype,
            "name": row.name,
            "company": row.company,
            "posting_date": str(row.posting_date),
            "old_taxable_amount": _amt(row.taxable_amount),
            "new_taxable_amount": _amt(doc.taxable_amount),
            "old_non_taxable_amount": _amt(row.non_taxable_amount),
            "new_non_taxable_amount": _amt(doc.non_taxable_amount),
            "old_vat_amount": _amt(row.vat_amount),
            "new_vat_amount": _amt(doc.vat_amount),
            "summary_grand_total": doc.summary_grand_total,
            "item_vat_detail": doc.item_vat_detail,
        },
        doc,
    )


def _scan_changes(from_date, to_date):
    """Scan invoices in range and return preview rows plus counts."""
    scanned = 0
    unchanged = 0
    skipped = 0
    denied = 0
    failed = 0
    by_doctype = {doctype: 0 for doctype in DOCTYPE_ORDER}
    changes = []

    for doctype, row in _iter_invoice_rows(from_date, to_date):
        scanned += 1
        try:
            status, change, _doc = _compute_refresh_row(doctype, row)
        except Exception:  # noqa: BLE001 - report each invoice failure and continue the batch
            failed += 1
            frappe.log_error(
                title=f"Taxable summary preview failed for {doctype} {row.name}",
                message=frappe.get_traceback(),
            )
            continue
        if status == "skipped":
            skipped += 1
        elif status == "denied":
            denied += 1
        elif status == "unchanged":
            unchanged += 1
        else:
            by_doctype[doctype] += 1
            if len(changes) < PREVIEW_TABLE_LIMIT:
                changes.append(
                    {
                        k: change[k]
                        for k in change
                        if k not in ("summary_grand_total", "item_vat_detail")
                    }
                )

    changed = sum(by_doctype.values())
    return {
        "queued": False,
        "from_date": str(from_date),
        "to_date": str(to_date),
        "scanned": scanned,
        "changed": changed,
        "unchanged": unchanged,
        "skipped": skipped,
        "denied": denied,
        "failed": failed,
        "sales_changed": by_doctype["Sales Invoice"],
        "purchase_changed": by_doctype["Purchase Invoice"],
        "batched": scanned > BATCH_SIZE,
        "changes": changes,
        "hidden_rows": max(changed - len(changes), 0),
    }


def _apply_change(change, doc):
    """Write recomputed taxable summary fields and add a comment on the invoice."""
    frappe.db.set_value(
        change["doctype"],
        change["name"],
        {
            "taxable_amount": change["new_taxable_amount"],
            "non_taxable_amount": change["new_non_taxable_amount"],
            "vat_amount": change["new_vat_amount"],
            "summary_grand_total": change["summary_grand_total"],
            "item_vat_detail": change["item_vat_detail"],
        },
        update_modified=False,
    )
    doc.add_comment(
        "Comment",
        _(
            "Nepal Compliance: taxable summary recomputed from VAT base "
            "(VAT ÷ rate). Taxable: {0}, Non-Taxable: {1}, VAT: {2}"
        ).format(
            flt(change["new_taxable_amount"], 2),
            flt(change["new_non_taxable_amount"], 2),
            flt(change["new_vat_amount"], 2),
        ),
    )


def _run_apply(from_date, to_date):
    """Apply recomputed taxable summary values, committing every BATCH_SIZE invoices."""
    result = {
        "updated": 0,
        "denied": 0,
        "skipped": 0,
        "unchanged": 0,
        "failed": 0,
    }
    batch_count = 0
    for doctype, row in _iter_invoice_rows(from_date, to_date):
        savepoint = "taxable_summary_invoice"
        frappe.db.savepoint(savepoint)
        try:
            status, change, doc = _compute_refresh_row(doctype, row)
            if status != "changed":
                result[status] += 1
                frappe.db.release_savepoint(savepoint)
                continue
            _apply_change(change, doc)
        except Exception:  # noqa: BLE001 - rollback one invoice and continue the batch
            frappe.db.rollback(save_point=savepoint)
            result["failed"] += 1
            frappe.log_error(
                title=f"Taxable summary apply failed for {doctype} {row.name}",
                message=frappe.get_traceback(),
            )
            continue
        frappe.db.release_savepoint(savepoint)
        result["updated"] += 1
        batch_count += 1
        if batch_count >= BATCH_SIZE:
            # Checkpoint so a long-queue job does not hold one transaction
            # across thousands of submitted invoices.
            frappe.db.commit()  # nosemgrep
            batch_count = 0
    if batch_count:
        # Final checkpoint for the remainder of the last batch.
        frappe.db.commit()  # nosemgrep

    return result


@frappe.whitelist()
def preview_taxable_summary_refresh(
    from_date: str, to_date: str, request_id: str | None = None
):
    """Preview invoices whose taxable summary would change in the date range.

    Ranges larger than BATCH_SIZE run on the long queue so the HTTP worker
    is not blocked loading every invoice.
    """
    _ensure_permission()
    from_date, to_date = _resolve_dates(from_date, to_date)
    request_id = request_id or frappe.generate_hash(length=16)
    scanned = _count_invoices(from_date, to_date)
    if scanned > BATCH_SIZE:
        job = enqueue(
            method="nepal_compliance.taxable_summary.run_taxable_summary_preview",
            queue="long",
            timeout=3600,
            is_async=True,
            job_id=_job_id("preview", from_date, to_date),
            deduplicate=True,
            from_date=str(from_date),
            to_date=str(to_date),
            request_id=request_id,
        )
        return {
            "queued": True,
            "duplicate": job is None,
            "updated": 0,
            "scanned": scanned,
            "from_date": str(from_date),
            "to_date": str(to_date),
            "request_id": request_id,
        }
    preview = _scan_changes(from_date, to_date)
    preview["request_id"] = request_id
    return preview


@frappe.whitelist()
def apply_taxable_summary_refresh(
    from_date: str, to_date: str, request_id: str | None = None
):
    """Apply recomputed taxable summary values, enqueueing ranges above BATCH_SIZE."""
    _ensure_permission()
    from_date, to_date = _resolve_dates(from_date, to_date)
    request_id = request_id or frappe.generate_hash(length=16)
    scanned = _count_invoices(from_date, to_date)
    if not scanned:
        return {
            "queued": False,
            "updated": 0,
            "scanned": 0,
            "request_id": request_id,
        }

    if scanned > BATCH_SIZE:
        job = enqueue(
            method="nepal_compliance.taxable_summary.run_taxable_summary_refresh",
            queue="long",
            timeout=3600,
            is_async=True,
            job_id=_job_id("apply", from_date, to_date),
            deduplicate=True,
            from_date=str(from_date),
            to_date=str(to_date),
            request_id=request_id,
        )
        return {
            "queued": True,
            "duplicate": job is None,
            "updated": 0,
            "scanned": scanned,
            "request_id": request_id,
        }

    result = _run_apply(from_date, to_date)
    return {
        "queued": False,
        "scanned": scanned,
        "request_id": request_id,
        **result,
    }


def run_taxable_summary_preview(
    from_date: str, to_date: str, request_id: str | None = None
):
    """Background preview scan; publishes taxable_summary_preview_done when finished."""
    try:
        from_date, to_date = _resolve_dates(from_date, to_date)
        _ensure_permission()
        preview = _scan_changes(from_date, to_date)
        preview["request_id"] = request_id
        frappe.publish_realtime(
            "taxable_summary_preview_done",
            preview,
            user=frappe.session.user,
        )
        return preview
    except Exception as error:
        frappe.publish_realtime(
            "taxable_summary_preview_done",
            {"request_id": request_id, "error": str(error)},
            user=frappe.session.user,
        )
        raise


def run_taxable_summary_refresh(
    from_date: str, to_date: str, request_id: str | None = None
):
    """Background apply; publishes taxable_summary_refresh_done when finished."""
    try:
        from_date, to_date = _resolve_dates(from_date, to_date)
        _ensure_permission()
        result = _run_apply(from_date, to_date)
        payload = {
            **result,
            "from_date": str(from_date),
            "to_date": str(to_date),
            "request_id": request_id,
        }
        frappe.publish_realtime(
            "taxable_summary_refresh_done",
            payload,
            user=frappe.session.user,
        )
        return result
    except Exception as error:
        frappe.publish_realtime(
            "taxable_summary_refresh_done",
            {
                "error": str(error),
                "from_date": str(from_date),
                "to_date": str(to_date),
                "request_id": request_id,
            },
            user=frappe.session.user,
        )
        raise
