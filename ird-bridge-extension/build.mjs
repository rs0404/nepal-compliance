// Builds dist/chrome and dist/firefox from src/. No dependencies.
//   node build.mjs          build both
//   node build.mjs --zip    also write dist/ird-bridge-<browser>-<version>.zip
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, "src");
const dist = join(root, "dist");

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

function crc32(buffer) {
	let crc = 0xffffffff;
	for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function filesUnder(dir, prefix = "") {
	return readdirSync(dir, { withFileTypes: true })
		.sort((a, b) => (a.name < b.name ? -1 : 1))
		.flatMap((entry) =>
			entry.isDirectory()
				? filesUnder(join(dir, entry.name), `${prefix}${entry.name}/`)
				: [`${prefix}${entry.name}`]
		);
}

// A plain zip of a directory, so packaging needs no `zip` binary. Entries are
// sorted and carry a fixed date, so the same source gives the same file.
export function zipDirectory(dir, file) {
	const DOS_DATE = (1 << 5) | 1; // 1980-01-01
	const locals = [];
	const central = [];
	let offset = 0;
	for (const name of filesUnder(dir)) {
		const data = readFileSync(join(dir, name));
		const packed = deflateRawSync(data, { level: 9 });
		const nameBytes = Buffer.from(name, "utf8");

		const fields = Buffer.alloc(26);
		fields.writeUInt16LE(20, 0); // version needed
		fields.writeUInt16LE(0x0800, 2); // UTF-8 names
		fields.writeUInt16LE(8, 4); // deflate
		fields.writeUInt16LE(0, 6); // time
		fields.writeUInt16LE(DOS_DATE, 8);
		fields.writeUInt32LE(crc32(data), 10);
		fields.writeUInt32LE(packed.length, 14);
		fields.writeUInt32LE(data.length, 18);
		fields.writeUInt16LE(nameBytes.length, 22);
		fields.writeUInt16LE(0, 24); // extra length

		const localSig = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
		locals.push(localSig, fields, nameBytes, packed);

		const tail = Buffer.alloc(14);
		tail.writeUInt32LE(offset, 10); // comment, disk, attributes stay 0
		central.push(Buffer.from([0x50, 0x4b, 0x01, 0x02, 20, 0]), fields, tail, nameBytes);
		offset += localSig.length + fields.length + nameBytes.length + packed.length;
	}
	const directory = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(central.length / 4, 8);
	end.writeUInt16LE(central.length / 4, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	writeFileSync(file, Buffer.concat([...locals, directory, end]));
	return file;
}

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
			zipDirectory(out, join(dist, `ird-bridge-${browser}-${base.version}.zip`));
		}
	}
	return dist;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const out = build({ zip: process.argv.includes("--zip") });
	console.log(`Built ${out}${existsSync(out) ? "" : " (missing!)"}`);
}
