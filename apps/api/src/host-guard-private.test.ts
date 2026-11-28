import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerHostGuard } from "./host-guard.js";

/**
 * Real sockets (two listeners, as server.ts runs them), because the exemption keys on the socket's local port, which an injected
 * request does not have. Production shape: HUB_ALLOWED_HOSTS lists only the public hostname; the worker calls `<app>.internal`.
 */
const PREFIX = "/internal/worker/v1/";
let app: FastifyInstance; let internal: Server; let publicPort = 0; let privatePort = 0;

function get(port: number, path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const r = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers: { host } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    r.on("error", reject); r.end();
  });
}

beforeAll(async () => {
  internal = createServer();
  await new Promise<void>((r) => internal.listen(0, "127.0.0.1", () => r()));
  privatePort = (internal.address() as AddressInfo).port;
  app = Fastify();
  registerHostGuard(app, ["hub.example.com"], { port: privatePort, pathPrefix: PREFIX });
  app.get(`${PREFIX}ping`, async () => ({ ok: true }));
  app.get("/v1/research/overview", async () => ({ ok: true }));
  await app.listen({ host: "127.0.0.1", port: 0 });
  publicPort = (app.server.address() as AddressInfo).port;
  internal.on("request", (req, res) => app.server.emit("request", req, res)); // exactly how server.ts forwards the private listener
});
afterAll(async () => { internal.close(); await app.close(); });

describe("host guard: the private worker listener", () => {
  it("serves the worker API on the private port under the Fly private name (<app>.internal)", async () => {
    expect(await get(privatePort, `${PREFIX}ping`, "agentsmith-hub.internal:8081")).toBe(200);
  });
  it("does NOT exempt the same worker path on the public port (Host spoofing gets 421)", async () => {
    expect(await get(publicPort, `${PREFIX}ping`, "agentsmith-hub.internal")).toBe(421);
  });
  it("does NOT exempt any other path on the private port", async () => {
    expect(await get(privatePort, "/v1/research/overview", "agentsmith-hub.internal")).toBe(421);
    expect(await get(privatePort, "/internal/workerX/v1/ping", "agentsmith-hub.internal")).toBe(421);
  });
  it("keeps the public listener exactly as before", async () => {
    expect(await get(publicPort, "/v1/research/overview", "hub.example.com")).toBe(200);
    expect(await get(publicPort, "/v1/research/overview", "evil.example")).toBe(421);
  });
});
