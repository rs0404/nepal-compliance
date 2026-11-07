import unittest

from frappe.utils import add_days

from nepal_compliance import bill_scan
from nepal_compliance.nepali_date_utils.nepali_date import bs_to_ad


class TestBillScanParsing(unittest.TestCase):
    def test_pan_printed_in_devanagari_boxes(self):
        text = "पान नं.:| ६|१|६|४|२|२|२|१|२।       मिति: 10/15\nVAT No. 123456789"

        self.assertEqual(bill_scan.find_pan_numbers(text), ["123456789", "616422212"])

    def test_bs_date_is_converted_and_labelled(self):
        bill_date = bs_to_ad(2083, 5, 19)
        text = "कारोबार मिति : 2083/05/19\nprinted 2079-01-01"

        dates = bill_scan.find_dates(text, today=add_days(bill_date, 5))

        self.assertEqual(dates[0]["value"], str(bill_date))
        self.assertEqual(dates[0]["label"], "2083-05-19 BS")
        self.assertEqual(len(dates), 1)  # the old date is outside the plausible range

    def test_bs_date_wins_over_a_month_first_english_date(self):
        bill_date = bs_to_ad(2083, 3, 23)
        text = "Address: Pokhara Mitti:2083.03.23\nPhone No: 9800000000 English Date:7/6/2026 11:30:48 AM"

        dates = bill_scan.find_dates(text, today=add_days(bill_date, 5))

        self.assertEqual(dates[0]["label"], "2083-03-23 BS")
        self.assertIn("2026-07-06", [d["value"] for d in dates])

    def test_vat_set_that_adds_up_is_found(self):
        text = "Qty 2 Rate 611\nTaxable Amount: 1,222.00\nVAT 13%: 158.86\nGrand Total 1,380.86\nPh 9856012345"

        amounts = bill_scan.find_amounts(text)

        self.assertEqual(amounts["vat_set"], {"taxable": 1222, "vat": 158.86, "total": 1380.86, "total_on_bill": True})
        self.assertEqual(amounts["totals"][0]["value"], 1380.86)
        self.assertNotIn(9856012345, [t["value"] for t in amounts["totals"]])

    def test_bill_number_after_its_label(self):
        text = "Invoice No.: KTM-82/83-21720   Mode: To Pay\nVAT No.: 612667541"

        candidates = bill_scan.find_bill_numbers(text, exclude={"612667541"})

        self.assertEqual(candidates[0]["value"], "KTM-82/83-21720")

    def test_bill_number_that_follows_the_last_bill_book_number(self):
        text = "बिजक नं. ....\n155\nजम्मा 1222"

        candidates = bill_scan.find_bill_numbers(text, last_bill_nos=["150", "148"])

        self.assertEqual(candidates[0]["value"], "155")

    def test_learned_label_reads_the_next_bill(self):
        anchors = bill_scan.learn_anchors("Cash Memo Ref# 4471\nTotal 500", {"bill_no": "4471"})

        candidates = bill_scan.find_bill_numbers("Cash Memo Ref# 4480\nTotal 900", anchors=[anchors["bill_no"]])

        self.assertEqual(anchors, {"bill_no": "Memo Ref"})
        self.assertEqual(candidates[0]["value"], "4480")


class TestSupplierMatching(unittest.TestCase):
    suppliers = [
        {"name": "SUP-A", "supplier_name": "Himal Hardware", "tax_id": "301234567"},
        {"name": "SUP-B", "supplier_name": "Fewa Vegetable Suppliers", "tax_id": "609876543"},
        {"name": "SUP-C", "supplier_name": "Lake Side Stationers", "tax_id": ""},
    ]

    def test_pan_on_the_bill_wins_and_own_pan_is_ignored(self):
        text = "बिक्रेताको करदाता दर्ता नं.: |३|०|१|२|३|४|५|६|७|\nक्रेताको करदाता दर्ता नं.: 610000001"

        ranked = bill_scan.rank_suppliers(text, self.suppliers, {}, own_pans={"610000001"})

        self.assertEqual(ranked[0]["supplier"], "SUP-A")
        self.assertFalse(bill_scan.is_confident(ranked))  # a PAN alone may be another party's

    def test_pan_and_name_together_are_confident(self):
        text = "HIMAL HARDWARE\nPAN: 301234567"

        ranked = bill_scan.rank_suppliers(text, self.suppliers, {})

        self.assertEqual(ranked[0]["supplier"], "SUP-A")
        self.assertTrue(bill_scan.is_confident(ranked))

    def test_supplier_without_pan_is_recognised_from_learned_bills(self):
        scans = [
            {"supplier": "SUP-C", "ocr_text": "लेक साइड स्टेसनर्स लेकसाइड पोखरा 9846000111 कपी कलम"},
            {"supplier": "SUP-C", "ocr_text": "लेक साइड स्टेसनर्स लेकसाइड पोखरा 9846000111 फाइल"},
            {"supplier": "SUP-B", "ocr_text": "फेवा तरकारी सप्लायर्स पोखरा 9806000222 काउली"},
        ]
        index = bill_scan.build_index(scans, ignore_tokens={"पोखरा"})
        text = "लेक साइड स्टेसनर्स\nलेकसाइड पोखरा  मो. ९८४६०००१११\nबिल नं. 77"

        ranked = bill_scan.rank_suppliers(text, self.suppliers, index)

        self.assertEqual(ranked[0]["supplier"], "SUP-C")
        self.assertNotIn("SUP-B", [c["supplier"] for c in ranked])

    def test_two_close_matches_are_not_confident(self):
        candidates = [{"supplier": "A", "score": 64}, {"supplier": "B", "score": 52}]

        self.assertFalse(bill_scan.is_confident(candidates))


if __name__ == "__main__":
    unittest.main()
