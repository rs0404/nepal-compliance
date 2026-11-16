import assert from "node:assert/strict";
import { test } from "node:test";

import {
	bridgeError,
	contentScriptId,
	isValidPan,
	originMatchPattern,
	originOf,
} from "../src/shared/protocol.js";

test("isValidPan accepts exactly nine digits", () => {
	assert.equal(isValidPan("123456789"), true);
	for (const value of ["12345678", "1234567890", "12345678a", " 123456789", 123456789, null]) {
		assert.equal(isValidPan(value), false, String(value));
	}
});

test("originOf keeps http(s) origins only", () => {
	assert.equal(originOf("https://erp.example.com/app/customer/C-1?x=1"), "https://erp.example.com");
	assert.equal(originOf("http://site1.localhost:8000/app"), "http://site1.localhost:8000");
	assert.equal(originOf("chrome://extensions"), null);
	assert.equal(originOf("about:blank"), null);
	assert.equal(originOf("not a url"), null);
	assert.equal(originOf(undefined), null);
});

test("originMatchPattern drops the port, which match patterns cannot hold", () => {
	assert.equal(originMatchPattern("http://site1.localhost:8000"), "http://site1.localhost/*");
	assert.equal(originMatchPattern("https://erp.example.com"), "https://erp.example.com/*");
});

test("contentScriptId is stable per origin", () => {
	assert.equal(contentScriptId("https://erp.example.com"), "erp:https://erp.example.com");
});

test("bridgeError shape", () => {
	assert.deepEqual(bridgeError("timeout"), { ok: false, error: { code: "timeout", message: "" } });
});
