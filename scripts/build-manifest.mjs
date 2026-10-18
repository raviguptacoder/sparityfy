import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const COLLECTION = "anime";
const MANIFEST_FILE = "manifest.json";
const STATE_FILE = "ingest-state.json";
const IGNORED = new Set(["node_modules", "scripts"]);
const CATEGORY_PATTERN = /^[a-z0-9_-]{1,32}$/;
const FILE_PATTERN = /^(\d+)\.gif$/i;

function readJson(path) {
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

const refFlag = process.argv.indexOf("--ref");
const refArgument = refFlag >= 0 ? process.argv[refFlag + 1] : null;

if (refArgument !== null && !/^[0-9a-f]{40}$/.test(refArgument ?? "")) {
	console.error("--ref must be a full 40 character commit sha");
	process.exit(1);
}

const previous = readJson(MANIFEST_FILE);
const state = readJson(STATE_FILE);
const anime = state?.anime ?? {};
const ref = refArgument ?? previous?.ref ?? null;

const categories = {};

for (const dirent of readdirSync(process.cwd(), { withFileTypes: true })) {
	if (!dirent.isDirectory() || dirent.name.startsWith(".") || IGNORED.has(dirent.name)) continue;
	if (!CATEGORY_PATTERN.test(dirent.name)) continue;

	const files = readdirSync(join(process.cwd(), dirent.name))
		.filter((name) => FILE_PATTERN.test(name))
		.sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));

	if (files.length === 0) continue;

	categories[dirent.name] = files.map((name) => {
		const file = `${dirent.name}/${name}`;
		return { file, anime: anime[file] ?? null };
	});
}

const sorted = Object.fromEntries(Object.entries(categories).sort(([a], [b]) => a.localeCompare(b)));
const manifest = { version: 1, ref, collections: { [COLLECTION]: sorted } };
const next = `${JSON.stringify(manifest)}\n`;

if (existsSync(MANIFEST_FILE) && readFileSync(MANIFEST_FILE, "utf8") === next) {
	console.log("manifest unchanged");
	process.exit(0);
}

writeFileSync(MANIFEST_FILE, next);

const total = Object.values(sorted).reduce((sum, entries) => sum + entries.length, 0);
console.log(`manifest written: ${Object.keys(sorted).length} categories, ${total} gifs, ref ${ref ?? "none"}`);
