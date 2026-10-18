import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

const STATE_FILE = "ingest-state.json";
const USER_AGENT = "Zorgify-Ingest/1.0 (+https://github.com/raviguptacoder/sparityfy)";
const IGNORED = new Set(["node_modules", "scripts"]);
const CATEGORY_PATTERN = /^[a-z0-9_-]{1,32}$/;
const FILE_PATTERN = /^(\d+)\.gif$/i;

const MAX_REPO_BYTES = Number(process.env.MAX_REPO_MB ?? 3000) * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const NEKOS_BATCH = 10;
const NEKOS_ROUNDS = Number(process.env.NEKOS_ROUNDS ?? 3);
const WAIFU_ROUNDS = Number(process.env.WAIFU_ROUNDS ?? 8);
const USAGE_RATIO = Number(process.env.USAGE_RATIO ?? 0.5);
const LIMIT_PER_MIN = {
	nekos: Number(process.env.NEKOS_LIMIT_PER_MIN ?? 100),
	waifu: Number(process.env.WAIFU_LIMIT_PER_MIN ?? 60),
};
const GAP_MS = {
	nekos: Math.ceil(60_000 / (LIMIT_PER_MIN.nekos * USAGE_RATIO)),
	waifu: Math.ceil(60_000 / (LIMIT_PER_MIN.waifu * USAGE_RATIO)),
};
const deadline = Date.now() + Number(process.env.RUN_BUDGET_MIN ?? 50) * 60_000;
const outOfTime = () => Date.now() >= deadline;

const NEKOS_CATEGORIES = [
	"angry", "baka", "bite", "bleh", "blowkiss", "blush", "bonk", "bored", "carry", "clap",
	"confused", "cry", "cuddle", "dance", "facepalm", "feed", "handhold", "handshake", "happy",
	"highfive", "hug", "kabedon", "kick", "kiss", "lappillow", "laugh", "lurk", "nod", "nom",
	"nope", "nya", "pat", "peck", "poke", "pout", "punch", "run", "salute", "shake", "shocked",
	"shoot", "shrug", "sip", "slap", "sleep", "smile", "smug", "spin", "stare", "tableflip",
	"teehee", "think", "thumbsup", "tickle", "wag", "wave", "wink", "yawn", "yeet",
];
const WAIFU_CATEGORIES = ["awoo", "bully", "kill", "cringe"];

const only = new Set(
	(process.env.INGEST_ONLY ?? "")
		.split(",")
		.map((value) => value.trim().toLowerCase())
		.filter(Boolean),
);

class ProviderBlocked extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function shuffle(list) {
	const copy = [...list];
	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[copy[i], copy[j]] = [copy[j], copy[i]];
	}
	return copy;
}
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

function loadState() {
	const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
	return {
		sources: state.sources ?? {},
		anime: state.anime ?? {},
		hashes: state.hashes ?? {},
	};
}

function saveState(state) {
	const sortObject = (value) => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
	writeFileSync(
		STATE_FILE,
		`${JSON.stringify({ sources: sortObject(state.sources), anime: sortObject(state.anime), hashes: sortObject(state.hashes) })}\n`,
	);
}

function categoryDirs() {
	return readdirSync(process.cwd(), { withFileTypes: true })
		.filter(
			(dirent) =>
				dirent.isDirectory() &&
				!dirent.name.startsWith(".") &&
				!IGNORED.has(dirent.name) &&
				CATEGORY_PATTERN.test(dirent.name),
		)
		.map((dirent) => dirent.name);
}

function gifFiles(category) {
	return readdirSync(join(process.cwd(), category)).filter((name) => FILE_PATTERN.test(name));
}

function repoBytes() {
	let total = 0;
	for (const category of categoryDirs()) {
		for (const name of gifFiles(category)) total += statSync(join(category, name)).size;
	}
	return total;
}

function syncHashes(state) {
	const present = new Set();
	for (const category of categoryDirs()) {
		for (const name of gifFiles(category)) {
			const file = `${category}/${name}`;
			present.add(file);
			if (!state.hashes[file]) state.hashes[file] = sha256(readFileSync(file));
		}
	}
	for (const file of Object.keys(state.hashes)) {
		if (!present.has(file)) delete state.hashes[file];
	}
}

const nextIndex = new Map();

function allocateFile(category) {
	if (!nextIndex.has(category)) {
		const dir = join(process.cwd(), category);
		const highest = existsSync(dir)
			? Math.max(0, ...gifFiles(category).map((name) => Number.parseInt(name, 10)))
			: 0;
		nextIndex.set(category, highest);
	}
	const index = nextIndex.get(category) + 1;
	nextIndex.set(category, index);
	return `${category}/${index}.gif`;
}

