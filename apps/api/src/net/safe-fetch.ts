import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { Readable } from "node:stream";
import { assessHostname, canonicalAddress, classifyAddress, isLoopbackAddress } from "./ip-policy.js";

export type SsrfCode =
  | "scheme_blocked" | "credentials_blocked" | "port_blocked" | "host_blocked" | "destination_blocked"
  | "resolution_failed" | "peer_mismatch" | "too_many_redirects" | "redirect_blocked" | "connect_failed"
  | "connect_intercepted" | "unsupported_body";

export class SsrfError extends Error {
  override name = "SsrfError";
  constructor(readonly code: SsrfCode, message: string) { super(message); }
}

/** Returns every address a name resolves to. Injectable so tests control DNS (including rebinding). */
export type Resolver = (hostname: string) => Promise<string[]>;

export const systemResolver: Resolver = async (hostname) => {
  const answers = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return answers.map((a) => a.address);
};

export type SafeFetchOptions = {
  resolver?: Resolver;
  /** Default [443]. */
  allowedPorts?: number[];
  maxRedirects?: number;
  connectTimeoutMs?: number;
  /** Test-only. Permits http:// — refused in production. */
  allowInsecureHttp?: boolean;
  /** Test-only. Permits loopback destinations (still not private/link-local/metadata) — refused in production. */
  allowLoopbackForTests?: boolean;
  /** Test-only observation point called with each validated address just before connecting. */
  connectHook?: (address: string, port: number) => void;
  /** Test-only. Connect somewhere other than the validated address, to prove the peer check catches it. */
  connectOverrideForTests?: () => { host: string };
};

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const NULL_BODY = new Set([101, 204, 205, 304]);
const SENSITIVE_ON_CROSS_ORIGIN = ["authorization", "cookie", "proxy-authorization"];

function assertNotProduction(flag: string): void {
  if (process.env.NODE_ENV === "production") throw new Error(`${flag} is for tests and is refused in production`);
}

/**
 * A fetch-compatible client that connects only to addresses that passed the destination policy.
 *
 * Properties (each covered by tests):
 *  - the name is resolved ONCE here; every answer must be public (one bad answer rejects the name);
 *  - the TCP connection is made to the validated literal address, so a second DNS answer (rebinding) is never consulted;
 *  - after connecting, socket.remoteAddress must equal the validated address, before any request byte is written;
 *  - TLS verifies the certificate against the original hostname (SNI + identity), Host header is the original name;
 *  - redirects are followed manually and every hop goes through the same checks; credentials are dropped cross-origin.
 */
