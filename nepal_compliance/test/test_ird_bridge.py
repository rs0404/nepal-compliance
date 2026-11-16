import json
import unittest
from contextlib import ExitStack
from unittest.mock import MagicMock, patch

import frappe

from nepal_compliance import ird_bridge


def throws_validation():
    """Make frappe.throw raise without needing a site (translations, cache)."""
    stack = ExitStack()
    stack.enter_context(patch.object(ird_bridge, "_", side_effect=lambda text: text))
    stack.enter_context(
        patch.object(ird_bridge.frappe, "throw", side_effect=frappe.ValidationError)
    )
    return stack


def ird_response(**overrides):
    """A response shaped like IRD's /api/getPanSearch/ answer."""
    data = {
        "panDetails": [
            {
                "pan": "123456789",
                "trade_Name_Eng": "  Sample   Traders Pvt. Ltd. ",
                "trade_Name_Nep": "स्याम्पल ट्रेडर्स",
                "vdc_Town": "Kathmandu",
                "street_Name": "Lazimpat",
                "ward_No": 2,
                "office_Name": "IRO Kathmandu",
                "eff_Reg_Date": "2075.04.01",
            }
        ],
        "panRegistrationDetail": [
            {"acctType": "10", "registrationDate": "2075.04.01", "filing_Period": "Y", "accountStatus": "A"},
            {"acctType": "00", "registrationDate": "2075.04.01", "filing_Period": "M", "accountStatus": "A"},
        ],
        "businessDetail": [
            {"trade_Name_Eng": "Sample Traders", "main_Business_Flag": "Y"},
            {"trade_Name_Eng": "Sample Traders", "main_Business_Flag": "N"},
        ],
        "panTaxClearance": [
            {"fiscal_Year": "2081/82", "return_Verified_Date": "2082.09.10", "exists_Yn": "Y"}
        ],
    }
    data.update(overrides)
    return {"data": data}


class TestPanNormalisation(unittest.TestCase):
    def test_accepts_nine_digits_with_spaces(self):
        self.assertEqual(ird_bridge.normalize_pan(" 123 456 789 "), "123456789")

    def test_rejects_wrong_length_or_letters(self):
        for value in ("12345678", "1234567890", "12345678A", "", None):
            with self.subTest(value=value), throws_validation():
                with self.assertRaises(frappe.ValidationError):
                    ird_bridge.normalize_pan(value)

    def test_clean_pan_returns_none_for_invalid(self):
        self.assertIsNone(ird_bridge.clean_pan("abc"))
        self.assertEqual(ird_bridge.clean_pan(123456789), "123456789")


class TestParsePanResponse(unittest.TestCase):
    def test_parses_a_vat_registered_company(self):
        summary = ird_bridge.parse_pan_response("123456789", ird_response())

        self.assertTrue(summary.found)
        self.assertEqual(summary.trade_name_en, "Sample Traders Pvt. Ltd.")
        self.assertEqual(summary.trade_name_np, "स्याम्पल ट्रेडर्स")
        self.assertEqual(summary.address, "Kathmandu Lazimpat")
        self.assertEqual(summary.ward_no, "2")
        self.assertEqual(summary.pan_status, "Active")
        self.assertTrue(summary.vat_registered)
        self.assertFalse(summary.is_personal_pan)
        self.assertEqual(
            [row.account_type for row in summary.registrations], ["Income Tax", "VAT"]
        )
        self.assertEqual(summary.business_names, ["Sample Traders"])
        self.assertEqual(summary.tax_clearance_status, "Cleared")
        self.assertEqual(summary.tax_clearance_fiscal_year, "2081/82")

    def test_closed_vat_account_is_not_vat_registered(self):
        response = ird_response(
            panRegistrationDetail=[
                {"acctType": "10", "accountStatus": "A"},
                {"acctType": "00", "accountStatus": "C"},
            ]
        )
        summary = ird_bridge.parse_pan_response("123456789", response)
        self.assertFalse(summary.vat_registered)
        self.assertEqual(summary.pan_status, "Active")

    def test_personal_pan_has_no_tax_clearance(self):
        response = ird_response(
            panRegistrationDetail=[{"acctType": "30", "accountStatus": "A"}]
        )
        summary = ird_bridge.parse_pan_response("123456789", response)
        self.assertTrue(summary.is_personal_pan)
        self.assertEqual(summary.tax_clearance_status, "")
        self.assertEqual(summary.tax_clearance_fiscal_year, "")

    def test_suspended_status_wins(self):
        response = ird_response(
            panRegistrationDetail=[
                {"acctType": "10", "accountStatus": "A"},
                {"acctType": "00", "accountStatus": "Suspended"},
            ]
        )
        summary = ird_bridge.parse_pan_response("123456789", response)
        self.assertEqual(summary.pan_status, "Suspended")

    def test_pending_tax_clearance(self):
        response = ird_response(panTaxClearance=[{"fiscal_Year": "2081/82", "exists_Yn": "N"}])
        summary = ird_bridge.parse_pan_response("123456789", response)
        self.assertEqual(summary.tax_clearance_status, "Pending")

    def test_not_found_responses(self):
        for response in (None, 0, {}, {"error": "x"}, {"code": 0}, {"data": {"panDetails": []}}, "x"):
            with self.subTest(response=response):
                summary = ird_bridge.parse_pan_response("123456789", response)
                self.assertFalse(summary.found)
                self.assertEqual(summary.pan, "123456789")

    def test_dash_and_null_values_become_blank(self):
        response = ird_response()
        response["data"]["panDetails"][0].update({"street_Name": None, "office_Name": "-"})
        summary = ird_bridge.parse_pan_response("123456789", response)
        self.assertEqual(summary.address, "Kathmandu")
        self.assertEqual(summary.ird_office, "")

    def test_different_pan_in_response_is_rejected(self):
        with throws_validation():
            with self.assertRaises(frappe.ValidationError):
                ird_bridge.parse_pan_response("987654321", ird_response())


