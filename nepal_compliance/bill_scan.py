"""Turn a supplier bill into a draft Purchase Invoice without an AI service.

The browser reads the bill with Tesseract.js (or takes the text layer of a
digital PDF) and sends the text here. This module only parses that text:
it finds the supplier by PAN, name and the bills it has learned, proposes
bill number, date and amounts, and lets the user confirm them in a dialog.
Every confirmed bill is saved as a Bill Scan, so later bills from the same
supplier are recognised from what was learned.
"""

import io
import json
import math
import re
from collections import Counter

import frappe
from erpnext.controllers.accounts_controller import get_default_taxes_and_charges, get_taxes_and_charges
from frappe import _
from frappe.utils import add_days, cint, flt, getdate, nowdate

from nepal_compliance.nepali_date_utils.nepali_date import bs_to_ad

DEVANAGARI_DIGITS = str.maketrans("०१२३४५६७८९", "0123456789")
VAT_RATE = 0.13
INDEX_CACHE_KEY = "nepal_compliance:bill_scan_index"
MAX_TEXT_LENGTH = 20000

TOKEN_RE = re.compile(r"[a-zऀ-ॣ॰-ॿ]{3,}|\d{6,}")
AMOUNT_RE = re.compile(r"(?<![\d.,])(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(?!\d)")
DATE_RE = re.compile(
    r"(?<!\d)(?:(\d{4})\s?[-/.]\s?(\d{1,2})\s?[-/.]\s?(\d{1,2})|(\d{1,2})\s?[-/.]\s?(\d{1,2})\s?[-/.]\s?(\d{4}))(?!\d)"
)
BILL_NO_ANCHORS = (
    "invoice no", "invoice number", "inv no", "inv. no", "bill no", "bill number", "receipt no",
    "voucher no", "बिल नं", "बिल न", "बिजक नं", "बिजक न", "बिल नम्बर", "बीजक नं",
)
DATE_ANCHORS = ("date", "dated", "miti", "mitti", "मिति", "कारोबार मिति", "बिजक जारी मिति")
TOTAL_ANCHORS = (
    "grand total", "net total", "total amount", "net amount", "total", "जम्मा रकम", "कुल जम्मा", "जम्मा",
    "कुल रकम", "बाँकी",
)


def normalize_digits(text):
    """Devanagari digits to ASCII; everything else is kept."""
    return (text or "").translate(DEVANAGARI_DIGITS)


def find_pan_numbers(text):
    """9-digit numbers on the bill, also when printed one digit per box ("|6|1|0|...")."""
    text = normalize_digits(text)
    boxed = re.sub(r"(?<=\d)[ \t|।\[\]:]{1,3}(?=\d)", "", text)
    found = re.findall(r"(?<!\d)\d{9}(?!\d)", text) + re.findall(r"(?<!\d)\d{9}(?!\d)", boxed)
    return list(dict.fromkeys(found))


def tokenize(text):
    """Distinctive words and long numbers (phones, PAN) used to recognise a supplier's bill."""
    return set(TOKEN_RE.findall(normalize_digits(text).lower()))


def find_dates(text, today=None):
    """Plausible bill dates as AD dates, best first. BS years (2060-2100) are converted."""
    text = normalize_digits(text)
    today = getdate(today or nowdate())
    candidates = {}
    for match in DATE_RE.finditer(text):
        if match.group(1):
            readings = [tuple(int(match.group(i)) for i in (1, 2, 3))]
        else:
            first, second, year = (int(match.group(i)) for i in (4, 5, 6))
            # day first is the norm here, but billing software also prints month first
            readings = [(year, second, first), (year, first, second)]
        for rank, (year, month, day) in enumerate(readings):
            calendar = "BS" if 2060 <= year <= 2100 else "AD" if 2000 <= year < 2060 else None
            if not calendar:
                continue
            try:
                ad = bs_to_ad(year, month, day) if calendar == "BS" else getdate(f"{year}-{month:02d}-{day:02d}")
            except Exception:
                continue
            if not add_days(today, -400) <= ad <= add_days(today, 3):
                continue
            # the BS date is the bill's legal date when both are printed
            score = 1 + _anchor_bonus(text, match.start(), DATE_ANCHORS) + (1 if calendar == "BS" else 0) - rank * 0.5
            label = f"{year}-{month:02d}-{day:02d} {calendar}"
            key = str(ad)
            if key not in candidates or candidates[key]["score"] < score:
                candidates[key] = {"value": key, "label": label, "score": score}
    return sorted(candidates.values(), key=lambda c: (c["score"], c["value"]), reverse=True)


