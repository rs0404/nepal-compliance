// Builds dist/chrome and dist/firefox from src/. No dependencies.
//   node build.mjs          build both
//   node build.mjs --zip    also write dist/ird-bridge-<browser>-<version>.zip
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, "src");
const dist = join(root, "dist");

export function manifestFor(browser, base) {
	const manifest = structuredClone(base);
	if (browser === "firefox") {
		// Firefox runs MV3 backgrounds as event pages, not service workers.
		manifest.background = { scripts: ["background.js"], type: "module" };
		delete manifest.minimum_chrome_version;
		manifest.browser_specific_settings = {
			gecko: {
				id: "ird-bridge@yarsalabs.com",
				// MAIN-world scripting.executeScript needs Firefox 128.
				strict_min_version: "128.0",
				data_collection_permissions: { required: ["none"] },
			},
		};
	}
	return manifest;
}

export function build({ zip = false } = {}) {
	const base = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8"));
	rmSync(dist, { recursive: true, force: true });
	for (const browser of ["chrome", "firefox"]) {
		const out = join(dist, browser);
		mkdirSync(out, { recursive: true });
		cpSync(src, out, { recursive: true });
		writeFileSync(join(out, "manifest.json"), JSON.stringify(manifestFor(browser, base), null, "\t") + "\n");
		if (zip) {
			const file = join(dist, `ird-bridge-${browser}-${base.version}.zip`);
			execFileSync("zip", ["-qr", file, "."], { cwd: out });
		}
	}
	return dist;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const out = build({ zip: process.argv.includes("--zip") });
	console.log(`Built ${out}${existsSync(out) ? "" : " (missing!)"}`);
}
