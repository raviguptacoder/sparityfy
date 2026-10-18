import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const COLLECTION = "anime";
const NSFW_COLLECTION = "nsfw";
const NSFW_PREFIX = "nsfw_";
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
const nsfwCategories = {};

for (const dirent of readdirSync(process.cwd(), { withFileTypes: true })) {
	if (!dirent.isDirectory() || dirent.name.startsWith(".") || IGNORED.has(dirent.name)) continue;
	if (!CATEGORY_PATTERN.test(dirent.name)) continue;

	const files = readdirSync(join(process.cwd(), dirent.name))
		.filter((name) => FILE_PATTERN.test(name))
		.sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));

	if (files.length === 0) continue;

	const entries = files.map((name) => {
		const file = `${dirent.name}/${name}`;
		return { file, anime: anime[file] ?? null };
	});

	if (dirent.name.startsWith(NSFW_PREFIX)) {
		const short = dirent.name.slice(NSFW_PREFIX.length);
		if (short.length > 0) nsfwCategories[short] = entries;
	} else {
		categories[dirent.name] = entries;
	}
}

const sortCategories = (value) => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
const sorted = sortCategories(categories);
const nsfwSorted = sortCategories(nsfwCategories);
const collections = { [COLLECTION]: sorted };
if (Object.keys(nsfwSorted).length > 0) collections[NSFW_COLLECTION] = nsfwSorted;
const manifest = { version: 1, ref, collections };
const next = `${JSON.stringify(manifest)}\n`;

if (existsSync(MANIFEST_FILE) && readFileSync(MANIFEST_FILE, "utf8") === next) {
	console.log("manifest unchanged");
	process.exit(0);
}

writeFileSync(MANIFEST_FILE, next);

const countGifs = (value) => Object.values(value).reduce((sum, entries) => sum + entries.length, 0);
console.log(
	`manifest written: ${Object.keys(sorted).length} sfw categories (${countGifs(sorted)} gifs), ${Object.keys(nsfwSorted).length} nsfw categories (${countGifs(nsfwSorted)} gifs), ref ${ref ?? "none"}`,
);
