import assert from "node:assert/strict";
import { test } from "node:test";

import { isNotFound, summarisePanResponse } from "../src/shared/pan_summary.js";

const found = (overrides = {}) => ({
	data: {
		panDetails: [
			{
				pan: "123456789",
				trade_Name_Eng: "Fixture Traders",
				trade_Name_Nep: "फिक्स्चर ट्रेडर्स",
				vdc_Town: "Kathmandu",
				street_Name: "New Road",
				office_Name: "IRO Kathmandu",
			},
		],
		panRegistrationDetail: [
			{ acctType: "10", accountStatus: "A", registrationDate: "2075.04.01" },
			{ acctType: "00", accountStatus: "A", registrationDate: "2076.01.15" },
		],
		...overrides,
	},
});

test("a missing, failed or empty answer is not found", () => {
	for (const response of [null, 0, "x", { error: "bad" }, { code: 0 }, { data: null }, { data: { panDetails: [] } }]) {
		assert.equal(isNotFound(response), true, JSON.stringify(response));
		assert.deepEqual(summarisePanResponse("123456789", response), { found: false, pan: "123456789" });
	}
});

test("a VAT registered business", () => {
	const summary = summarisePanResponse("123456789", found());
	assert.equal(summary.found, true);
	assert.equal(summary.nameEn, "Fixture Traders");
	assert.equal(summary.nameNp, "फिक्स्चर ट्रेडर्स");
	assert.equal(summary.address, "Kathmandu New Road");
	assert.equal(summary.office, "IRO Kathmandu");
	assert.equal(summary.status, "Active");
	assert.equal(summary.vatRegistered, true);
	assert.equal(summary.isPersonalPan, false);
	assert.deepEqual(
		summary.registrations.map((row) => [row.type, row.status, row.registrationDate]),
		[
			["Income Tax", "Active", "2075.04.01"],
			["VAT", "Active", "2076.01.15"],
		]
	);
});

test("a closed VAT account is not VAT registered", () => {
	const summary = summarisePanResponse(
		"123456789",
		found({
			panRegistrationDetail: [
				{ acctType: "10", accountStatus: "A" },
				{ acctType: "00", accountStatus: "C" },
			],
		})
	);
	assert.equal(summary.vatRegistered, false);
	assert.equal(summary.status, "Active");
});

test("a personal PAN", () => {
	const summary = summarisePanResponse("123456789", found({ panRegistrationDetail: [{ acctType: "30", accountStatus: "A" }] }));
	assert.equal(summary.isPersonalPan, true);
	assert.equal(summary.vatRegistered, false);
});

test("no active account and unknown codes", () => {
	const summary = summarisePanResponse(
		"123456789",
		found({
			panRegistrationDetail: [
				{ acctType: "10", accountStatus: "C" },
				{ acctType: "99", accountStatus: "Suspended by IRO" },
			],
		})
	);
	assert.equal(summary.status, "Suspended by IRO");
	assert.equal(summary.registrations[1].type, "99");
});