def find_amounts(text):
    """Amounts on the bill, with the taxable/VAT/total set that adds up when there is one."""
    text = DATE_RE.sub(" ", normalize_digits(text))
    values = []
    for match in AMOUNT_RE.finditer(text):
        raw = match.group(1)
        digits = raw.replace(",", "").split(".")[0]
        if len(digits) >= 8 and "," not in raw:  # PAN, phone or bill number, not money
            continue
        value = flt(raw.replace(",", ""))
        if value >= 1:
            values.append((value, match.start()))

    totals = Counter()
    for value, pos in values:
        bonus = _anchor_bonus(text, pos, TOTAL_ANCHORS)
        if bonus:
            totals[value] += bonus

    vat_set = None
    distinct = sorted({v for v, _pos in values}, reverse=True)
    for taxable in distinct:
        for vat in distinct:
            if vat >= taxable or abs(vat - taxable * VAT_RATE) > max(1, taxable * 0.002):
                continue
            total = flt(taxable + vat, 2)
            listed = next((t for t in distinct if abs(t - total) <= 1), None)
            candidate = {"taxable": taxable, "vat": vat, "total": listed or total, "total_on_bill": bool(listed)}
            if not vat_set or (candidate["total_on_bill"], taxable) > (vat_set["total_on_bill"], vat_set["taxable"]):
                vat_set = candidate
    if vat_set:
        totals[vat_set["total"]] += 3

    for value in distinct[:3]:
        totals[value] += 0.5
    ranked = [{"value": v, "score": s} for v, s in sorted(totals.items(), key=lambda i: (-i[1], -i[0]))[:5]]
    return {"totals": ranked, "vat_set": vat_set}


def find_bill_numbers(text, anchors=(), last_bill_nos=(), exclude=()):
    """Bill number candidates: values after a bill-number label, then numbers that follow the
    supplier's last bill numbers (pre-printed bill books count up)."""
    text = normalize_digits(text)
    lower = text.lower()
    candidates = {}

    def add(value, score):
        value = value.strip(" .:-/")
        if not value or not re.search(r"\d", value) or value in exclude or len(value) > 25:
            return
        candidates[value] = max(candidates.get(value, 0), score)

    for anchor, weight in [(a, 3) for a in anchors if a] + [(a, 2) for a in BILL_NO_ANCHORS]:
        for found in re.finditer(re.escape(anchor.lower()), lower):
            after = text[found.end(): found.end() + 30]
            value = re.match(r"[\s.:#-]*([A-Za-z0-9][A-Za-z0-9/-]{0,20})", after)
            if value:
                add(value.group(1), weight)

    last_numbers = [int(n) for n in (re.sub(r"\D", "", str(b))[-6:] for b in last_bill_nos) if n]
    if last_numbers:
        last = max(last_numbers)
        for number in re.findall(r"(?<![\d.,])\d{1,6}(?![\d.,])", text):
            if 0 < int(number) - last <= 300:
                add(number, 1.5 - (int(number) - last) / 1000)
    return [{"value": v, "score": s} for v, s in sorted(candidates.items(), key=lambda i: -i[1])[:5]]


def learn_anchors(text, confirmed):
    """The label printed before each confirmed value, so the next bill from this supplier
    can be read the same way."""
    text = normalize_digits(text)
    anchors = {}
    for field in ("bill_no",):
        value = str(confirmed.get(field) or "").strip()
        if not value:
            continue
        found = text.find(value)
        if found <= 0:
            continue
        before = re.findall(r"[^\s:.#|-]+", text[max(0, found - 30): found])
        if before:
            anchors[field] = " ".join(before[-2:])
    return anchors


def _anchor_bonus(text, pos, anchors):
    """2 when a label sits on the same line just before pos, else 0."""
    line_start = text.rfind("\n", 0, pos) + 1
    before = text[max(line_start, pos - 40): pos].lower()
    return 2 if any(anchor in before for anchor in anchors) else 0


