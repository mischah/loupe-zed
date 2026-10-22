import { readFileSync } from "node:fs";
import { Agent } from "node:https";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { rootCertificates } from "node:tls";
import { log } from "../log";

const DEFAULT_REGISTRY = "https://registry.npmjs.org/";

interface NpmrcConfig {
	registry: string;
	/** "@scope" → registry URL */
	scopes: Map<string, string>;
	/** Nerf-darted URL ("//host/path/") → key/value pairs such as _authToken */
	auth: Map<string, Map<string, string>>;
	/** Extra CA certificates (PEM) from `cafile`, `ca` and `ca[]` */
	ca: string[];
	strictSsl: boolean;
}

let config: NpmrcConfig | null = null;
let agent: Agent | null = null;

/** Re-reads ~/.npmrc on the next lookup. */
export function reloadNpmrc(): void {
	config = null;
	agent?.destroy();
	agent = null;
}

/**
 * Returns an HTTPS agent carrying the TLS settings from ~/.npmrc, or
 * undefined when none are configured. Custom CAs are added to Node's
 * bundled roots instead of replacing them, so npmjs.org keeps working
 * when `cafile` only contains a company CA.
 */
export function httpsAgent(): Agent | undefined {
	const { ca, strictSsl } = getConfig();
	if (ca.length === 0 && strictSsl) return undefined;

	if (!agent) {
		agent = new Agent({
			ca: [...rootCertificates, ...ca],
			rejectUnauthorized: strictSsl,
			keepAlive: true,
		});
	}
	return agent;
}

/** Returns the registry URL (with trailing slash) responsible for the given package. */
export function registryFor(name: string): string {
	const { registry, scopes } = getConfig();
	if (name.startsWith("@")) {
		const scope = name.slice(0, name.indexOf("/"));
		const scoped = scopes.get(scope);
		if (scoped) return scoped;
	}
	return registry;
}

/** Returns the Authorization header value for the given URL, if credentials are configured. */
export function authHeaderFor(url: string): string | undefined {
	const target = nerfDart(url);
	let best: Map<string, string> | undefined;
	let bestLength = -1;

	for (const [prefix, values] of getConfig().auth) {
		if (target.startsWith(prefix) && prefix.length > bestLength) {
			best = values;
			bestLength = prefix.length;
		}
	}
	if (!best) return undefined;

	const token = best.get("_authToken");
	if (token) return `Bearer ${token}`;

	const basic = best.get("_auth");
	if (basic) return `Basic ${basic}`;

	const username = best.get("username");
	const password = best.get("_password");
	if (username && password) {
		const decoded = Buffer.from(password, "base64").toString("utf8");
		return `Basic ${Buffer.from(`${username}:${decoded}`).toString("base64")}`;
	}

	return undefined;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getConfig(): NpmrcConfig {
	if (!config) config = loadConfig();
	return config;
}

function loadConfig(): NpmrcConfig {
	const result: NpmrcConfig = {
		registry: DEFAULT_REGISTRY,
		scopes: new Map(),
		auth: new Map(),
		ca: [],
		strictSsl: true,
	};

	const path = join(homedir(), ".npmrc");
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return result;
	}

	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#") || line.startsWith(";")) continue;

		const eq = line.indexOf("=");
		if (eq === -1) continue;

		const key = line.slice(0, eq).trim();
		const value = expandEnv(unquote(line.slice(eq + 1).trim()));

		if (key === "registry") {
			result.registry = withTrailingSlash(value);
		} else if (key.startsWith("@") && key.endsWith(":registry")) {
			result.scopes.set(
				key.slice(0, -":registry".length),
				withTrailingSlash(value),
			);
		} else if (key === "cafile") {
			const caPath = resolve(homedir(), value);
			try {
				result.ca.push(readFileSync(caPath, "utf8"));
			} catch (e) {
				log(`could not read cafile ${caPath}: ${e}`);
			}
		} else if (key === "ca" || key === "ca[]") {
			// Inline certificates are written with literal "\n" sequences.
			if (value && value !== "null")
				result.ca.push(value.replace(/\\n/g, "\n"));
		} else if (key === "strict-ssl") {
			result.strictSsl = value !== "false";
		} else if (key.startsWith("//")) {
			// Split at the last ":" so ports in the host ("//host:4873/:_authToken") stay intact.
			const sep = key.lastIndexOf(":");
			if (sep === -1) continue;
			const prefix = withTrailingSlash(key.slice(0, sep));
			const field = key.slice(sep + 1);
			if (!result.auth.has(prefix)) result.auth.set(prefix, new Map());
			result.auth.get(prefix)?.set(field, value);
		}
	}

	log(
		`loaded ${path}: registry=${hostOf(result.registry)}, scopes=${result.scopes.size}, auth entries=${result.auth.size}, extra CAs=${result.ca.length}, strict-ssl=${result.strictSsl}`,
	);
	return result;
}

/** Host part of a URL for logging — never includes credentials or paths. */
export function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return "<invalid url>";
	}
}

/** "https://host:4873/path" → "//host:4873/path/" */
function nerfDart(url: string): string {
	const parsed = new URL(url);
	return `//${parsed.host}${parsed.pathname}`;
}

function withTrailingSlash(url: string): string {
	return url.endsWith("/") ? url : `${url}/`;
}

function unquote(value: string): string {
	const match = value.match(/^(["'])(.*)\1$/);
	return match ? match[2] : value;
}

function expandEnv(value: string): string {
	return value.replace(
		/\$\{([^}]+)\}/g,
		(_, name: string) => process.env[name] ?? "",
	);
}
