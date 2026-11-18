import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { build, manifestFor } from "../build.mjs";

// The offsets a zip's end record and directory give, enough to see that the
// package is a zip a browser store or `unzip` will open.
function zipEntries(file) {
	const zip = readFileSync(file);
	const end = zip.length - 22;
	assert.equal(zip.readUInt32LE(end), 0x06054b50, "end of central directory");
	const names = [];
	let at = zip.readUInt32LE(end + 16);
	for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
		assert.equal(zip.readUInt32LE(at), 0x02014b50, "central directory entry");
		const nameLength = zip.readUInt16LE(at + 28);
		names.push(zip.toString("utf8", at + 46, at + 46 + nameLength));
		assert.equal(zip.readUInt32LE(zip.readUInt32LE(at + 42)), 0x04034b50, "local header");
		at += 46 + nameLength;
	}
	return names;
}

const base = JSON.parse(readFileSync(new URL("../src/manifest.json", import.meta.url), "utf8"));

test("chrome manifest uses a module service worker", () => {
	const manifest = manifestFor("chrome", base);
	assert.deepEqual(manifest.background, { service_worker: "background.js", type: "module" });
	assert.equal(manifest.browser_specific_settings, undefined);
});

test("firefox manifest uses an event page and a gecko id", () => {
	const manifest = manifestFor("firefox", base);
	assert.deepEqual(manifest.background, { scripts: ["background.js"], type: "module" });
	assert.equal(manifest.minimum_chrome_version, undefined);
	assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, "128.0");
	assert.ok(manifest.browser_specific_settings.gecko.id);
});

test("manifestFor does not change the base manifest", () => {
	manifestFor("firefox", base);
	assert.deepEqual(base.background, { service_worker: "background.js", type: "module" });
});

test("only ird.gov.np is a required host; ERP sites are optional", () => {
	assert.deepEqual(base.host_permissions, ["https://ird.gov.np/*"]);
	assert.ok(base.optional_host_permissions.includes("https://*/*"));
});

test("build writes every file the manifest references, for both browsers", () => {
	const dist = build();
	for (const browser of ["chrome", "firefox"]) {
		const out = join(dist, browser);
		const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
		const files = [
			...(manifest.background.scripts || [manifest.background.service_worker]),
			manifest.action.default_popup,
			...Object.values(manifest.icons),
			...Object.values(manifest.action.default_icon),
			"erp_content.js",
			"popup.js",
			"popup.css",
			"shared/pan_search_page.js",
			"shared/pan_summary.js",
			"shared/protocol.js",
		];
		for (const file of files) {
			assert.ok(existsSync(join(out, file)), `${browser}: ${file}`);
		}
	}
});

test("package writes a zip per browser with the manifest at its root", () => {
	const dist = build({ zip: true });
	for (const browser of ["chrome", "firefox"]) {
		const names = zipEntries(join(dist, `ird-bridge-${browser}-${base.version}.zip`));
		for (const file of ["manifest.json", "background.js", "popup.html", "shared/pan_summary.js", "icons/icon-48.png"]) {
			assert.ok(names.includes(file), `${browser}: ${file}`);
		}
	}
});