def score_learned(index, tokens):
    """Similarity of a bill's tokens to each supplier's learned bills: share of the supplier's
    usual tokens (weighted by how rare they are across suppliers) that appear on this bill."""
    supplier_count = len(index)
    if not supplier_count:
        return {}
    document_frequency = Counter(t for profile in index.values() for t in profile["tokens"])
    scores = {}
    for supplier, profile in index.items():
        usual = profile["tokens"]
        weights = {t: math.log(1 + supplier_count / document_frequency[t]) for t in usual}
        possible = sum(weights.values())
        if possible:
            scores[supplier] = sum(w for t, w in weights.items() if t in tokens) / possible
    return scores


def build_index(scans, ignore_tokens=()):
    """Per supplier: the tokens seen on at least half of its learned bills."""
    grouped = {}
    for scan in scans:
        grouped.setdefault(scan["supplier"], []).append(tokenize(scan["ocr_text"]) - set(ignore_tokens))
    index = {}
    for supplier, token_sets in grouped.items():
        seen = Counter(t for tokens in token_sets for t in tokens)
        needed = max(1, len(token_sets) / 2)
        usual = [t for t, n in seen.items() if n >= needed]
        if usual:
            index[supplier] = {"tokens": usual, "bills": len(token_sets)}
    return index


def rank_suppliers(text, suppliers, index, own_pans=(), limit=4):
    """Supplier candidates with a 0-100 score and the reasons for it."""
    from rapidfuzz import fuzz

    pans = set(find_pan_numbers(text)) - set(own_pans)
    learned = score_learned(index, tokenize(text))
    lower = normalize_digits(text).lower()
    ranked = []
    for supplier in suppliers:
        score, reasons = 0.0, []
        tax_id = re.sub(r"\D", "", supplier.get("tax_id") or "")
        if tax_id and tax_id in pans:
            score += 70
            reasons.append(_("PAN {0} is on the bill").format(tax_id))
        elif tax_id and len(tax_id) == 9 and any(sum(a != b for a, b in zip(tax_id, p)) == 1 for p in pans):
            score += 35
            reasons.append(_("PAN {0} is on the bill with one digit misread").format(tax_id))
        name = (supplier.get("supplier_name") or "").lower()
        if len(name) >= 5:
            name_score = fuzz.partial_ratio(name, lower)
            if name_score >= 85:
                score += 25 * name_score / 100
                reasons.append(_("Name is on the bill"))
        profile = index.get(supplier["name"])
        if profile and learned.get(supplier["name"], 0) >= 0.3:
            score += 45 * learned[supplier["name"]]
            reasons.append(_("Looks like {0} earlier bill(s) from this supplier").format(profile["bills"]))
        if score:
            ranked.append({"supplier": supplier["name"], "supplier_name": supplier.get("supplier_name"),
                           "score": round(min(score, 100)), "reasons": reasons})
    ranked.sort(key=lambda c: -c["score"])
    return ranked[:limit]


def is_confident(candidates):
    """True when the best supplier is clearly ahead, so the dialog can preselect it."""
    if not candidates or candidates[0]["score"] < 60:
        return False
    return len(candidates) == 1 or candidates[0]["score"] - candidates[1]["score"] >= 25


# --- database side -------------------------------------------------------------------------


def _own_pans():
    pans = set()
    for company in frappe.get_all("Company", fields=["tax_id", "company_vat_number"]):
        pans.update(re.sub(r"\D", "", company.get(f) or "") for f in ("tax_id", "company_vat_number"))
    return {p for p in pans if p}


def _own_tokens():
    names = frappe.get_all("Company", pluck="company_name")
    return set().union(*(tokenize(n) for n in names)) if names else set()


def get_learned_index():
    index = frappe.cache.get_value(INDEX_CACHE_KEY)
    if index is None:
        scans = frappe.get_all(
            "Bill Scan", filters={"supplier": ["is", "set"]}, fields=["supplier", "ocr_text"],
            order_by="creation desc", limit_page_length=5000,
        )
        index = build_index(scans, _own_tokens())
        frappe.cache.set_value(INDEX_CACHE_KEY, index, expires_in_sec=6 * 3600)
    return index


def clear_learned_index(doc=None, method=None):
    frappe.cache.delete_value(INDEX_CACHE_KEY)


