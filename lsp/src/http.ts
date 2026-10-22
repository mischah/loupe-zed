import { request as httpRequest } from "node:http";
import { type Agent, request as httpsRequest } from "node:https";

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 15_000;

export interface GetJsonOptions {
	headers?: Record<string, string>;
	/** Resolves the Authorization header per URL, so credentials follow redirects only where configured. */
	authFor?: (url: string) => string | undefined;
	/** Agent for https:// requests, e.g. carrying custom CAs. */
	agent?: Agent;
}

export interface JsonResponse {
	status: number;
	body: unknown;
}

/**
 * GETs a URL and parses the body as JSON. Unlike the global fetch, this
 * accepts a custom HTTPS agent, which is needed for registries signed by
 * a company CA. Follows redirects, including http:// → https://.
 */
export async function getJson(
	url: string,
	options: GetJsonOptions = {},
): Promise<JsonResponse> {
	let current = url;

	for (let i = 0; i <= MAX_REDIRECTS; i++) {
		const res = await get(current, options);

		if (res.status >= 300 && res.status < 400 && res.location) {
			current = new URL(res.location, current).toString();
			continue;
		}

		if (res.status < 200 || res.status >= 300) {
			return { status: res.status, body: undefined };
		}
		return { status: res.status, body: JSON.parse(res.text) };
	}

	throw new Error(`too many redirects (${MAX_REDIRECTS})`);
}

interface RawResponse {
	status: number;
	location?: string;
	text: string;
}

function get(url: string, options: GetJsonOptions): Promise<RawResponse> {
	const target = new URL(url);
	const headers = { ...options.headers };
	const auth = options.authFor?.(url);
	if (auth) headers.Authorization = auth;

	const isHttps = target.protocol === "https:";
	const send = isHttps ? httpsRequest : httpRequest;
	if (!isHttps && target.protocol !== "http:") {
		return Promise.reject(new Error(`unsupported protocol ${target.protocol}`));
	}

	return new Promise((resolve, reject) => {
		const req = send(
			target,
			{ headers, agent: isHttps ? options.agent : undefined },
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () =>
					resolve({
						status: res.statusCode ?? 0,
						location: res.headers.location,
						text: Buffer.concat(chunks).toString("utf8"),
					}),
				);
				res.on("error", reject);
			},
		);
		req.setTimeout(TIMEOUT_MS, () => {
			req.destroy(new Error(`timeout after ${TIMEOUT_MS} ms`));
		});
		// Name the host that failed, which differs from the registry after a redirect.
		req.on("error", (e) => reject(new Error(`${target.host}: ${e.message}`)));
		req.end();
	});
}
