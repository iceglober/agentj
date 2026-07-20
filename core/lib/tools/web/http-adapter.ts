import { lookup } from "node:dns/promises";
import type { IncomingHttpHeaders, RequestOptions } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import TurndownService from "turndown";
import type { WebFetch, WebPage } from ".";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 2_000_000;
const DEFAULT_MAX_REDIRECTS = 5;

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface HttpWebFetchOptions {
  resolve?: HostResolver;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

const ipv4Parts = (address: string): number[] | undefined => {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  const numbers = parts.map(Number);
  return numbers.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? numbers
    : undefined;
};

/** Reject loopback, link-local, private, carrier-grade NAT, multicast, and reserved addresses. */
export const isPublicAddress = (address: string): boolean => {
  const v4 = ipv4Parts(address);
  if (v4) {
    const [a, b, c] = v4;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  const lower = address.toLowerCase();
  if (
    lower === "::" ||
    lower === "::1" ||
    lower.startsWith("::ffff:") ||
    /^fe[89ab][0-9a-f]:/u.test(lower) ||
    lower.startsWith("ff") ||
    /^f[cd][0-9a-f]{2}:/u.test(lower) ||
    lower.startsWith("64:ff9b:") ||
    lower.startsWith("100:") ||
    lower.startsWith("2001:2:") ||
    lower.startsWith("2001:db8:") ||
    lower.startsWith("2002:")
  )
    return false;
  return true;
};

const resolveHost: HostResolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map(({ address, family }) => ({
    address,
    family: family as 4 | 6,
  }));

const isIpLiteral = (hostname: string): boolean =>
  ipv4Parts(hostname) !== undefined || hostname.includes(":");

const publicAddressFor = async (url: URL, resolve: HostResolver): Promise<ResolvedAddress> => {
  const addresses = isIpLiteral(url.hostname)
    ? [{ address: url.hostname, family: url.hostname.includes(":") ? (6 as const) : (4 as const) }]
    : await resolve(url.hostname);
  const address = addresses.find(({ address }) => isPublicAddress(address));
  if (!address) throw new Error(`URL host resolves only to blocked addresses: ${url.hostname}`);
  return address;
};

interface HttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

const requestOnce = (
  url: URL,
  address: ResolvedAddress,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  maxBytes: number,
): Promise<HttpResponse> =>
  new Promise((resolve, reject) => {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const options: RequestOptions & { servername?: string } = {
      protocol: url.protocol,
      hostname: address.address,
      family: address.family,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: {
        host: url.host,
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
        "accept-encoding": "identity",
        "user-agent": "agentj/0.1 web_fetch",
      },
      servername: url.hostname,
      timeout: timeoutMs,
    };
    const req = request(options, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy(new Error(`response exceeds ${maxBytes} byte limit`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }),
      );
      response.on("error", reject);
    });
    const abort = () =>
      req.destroy(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    req.on("timeout", () => req.destroy(new Error(`request timed out after ${timeoutMs}ms`)));
    req.on("error", (error) => {
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    req.on("close", () => signal?.removeEventListener("abort", abort));
    req.end();
  });

const readableText = (body: Buffer, contentType: string): string => {
  const text = body.toString("utf8");
  if (/\b(?:text\/html|application\/xhtml\+xml)\b/iu.test(contentType)) {
    return new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" })
      .turndown(text)
      .trim();
  }
  return text.trim();
};

/** Direct, DNS-pinned public HTTP(S) fetcher used by web_fetch. */
export const createHttpWebFetch = (options: HttpWebFetchOptions = {}): WebFetch => {
  const resolve = options.resolve ?? resolveHost;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  return {
    async fetch(input, signal): Promise<WebPage> {
      let url: URL;
      try {
        url = new URL(input);
      } catch {
        throw new Error("invalid URL");
      }
      for (let redirects = 0; ; redirects += 1) {
        if (url.protocol !== "http:" && url.protocol !== "https:")
          throw new Error("only HTTP and HTTPS URLs are allowed");
        if (url.username || url.password) throw new Error("URLs with credentials are not allowed");
        const response = await requestOnce(
          url,
          await publicAddressFor(url, resolve),
          signal,
          timeoutMs,
          maxBytes,
        );
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.location;
          if (!location) throw new Error(`redirect (${response.status}) has no Location header`);
          if (redirects >= maxRedirects)
            throw new Error(`redirect limit (${maxRedirects}) exceeded`);
          url = new URL(location, url);
          continue;
        }
        if (response.status < 200 || response.status >= 300)
          throw new Error(`server returned HTTP ${response.status}`);
        const contentType = String(response.headers["content-type"] ?? "text/plain");
        return { url: url.toString(), contentType, text: readableText(response.body, contentType) };
      }
    },
  };
};