def _supplier_history(supplier, company=None):
    """The supplier's recent invoices in any company; only the tax template must match the company."""
    fields = ["name", "company", "bill_no", "taxes_and_charges"]
    if frappe.db.has_column("Purchase Invoice", "is_pan_or_abbreviated_bill"):
        fields.append("is_pan_or_abbreviated_bill")
    invoices = frappe.get_all(
        "Purchase Invoice", filters={"supplier": supplier, "docstatus": 1}, fields=fields,
        order_by="posting_date desc, creation desc", limit_page_length=20,
    )
    items = Counter()
    if invoices:
        for row in frappe.get_all(
            "Purchase Invoice Item", filters={"parent": ["in", [i.name for i in invoices]]},
            fields=["item_code"], limit_page_length=500,
        ):
            items[row.item_code] += 1
    pan_bills = sum(cint(i.get("is_pan_or_abbreviated_bill")) for i in invoices)
    return {
        "bill_nos": [i.bill_no for i in invoices if i.bill_no],
        "items": [code for code, _n in items.most_common(4)],
        "taxes_and_charges": next(
            (i.taxes_and_charges for i in invoices if i.taxes_and_charges and i.company == company), None
        ),
        "is_pan_bill": bool(invoices) and pan_bills * 2 > len(invoices),
        "invoice_count": len(invoices),
    }


def _supplier_anchors(supplier):
    anchors = []
    for raw in frappe.get_all(
        "Bill Scan", filters={"supplier": supplier, "anchors": ["is", "set"]}, pluck="anchors",
        order_by="creation desc", limit_page_length=10,
    ):
        value = (frappe.parse_json(raw) or {}).get("bill_no")
        if value and value not in anchors:
            anchors.append(value)
    return anchors


def _duplicates(supplier, bill_no):
    if not (supplier and bill_no):
        return []
    return frappe.get_all(
        "Purchase Invoice", filters={"supplier": supplier, "bill_no": bill_no, "docstatus": ["<", 2]}, pluck="name"
    )


def _check_access():
    frappe.has_permission("Purchase Invoice", "create", throw=True)


@frappe.whitelist()
def analyse_bill(text: str, company: str | None = None) -> dict:
    """Everything the review dialog needs from the bill's text."""
    _check_access()
    text = (text or "")[:MAX_TEXT_LENGTH]
    suppliers = frappe.get_all("Supplier", filters={"disabled": 0}, fields=["name", "supplier_name", "tax_id"])
    candidates = rank_suppliers(text, suppliers, get_learned_index(), _own_pans())
    amounts = find_amounts(text)
    result = {
        "suppliers": candidates,
        "supplier_confident": is_confident(candidates),
        "dates": find_dates(text)[:4],
        "totals": amounts["totals"],
        "vat_set": amounts["vat_set"],
    }
    if candidates:
        result["context"] = supplier_context(candidates[0]["supplier"], text, company)
    return result


@frappe.whitelist()
def supplier_context(supplier: str, text: str = "", company: str | None = None) -> dict:
    """What the supplier's earlier bills say about this one: bill number, items, taxes."""
    _check_access()
    frappe.has_permission("Supplier", "read", doc=supplier, throw=True)
    history = _supplier_history(supplier, company)
    pans = set(find_pan_numbers(text))
    bill_nos = find_bill_numbers(text, _supplier_anchors(supplier), history["bill_nos"], exclude=pans)
    history["bill_no_candidates"] = bill_nos
    history["duplicates"] = _duplicates(supplier, bill_nos[0]["value"]) if bill_nos else []
    return history


@frappe.whitelist()
def find_duplicate_bills(supplier: str, bill_no: str) -> list:
    _check_access()
    return _duplicates(supplier, bill_no)


@frappe.whitelist()
def extract_pdf_text(file_url: str) -> str:
    """Text layer of an uploaded PDF; empty for a scanned PDF, which the browser then reads."""
    from pypdf import PdfReader

    _check_access()
    file_doc = frappe.get_doc("File", {"file_url": file_url})
    file_doc.check_permission("read")
    try:
        reader = PdfReader(io.BytesIO(file_doc.get_content()))
        return "\n".join((page.extract_text() or "") for page in reader.pages[:2])[:MAX_TEXT_LENGTH]
    except Exception:
        return ""


