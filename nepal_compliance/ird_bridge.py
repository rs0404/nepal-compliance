"""ERP side of the IRD Bridge browser extension.

The extension runs IRD's public PAN search (https://ird.gov.np/pan-search/) in
the user's own browser, because the page is protected by reCAPTCHA and cannot
be called from the server. It hands IRD's JSON answer back to the ERP page,
which posts it here to be parsed and cached as an "IRD PAN Lookup" record.
"""

import json
import re

import frappe
from frappe import _
from frappe.utils import cint, now_datetime

PAN_LOOKUP_DOCTYPE = "IRD PAN Lookup"
PAN_SEARCH_URL = "https://ird.gov.np/pan-search/"
MAX_RESPONSE_BYTES = 200_000
DATA_FIELD_LENGTH = 140

# Codes used by IRD's PAN search page.
ACCOUNT_TYPES = {
    "00": "VAT",
    "10": "Income Tax",
    "11": "WPAN",
    "20": "Excise",
    "30": "Personal PAN",
    "40": "Health Tax",
    "50": "Education Tax",
    "60": "DST",
    "61": "Non-Resident Airlines",
}
ACCOUNT_STATUSES = {"A": "Active", "C": "Closed", "D": "Deactivated"}
VAT_ACCOUNT_TYPE = "00"
PERSONAL_PAN_ACCOUNT_TYPE = "30"
ACTIVE_STATUS = "A"

# The PAN field of each party doctype.
PARTY_PAN_FIELDS = {
    "Customer": "customer_vat_number",
    "Supplier": "supplier_vat_number",
    "Company": "company_vat_number",
}


def clean_pan(pan):
    """Return the PAN as a 9-digit string, or None if it is not one."""
    value = re.sub(r"\s+", "", str(pan or ""))
    return value if re.fullmatch(r"\d{9}", value) else None


def normalize_pan(pan):
    """Return a 9-digit PAN string or raise."""
    value = clean_pan(pan)
    if not value:
        frappe.throw(_("PAN must be exactly 9 digits."), title=_("Invalid PAN"))
    return value


def _text(value, length=DATA_FIELD_LENGTH):
    if value is None:
        return ""
    text = re.sub(r"\s+", " ", str(value)).strip()
    if text in ("-", "null", "None"):
        return ""
    return text[:length]


def _first(rows):
    if isinstance(rows, list) and rows and isinstance(rows[0], dict):
        return rows[0]
    return {}


def _rows(rows):
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def is_not_found(response):
    """Mirror the IRD page's own "invalid information" check."""
    if not response or response == 0:
        return True
    if not isinstance(response, dict):
        return True
    if response.get("error") or response.get("code") == 0:
        return True
    data = response.get("data")
    return not isinstance(data, dict) or not _first(data.get("panDetails"))


def _pan_status(registrations):
    statuses = [row["status"] for row in registrations if row["status"]]
    suspended = [status for status in statuses if "suspend" in status.casefold()]
    if suspended:
        return ", ".join(dict.fromkeys(suspended))
    if any(row["status_code"] == ACTIVE_STATUS for row in registrations):
        return ACCOUNT_STATUSES[ACTIVE_STATUS]
    return ", ".join(dict.fromkeys(statuses))


def parse_pan_response(pan, response):
    """Turn IRD's PAN search JSON into a flat summary."""
    pan = normalize_pan(pan)
    if is_not_found(response):
        return frappe._dict(found=False, pan=pan)

    data = response["data"]
    detail = _first(data.get("panDetails"))
    returned_pan = _text(detail.get("pan"))
    if returned_pan and returned_pan != pan:
        frappe.throw(
            _("IRD returned PAN {0} for a search on PAN {1}. Please search again.").format(
                returned_pan, pan
            ),
            title=_("PAN Mismatch"),
        )

    registrations = []
    for row in _rows(data.get("panRegistrationDetail")):
        type_code = _text(row.get("acctType"))
        status_code = _text(row.get("accountStatus"))
        registrations.append(
            frappe._dict(
                account_type_code=type_code,
                account_type=ACCOUNT_TYPES.get(type_code, type_code),
                registration_date=_text(row.get("registrationDate")),
                filing_period=_text(row.get("filing_Period")),
                status_code=status_code,
                status=ACCOUNT_STATUSES.get(status_code, status_code),
            )
        )

    is_personal_pan = bool(registrations) and all(
        row.account_type_code == PERSONAL_PAN_ACCOUNT_TYPE for row in registrations
    )
    vat_registered = any(
        row.account_type_code == VAT_ACCOUNT_TYPE and row.status_code == ACTIVE_STATUS
        for row in registrations
    )

    clearance = {} if is_personal_pan else _first(data.get("panTaxClearance"))
    tax_clearance_status = ""
    if clearance:
        tax_clearance_status = "Cleared" if clearance.get("exists_Yn") == "Y" else "Pending"

    business_names = []
    for row in _rows(data.get("businessDetail")):
        name = _text(row.get("trade_Name_Eng")) or _text(row.get("trade_Name_Nep"))
        if name and name not in business_names:
            business_names.append(name)

    address = " ".join(
        part
        for part in (_text(detail.get("vdc_Town")), _text(detail.get("street_Name")))
        if part
    )

    return frappe._dict(
        found=True,
        pan=pan,
        trade_name_en=_text(detail.get("trade_Name_Eng")),
        trade_name_np=_text(detail.get("trade_Name_Nep")),
        address=address[:DATA_FIELD_LENGTH],
        ward_no=_text(detail.get("ward_No")),
        ird_office=_text(detail.get("office_Name")),
        effective_registration_date=_text(detail.get("eff_Reg_Date")),
        pan_status=_pan_status(registrations),
        vat_registered=vat_registered,
        is_personal_pan=is_personal_pan,
        registrations=registrations,
        business_names=business_names,
        tax_clearance_fiscal_year=_text(clearance.get("fiscal_Year")),
        return_verified_date=_text(clearance.get("return_Verified_Date")),
        tax_clearance_status=tax_clearance_status,
    )