export function createSafeFetch(options: SafeFetchOptions = {}): (input: string | URL, init?: RequestInit) => Promise<Response> {
  if (options.allowLoopbackForTests) assertNotProduction("allowLoopbackForTests");
  if (options.allowInsecureHttp) assertNotProduction("allowInsecureHttp");
  if (options.connectOverrideForTests) assertNotProduction("connectOverrideForTests");
  const resolver = options.resolver ?? systemResolver;
  const allowedPorts = new Set(options.allowedPorts ?? [443]);
  const maxRedirects = options.maxRedirects ?? 5;
  const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;

  const permitted = (address: string): boolean => {
    const c = classifyAddress(address);
    return c.public || (!!options.allowLoopbackForTests && isLoopbackAddress(address));
  };

  /** Validates the URL and resolves its host to a list of addresses that are ALL permitted. */
  async function validate(url: URL): Promise<string[]> {
    if (url.protocol !== "https:" && !(url.protocol === "http:" && options.allowInsecureHttp)) {
      throw new SsrfError("scheme_blocked", `scheme ${url.protocol} is not allowed`);
    }
    if (url.username || url.password) throw new SsrfError("credentials_blocked", "URLs with credentials are not allowed");
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    if (!allowedPorts.has(port)) throw new SsrfError("port_blocked", `port ${port} is not allowed`);
    const host = assessHostname(url.hostname);
    if (!host.ok) throw new SsrfError("host_blocked", `host refused: ${host.reason}`);
    let answers: string[];
    try { answers = await resolver(host.hostname); } catch (e) {
      throw new SsrfError("resolution_failed", `could not resolve ${host.hostname}: ${(e as Error).message}`);
    }
    if (answers.length === 0) throw new SsrfError("resolution_failed", `no addresses for ${host.hostname}`);
    for (const a of answers) {
      if (!permitted(a)) throw new SsrfError("destination_blocked", `${host.hostname} resolves to a non-public address (${classifyAddress(a).reason})`);
    }
    return answers;
  }

  function connectOne(address: string, port: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const target = options.connectOverrideForTests ? options.connectOverrideForTests().host : address;
      const socket = net.connect({ host: target, port });
      const timer = setTimeout(() => { socket.destroy(); reject(new SsrfError("connect_failed", "connect timeout")); }, connectTimeoutMs);
      socket.once("error", (e) => { clearTimeout(timer); reject(new SsrfError("connect_failed", e.message)); });
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.removeAllListeners("error");
        const peer = socket.remoteAddress;
        if (!peer || canonicalAddress(peer) !== canonicalAddress(address)) {
          socket.destroy();
          reject(new SsrfError("peer_mismatch", "connected peer is not the validated address"));
          return;
        }
        resolve(socket);
      });
    });
  }

  async function connectPinned(addresses: string[], port: number, hostname: string, secure: boolean): Promise<net.Socket> {
    let lastError: Error | undefined;
    for (const address of addresses) {
      options.connectHook?.(address, port);
      try {
        const tcp = await connectOne(address, port);
        return secure ? tls.connect({ socket: tcp, servername: hostname, ALPNProtocols: ["http/1.1"] }) : tcp;
      } catch (e) {
        if (e instanceof SsrfError && e.code !== "connect_failed") throw e; // a policy failure is never retried against another address
        lastError = e as Error;
      }
    }
    throw lastError ?? new SsrfError("connect_failed", "no address could be connected");
  }

  function once(url: URL, addresses: string[], method: string, headers: Headers, body: Uint8Array | string | undefined, signal: AbortSignal | null | undefined): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
      const secure = url.protocol === "https:";
      const port = Number(url.port || (secure ? 443 : 80));
      const hostname = url.hostname.toLowerCase();
      const flat: Record<string, string> = {};
      headers.forEach((v, k) => { flat[k] = v; });
      if (!("user-agent" in flat)) flat["user-agent"] = "agentsmith-hub";
      const req = (secure ? https : http).request({
        hostname, port, method, path: `${url.pathname}${url.search}`, headers: flat, agent: undefined,
        createConnection: ((_o: unknown, cb: (err: Error | null, s?: net.Socket) => void) => {
          connectPinned(addresses, port, hostname, secure).then((s) => cb(null, s), (e) => cb(e as Error));
        }) as never,
      });
      const onAbort = () => req.destroy((signal!.reason as Error) ?? new DOMException("Aborted", "AbortError"));
      if (signal) { if (signal.aborted) { onAbort(); } else signal.addEventListener("abort", onAbort, { once: true }); }
      req.once("response", (res) => {
        if (signal) {
          const onBodyAbort = () => res.destroy((signal.reason as Error) ?? new DOMException("Aborted", "AbortError"));
          signal.addEventListener("abort", onBodyAbort, { once: true });
          res.once("close", () => { signal.removeEventListener("abort", onBodyAbort); signal.removeEventListener("abort", onAbort); });
        }
        resolve(res);
      });
      req.once("error", reject);
      req.end(body);
    });
  }

  function toResponse(res: http.IncomingMessage, finalUrl: string): Response {
    const headers = new Headers();
    for (let i = 0; i < res.rawHeaders.length; i += 2) headers.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
    const status = res.statusCode ?? 502;
    const response = new Response(NULL_BODY.has(status) ? null : (Readable.toWeb(res) as ReadableStream), { status, statusText: res.statusMessage ?? "", headers });
    Object.defineProperty(response, "url", { value: finalUrl });
    return response;
  }

  return async function safeFetch(input, init = {}) {
    let url = new URL(typeof input === "string" ? input : input.toString());
    let method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    let body: Uint8Array | string | undefined;
    if (init.body !== undefined && init.body !== null) {
      if (typeof init.body === "string" || init.body instanceof Uint8Array) body = init.body;
      else throw new SsrfError("unsupported_body", "only string and Uint8Array bodies are supported");
    }
    const mode = init.redirect ?? "follow";
    for (let hop = 0; ; hop++) {
      const addresses = await validate(url);
      const res = await once(url, addresses, method, headers, body, init.signal);
      const location = res.headers.location;
      if (!REDIRECTS.has(res.statusCode ?? 0) || !location || mode === "manual") return toResponse(res, url.toString());
      res.destroy();
      if (mode === "error") throw new SsrfError("redirect_blocked", "redirects are not allowed for this request");
      if (hop >= maxRedirects) throw new SsrfError("too_many_redirects", `more than ${maxRedirects} redirects`);
      let next: URL;
      try { next = new URL(location, url); } catch { throw new SsrfError("redirect_blocked", "redirect target is not a valid URL"); }
      if (next.origin !== url.origin) for (const h of SENSITIVE_ON_CROSS_ORIGIN) headers.delete(h);
      if (res.statusCode === 303 || ((res.statusCode === 301 || res.statusCode === 302) && method === "POST")) { method = "GET"; body = undefined; headers.delete("content-length"); headers.delete("content-type"); }
      url = next;
    }
  };
}
