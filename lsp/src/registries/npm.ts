import { VersionCache } from "../cache";
import { log } from "../log";
import type { PackageInfo, RegistryHandler } from "../types";
import { authHeaderFor, hostOf, registryFor, reloadNpmrc } from "./npmrc";

const cache = new VersionCache();

// Abbreviated metadata is much smaller than the full packument but still
// contains dist-tags; registries that don't support it fall back to JSON.
const PACKUMENT_ACCEPT =
	"application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*";

const DEP_SECTIONS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
] as const;

export const npmHandler: RegistryHandler = {
	matches(uri: string): boolean {
		return uri.endsWith("package.json");
	},

	extractPackages(text: string, lines: string[]): PackageInfo[] {
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(text);
		} catch {
			return [];
		}

		const packages: PackageInfo[] = [];

		for (const section of DEP_SECTIONS) {
			const deps = parsed[section] as Record<string, string> | undefined;
			if (!deps) continue;

			for (const [name, currentRange] of Object.entries(deps)) {
				const lineIndex = findPackageLine(lines, name);
				if (lineIndex === -1) continue;

				const currentVersion = String(currentRange).replace(/[\^~>=<]/g, "");
				packages.push({ name, currentVersion, lineIndex });
			}
		}

		return packages;
	},

	clearCache(): void {
		cache.clear();
		// Pick up edits to ~/.npmrc on save and on the periodic refresh.
		reloadNpmrc();
	},

	async fetchLatestVersion(name: string): Promise<string> {
		const cached = cache.get(name);
		if (cached) return cached;

		const registry = registryFor(name);
		try {
			// Scoped names are sent as "@scope%2fname", like the npm CLI does.
			// The full packument is used instead of "/latest" because many
			// private registries (Artifactory, GitHub Packages, …) lack that endpoint.
			const url = `${registry}${name.replace("/", "%2f")}`;
			const headers: Record<string, string> = { Accept: PACKUMENT_ACCEPT };
			const auth = authHeaderFor(url);
			if (auth) headers.Authorization = auth;

			const res = await fetch(url, { headers });
			if (!res.ok) {
				log(
					`npm fetch failed for ${name} (${hostOf(registry)}): ${res.status}`,
				);
				return "?";
			}
			const data = (await res.json()) as {
				"dist-tags"?: { latest?: string };
			};
			const latest = data["dist-tags"]?.latest;
			if (!latest) {
				log(`npm: no latest dist-tag for ${name} (${hostOf(registry)})`);
				return "?";
			}
			cache.set(name, latest);
			return latest;
		} catch (e) {
			log(`npm fetch error for ${name} (${hostOf(registry)}): ${e}`);
			return "?";
		}
	},
};

function findPackageLine(lines: string[], pkgName: string): number {
	const pattern = new RegExp(
		`"${pkgName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:`,
	);
	return lines.findIndex((line) => pattern.test(line));
}