const lastCall = { nekos: 0, waifu: 0 };

async function request(provider, url, { json }) {
	const wait = lastCall[provider] + GAP_MS[provider] - Date.now();
	if (wait > 0) await sleep(wait);
	lastCall[provider] = Date.now();

	const response = await fetch(url, {
		headers: { "User-Agent": USER_AGENT, Accept: json ? "application/json" : "image/gif,*/*" },
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});

	if (response.status === 403 || response.status === 429) {
		throw new ProviderBlocked(`${provider} returned HTTP ${response.status}`);
	}
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return response;
}

async function fetchBatch(provider, category) {
	if (provider === "nekos") {
		const response = await request("nekos", `https://nekos.best/api/v2/${category}?amount=${NEKOS_BATCH}`, { json: true });
		const body = await response.json();
		return (body.results ?? [])
			.filter((entry) => typeof entry.url === "string")
			.map((entry) => ({ url: entry.url, anime: entry.anime_name ?? null }));
	}

	const response = await request("waifu", `https://api.waifu.pics/sfw/${category}`, { json: true });
	const body = await response.json();
	return typeof body.url === "string" ? [{ url: body.url, anime: null }] : [];
}

async function download(provider, url) {
	const response = await request(provider, url, { json: false });
	const type = response.headers.get("content-type") ?? "";
	if (!type.includes("gif")) return null;

	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) return null;

	const buffer = Buffer.from(await response.arrayBuffer());
	if (buffer.length === 0 || buffer.length > MAX_FILE_BYTES) return null;
	return buffer;
}

const state = loadState();
syncHashes(state);

const fileByHash = new Map(Object.entries(state.hashes).map(([file, hash]) => [hash, file]));
let totalBytes = repoBytes();
let added = 0;
const blocked = new Set();

async function ingest(provider, category, rounds) {
	for (let round = 0; round < rounds; round++) {
		if (blocked.has(provider)) return;
		if (totalBytes >= MAX_REPO_BYTES || outOfTime()) return;

		let items;
		try {
			items = await fetchBatch(provider, category);
		} catch (error) {
			if (error instanceof ProviderBlocked) blocked.add(provider);
			console.warn(`${provider}/${category}: ${error.message}`);
			return;
		}

		let fresh = 0;

		for (const item of items) {
			if (state.sources[item.url]) continue;
			if (totalBytes >= MAX_REPO_BYTES) break;

			let buffer;
			try {
				buffer = await download(provider, item.url);
			} catch (error) {
				if (error instanceof ProviderBlocked) blocked.add(provider);
				console.warn(`${provider}/${category}: download failed (${error.message})`);
				if (blocked.has(provider)) return;
				continue;
			}

			if (!buffer) {
				state.sources[item.url] = "skipped";
				continue;
			}

			const hash = sha256(buffer);
			const existing = fileByHash.get(hash);
			if (existing) {
				state.sources[item.url] = existing;
				continue;
			}

			const file = allocateFile(category);
			mkdirSync(join(process.cwd(), category), { recursive: true });
			writeFileSync(file, buffer);

			state.sources[item.url] = file;
			state.hashes[file] = hash;
			if (item.anime) state.anime[file] = item.anime;
			fileByHash.set(hash, file);
			totalBytes += buffer.length;
			added += 1;
			fresh += 1;
		}

		if (fresh === 0) return;
	}
}

async function discoverNekos() {
	try {
		const response = await request("nekos", "https://nekos.best/api/v2/endpoints", { json: true });
		const body = await response.json();
		const found = Object.entries(body)
			.filter(([name, meta]) => meta?.format === "gif" && CATEGORY_PATTERN.test(name))
			.map(([name]) => name);
		return found.length > 0 ? found : NEKOS_CATEGORIES;
	} catch (error) {
		if (error instanceof ProviderBlocked) blocked.add("nekos");
		console.warn(`nekos category discovery failed: ${error.message}`);
		return NEKOS_CATEGORIES;
	}
}

const wanted = (category) => only.size === 0 || only.has(category);

const nekosCategories = await discoverNekos();

for (const category of shuffle(nekosCategories.filter(wanted))) await ingest("nekos", category, NEKOS_ROUNDS);
for (const category of shuffle(WAIFU_CATEGORIES.filter(wanted))) await ingest("waifu", category, WAIFU_ROUNDS);

saveState(state);

console.log(`added ${added} gifs, repo size ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
if (totalBytes >= MAX_REPO_BYTES) console.warn("repo size cap reached, ingest stopped");
if (outOfTime()) console.warn("run time budget reached, remaining categories next run");
if (blocked.size > 0) console.warn(`blocked providers: ${[...blocked].join(", ")}`);