def _load_response(response):
    if isinstance(response, (dict, list)) or response in (None, 0):
        return response
    text = str(response)
    if len(text.encode("utf-8")) > MAX_RESPONSE_BYTES:
        frappe.throw(_("The IRD response is too large to store."))
    try:
        return json.loads(text)
    except ValueError:
        frappe.throw(_("The IRD response is not valid JSON."))


def save_pan_lookup(summary, response):
    """Create or update the IRD PAN Lookup record for a found PAN."""
    if frappe.db.exists(PAN_LOOKUP_DOCTYPE, summary.pan):
        doc = frappe.get_doc(PAN_LOOKUP_DOCTYPE, summary.pan)
    else:
        doc = frappe.new_doc(PAN_LOOKUP_DOCTYPE)
        doc.pan = summary.pan

    doc.update(
        {
            "trade_name_en": summary.trade_name_en,
            "trade_name_np": summary.trade_name_np,
            "address": summary.address,
            "ward_no": summary.ward_no,
            "ird_office": summary.ird_office,
            "effective_registration_date": summary.effective_registration_date,
            "pan_status": summary.pan_status,
            "vat_registered": cint(summary.vat_registered),
            "is_personal_pan": cint(summary.is_personal_pan),
            "business_names": "\n".join(summary.business_names),
            "tax_clearance_fiscal_year": summary.tax_clearance_fiscal_year,
            "return_verified_date": summary.return_verified_date,
            "tax_clearance_status": summary.tax_clearance_status,
            "last_checked_on": now_datetime(),
            "last_checked_by": frappe.session.user,
            "raw_response": json.dumps(response, ensure_ascii=False, indent=1),
        }
    )
    doc.set(
        "registrations",
        [
            {
                "account_type": row.account_type,
                "account_type_code": row.account_type_code,
                "registration_date": row.registration_date,
                "filing_period": row.filing_period,
                "status": row.status,
            }
            for row in summary.registrations
        ],
    )
    if doc.is_new():
        doc.insert()
    else:
        doc.save()
    return doc


@frappe.whitelist(methods=["POST"])
def record_pan_lookup(pan, response):
    """Parse the extension's IRD answer and cache it.

    ``response`` is the JSON IRD's own page received from /api/getPanSearch/.
    It comes through the user's browser, so it is parsed defensively and is
    only ever stored as a lookup record, never applied to a party here.
    """
    frappe.has_permission(PAN_LOOKUP_DOCTYPE, "create", throw=True)
    response = _load_response(response)
    summary = parse_pan_response(pan, response)
    if summary.found:
        summary.lookup = save_pan_lookup(summary, response).name
    return summary


@frappe.whitelist()
def get_cached_pan_lookup(pan):
    """The cached IRD result for a PAN, or None if there is none or no access."""
    pan = clean_pan(pan)
    if not pan or not frappe.has_permission(PAN_LOOKUP_DOCTYPE, "read"):
        return None
    if not frappe.db.exists(PAN_LOOKUP_DOCTYPE, pan):
        return None
    return frappe.db.get_value(
        PAN_LOOKUP_DOCTYPE,
        pan,
        [
            "name",
            "pan",
            "trade_name_en",
            "trade_name_np",
            "pan_status",
            "vat_registered",
            "is_personal_pan",
            "last_checked_on",
        ],
        as_dict=True,
    )