@frappe.whitelist()
def create_purchase_invoice(data: str | dict) -> str:
    """Create the draft Purchase Invoice the user confirmed and learn from the bill."""
    _check_access()
    data = frappe._dict(frappe.parse_json(data))
    if not (data.supplier and data.item_code and flt(data.amount) > 0):
        frappe.throw(_("Supplier, item and amount are required."))
    if _duplicates(data.supplier, data.bill_no) and not cint(data.allow_duplicate):
        frappe.throw(_("A Purchase Invoice for bill {0} from this supplier already exists.").format(data.bill_no))

    pi = frappe.new_doc("Purchase Invoice")
    pi.company = data.company or frappe.defaults.get_user_default("Company")
    pi.supplier = data.supplier
    pi.bill_no = data.bill_no
    pi.bill_date = data.bill_date
    if pi.meta.has_field("is_pan_or_abbreviated_bill"):
        pi.is_pan_or_abbreviated_bill = cint(data.is_pan_bill)
    pi.append("items", {"item_code": data.item_code, "qty": 1, "rate": flt(data.amount)})
    pi.taxes_and_charges = data.taxes_and_charges or (
        get_default_taxes_and_charges("Purchase Taxes and Charges Template", company=pi.company) or {}
    ).get("taxes_and_charges")
    pi.set_missing_values()
    if pi.taxes_and_charges and not pi.get("taxes"):
        for tax in get_taxes_and_charges("Purchase Taxes and Charges Template", pi.taxes_and_charges):
            pi.append("taxes", tax)
    if data.file_url and pi.meta.has_field("attach_purchase_invoice"):
        # Frappe attaches the uploaded (still unattached) File to the invoice on save
        pi.attach_purchase_invoice = data.file_url
    pi.insert()

    scan = frappe.new_doc("Bill Scan")
    scan.update({
        "supplier": pi.supplier, "company": pi.company, "purchase_invoice": pi.name, "status": "Created",
        "source": data.source or "Photo", "bill_file": data.file_url, "bill_no": pi.bill_no,
        "bill_date": pi.bill_date, "grand_total": flt(data.total) or None,
        "ocr_text": (data.text or "")[:MAX_TEXT_LENGTH],
        "anchors": json.dumps(learn_anchors(data.text or "", {"bill_no": pi.bill_no})),
    })
    scan.insert()
    return pi.name


@frappe.whitelist()
def get_unlearned_bills(limit: int = 20) -> list:
    """Submitted Purchase Invoices with an attached bill that has not been learned yet."""
    frappe.has_permission("Bill Scan", "create", throw=True)
    learned = frappe.get_all("Bill Scan", filters={"purchase_invoice": ["is", "set"]}, pluck="purchase_invoice")
    files = frappe.get_all(
        "File",
        filters={"attached_to_doctype": "Purchase Invoice", "attached_to_name": ["not in", learned or [""]]},
        fields=["file_url", "attached_to_name"], order_by="creation desc", limit_page_length=cint(limit) * 3,
    )
    bills, seen = [], set()
    for f in files:
        if f.attached_to_name in seen or not re.search(r"\.(jpe?g|png|webp|pdf)$", f.file_url or "", re.I):
            continue
        pi = frappe.db.get_value("Purchase Invoice", f.attached_to_name, ["docstatus", "supplier"], as_dict=True)
        if not pi or pi.docstatus != 1 or not frappe.has_permission("Purchase Invoice", "read", doc=f.attached_to_name):
            continue
        seen.add(f.attached_to_name)
        bills.append({"purchase_invoice": f.attached_to_name, "supplier": pi.supplier, "file_url": f.file_url})
        if len(bills) >= cint(limit):
            break
    return bills


@frappe.whitelist()
def learn_from_invoice(purchase_invoice: str, text: str, source: str = "Photo") -> str | None:
    """Keep the text of an existing invoice's bill so its supplier is recognised next time."""
    frappe.has_permission("Bill Scan", "create", throw=True)
    pi = frappe.get_doc("Purchase Invoice", purchase_invoice)
    pi.check_permission("read")
    if len(tokenize(text)) < 3 or frappe.db.exists("Bill Scan", {"purchase_invoice": pi.name}):
        return None
    scan = frappe.new_doc("Bill Scan")
    scan.update({
        "supplier": pi.supplier, "company": pi.company, "purchase_invoice": pi.name, "status": "Learned",
        "source": source, "bill_no": pi.bill_no, "bill_date": pi.bill_date, "grand_total": pi.grand_total,
        "ocr_text": text[:MAX_TEXT_LENGTH],
        "anchors": json.dumps(learn_anchors(text, {"bill_no": pi.bill_no})),
    })
    scan.insert()
    return scan.name
