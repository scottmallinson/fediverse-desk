import { afterEach, describe, expect, it } from "vitest";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { formatRequestLine, serve } from "../src/shim/server.js";

describe("request log line", () => {
  it("names the time, method, path, status and duration", () => {
    const line = formatRequestLine({
      at: new Date("2026-11-26T13:55:29.000Z"),
      method: "POST",
      path: "/api/v2/media",
      status: 500,
      durationMs: 42,
      error: "POST v1/upload/image failed: 413 File is too large",
    });
    expect(line).toBe(
      '2026-11-26T13:55:29.000Z POST /api/v2/media 500 42ms error="POST v1/upload/image failed: 413 File is too large"',
    );
  });

  it("keeps an error to one line and caps its length", () => {
    const line = formatRequestLine({
      at: new Date(0),
      method: "GET",
      path: "/x",
      status: 500,
      durationMs: 1,
      error: `two\nlines ${"x".repeat(1000)}`,
    });
    expect(line.split("\n")).toHaveLength(1);
    expect(line.length).toBeLessThan(400);
  });
});

describe("serve logging", () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) =>
      server ? server.close(() => resolve()) : resolve(),
    );
    server = undefined;
  });

  async function start(
    handle: (request: Request) => Promise<Response>,
  ): Promise<{ base: string; lines: string[] }> {
    const lines: string[] = [];
    server = serve({
      host: "127.0.0.1",
      port: 0,
      handle,
      log: (line) => lines.push(line),
    });
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    return { base: `http://127.0.0.1:${port}`, lines };
  }

  it("logs each request once, without its query string or headers", async () => {
    const { base, lines } = await start(
      async () => new Response("ok", { status: 200 }),
    );

    const response = await fetch(`${base}/oauth/authorize?state=secret-state`, {
      headers: { Authorization: "Bearer secret-token" },
    });
    expect(response.status).toBe(200);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/ GET \/oauth\/authorize 200 \d+ms$/);
    expect(lines[0]).not.toContain("secret");
  });

  it("logs the error a handler throws, with the status it was answered with", async () => {
    const { base, lines } = await start(async () => {
      throw new Error("POST v1/upload/image failed: 413 File is too large");
    });

    const response = await fetch(`${base}/api/v2/media`, {
      method: "POST",
      body: "x",
    });
    expect(response.status).toBe(500);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(" POST /api/v2/media 500 ");
    expect(lines[0]).toContain(
      'error="POST v1/upload/image failed: 413 File is too large"',
    );
  });
});
