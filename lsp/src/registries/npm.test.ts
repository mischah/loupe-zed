import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import {
	cleanupTempDirs,
	createTestCa,
	hasOpenssl,
	packument,
	startServer,
	type TestCa,
	type TestServer,
	withNpmrc,
} from "../test-utils";
import { npmHandler } from "./npm";

describe("npmHandler.fetchLatestVersion", {
	skip: !hasOpenssl() && "openssl not available",
}, () => {
	let ca: TestCa;
	let httpsServer: TestServer;
	let httpServer: TestServer;

	before(async () => {
		ca = createTestCa();
		httpsServer = await startServer(packument("1.2.3"), {
			key: ca.serverKey,
			cert: ca.serverCert,
		});
		// Mirrors a Nexus behind http:// that redirects to its https:// endpoint.
		httpServer = await startServer((req, res) => {
			res.writeHead(301, { location: `${httpsServer.url}${req.url}` });
			res.end();
		});
	});

	beforeEach(() => {
		httpsServer.requests.length = 0;
		httpServer.requests.length = 0;
	});

	after(async () => {
		npmHandler.clearCache?.();
		await httpsServer.close();
		await httpServer.close();
		cleanupTempDirs();
	});

	/** Writes the .npmrc and clears the version cache so every test fetches. */
	function npmrc(...lines: string[]): void {
		withNpmrc(`${lines.join("\n")}\n`);
		npmHandler.clearCache?.();
	}

	describe("https registry with a custom CA", () => {
		it("fails verification without cafile", async () => {
			npmrc(`@test:registry=${httpsServer.url}/direct`);
			assert.equal(await npmHandler.fetchLatestVersion("@test/foo"), "?");
		});

		it("trusts the CA from cafile", async () => {
			npmrc(`@test:registry=${httpsServer.url}/direct`, `cafile=${ca.caFile}`);
			assert.equal(await npmHandler.fetchLatestVersion("@test/foo"), "1.2.3");
			assert.equal(httpsServer.requests[0].url, "/direct/@test%2ffoo");
		});

		it("trusts an inline ca", async () => {
			const inline = ca.caPem.trim().replaceAll("\n", "\\n");
			npmrc(`@test:registry=${httpsServer.url}/direct`, `ca="${inline}"`);
			assert.equal(await npmHandler.fetchLatestVersion("@test/foo"), "1.2.3");
		});

		it("skips verification with strict-ssl=false", async () => {
			npmrc(`@test:registry=${httpsServer.url}/direct`, "strict-ssl=false");
			assert.equal(await npmHandler.fetchLatestVersion("@test/foo"), "1.2.3");
		});
	});

	describe("http registry redirecting to https (Nexus setup)", () => {
		const registry = () => `registry=${httpServer.url}/repository/npm-all`;

		it("fails on the redirect target without cafile", async () => {
			npmrc(registry());
			assert.equal(await npmHandler.fetchLatestVersion("foo"), "?");
		});

		it("resolves scoped and unscoped packages with cafile", async () => {
			npmrc(registry(), `cafile=${ca.caFile}`);
			assert.equal(await npmHandler.fetchLatestVersion("foo"), "1.2.3");
			assert.equal(await npmHandler.fetchLatestVersion("@test/foo"), "1.2.3");
			assert.deepEqual(httpsServer.requests.map((r) => r.url).sort(), [
				"/repository/npm-all/@test%2ffoo",
				"/repository/npm-all/foo",
			]);
		});

		it("sends credentials only to the host they are configured for", async () => {
			const httpsHost = httpsServer.url.replace(/^https:/, "");
			npmrc(
				registry(),
				`cafile=${ca.caFile}`,
				`${httpsHost}/repository/npm-all/:_authToken=right`,
				"//other.example/:_authToken=wrong",
			);
			assert.equal(await npmHandler.fetchLatestVersion("foo"), "1.2.3");
			assert.equal(httpServer.requests[0].authorization, undefined);
			assert.equal(httpsServer.requests[0].authorization, "Bearer right");
		});
	});
});