class TestRecordPanLookup(unittest.TestCase):
    def setUp(self):
        frappe.local.session = frappe._dict(user="test@example.com")

    @patch.object(ird_bridge.frappe, "has_permission", return_value=True)
    @patch.object(ird_bridge, "save_pan_lookup")
    def test_found_pan_is_saved(self, save, _perm):
        save.return_value = MagicMock(name="doc")
        save.return_value.name = "123456789"

        summary = ird_bridge.record_pan_lookup("123456789", json.dumps(ird_response()))

        self.assertTrue(summary.found)
        self.assertEqual(summary.lookup, "123456789")
        saved_summary, saved_response = save.call_args.args
        self.assertEqual(saved_summary.pan, "123456789")
        self.assertEqual(saved_response, ird_response())

    @patch.object(ird_bridge.frappe, "has_permission", return_value=True)
    @patch.object(ird_bridge, "save_pan_lookup")
    def test_not_found_pan_is_not_saved(self, save, _perm):
        summary = ird_bridge.record_pan_lookup("123456789", json.dumps({"code": 0}))
        self.assertFalse(summary.found)
        save.assert_not_called()

    @patch.object(ird_bridge.frappe, "has_permission", return_value=True)
    def test_invalid_json_is_rejected(self, _perm):
        with throws_validation():
            with self.assertRaises(frappe.ValidationError):
                ird_bridge.record_pan_lookup("123456789", "{not json")

    @patch.object(ird_bridge.frappe, "has_permission", return_value=True)
    def test_oversized_response_is_rejected(self, _perm):
        big = json.dumps({"data": {"x": "a" * (ird_bridge.MAX_RESPONSE_BYTES + 1)}})
        with throws_validation():
            with self.assertRaises(frappe.ValidationError):
                ird_bridge.record_pan_lookup("123456789", big)

    def test_permission_is_checked_first(self):
        with patch.object(
            ird_bridge.frappe, "has_permission", side_effect=frappe.PermissionError
        ) as perm, patch.object(ird_bridge, "save_pan_lookup") as save:
            with self.assertRaises(frappe.PermissionError):
                ird_bridge.record_pan_lookup("123456789", json.dumps(ird_response()))
        perm.assert_called_once_with("IRD PAN Lookup", "create", throw=True)
        save.assert_not_called()


class TestSavePanLookup(unittest.TestCase):
    def setUp(self):
        frappe.local.session = frappe._dict(user="test@example.com")
        clock = patch.object(ird_bridge, "now_datetime", return_value="2026-11-17 10:00:00")
        clock.start()
        self.addCleanup(clock.stop)

    def _doc(self, is_new):
        doc = MagicMock()
        doc.is_new.return_value = is_new
        return doc

    @patch.object(ird_bridge.frappe, "db", new_callable=MagicMock)
    @patch.object(ird_bridge.frappe, "new_doc")
    def test_new_record_is_inserted(self, new_doc, db):
        db.exists.return_value = False
        doc = self._doc(is_new=True)
        new_doc.return_value = doc
        summary = ird_bridge.parse_pan_response("123456789", ird_response())

        ird_bridge.save_pan_lookup(summary, ird_response())

        self.assertEqual(doc.pan, "123456789")
        values = doc.update.call_args.args[0]
        self.assertEqual(values["trade_name_en"], "Sample Traders Pvt. Ltd.")
        self.assertEqual(values["vat_registered"], 1)
        self.assertEqual(values["last_checked_by"], "test@example.com")
        self.assertEqual(json.loads(values["raw_response"]), ird_response())
        fieldname, rows = doc.set.call_args.args
        self.assertEqual(fieldname, "registrations")
        self.assertEqual(rows[1]["account_type"], "VAT")
        doc.insert.assert_called_once()
        doc.save.assert_not_called()

    @patch.object(ird_bridge.frappe, "db", new_callable=MagicMock)
    @patch.object(ird_bridge.frappe, "get_doc")
    def test_existing_record_is_updated(self, get_doc, db):
        db.exists.return_value = True
        doc = self._doc(is_new=False)
        get_doc.return_value = doc
        summary = ird_bridge.parse_pan_response("123456789", ird_response())

        ird_bridge.save_pan_lookup(summary, ird_response())

        get_doc.assert_called_once_with("IRD PAN Lookup", "123456789")
        doc.save.assert_called_once()
        doc.insert.assert_not_called()


class TestCachedPanLookup(unittest.TestCase):
    @patch.object(ird_bridge.frappe, "has_permission", return_value=False)
    def test_no_read_permission_returns_none(self, _perm):
        self.assertIsNone(ird_bridge.get_cached_pan_lookup("123456789"))

    def test_invalid_pan_returns_none(self):
        self.assertIsNone(ird_bridge.get_cached_pan_lookup("12"))

    @patch.object(ird_bridge.frappe, "has_permission", return_value=True)
    @patch.object(ird_bridge.frappe, "db", new_callable=MagicMock)
    def test_missing_record_returns_none(self, db, _perm):
        db.exists.return_value = False
        self.assertIsNone(ird_bridge.get_cached_pan_lookup("123456789"))
