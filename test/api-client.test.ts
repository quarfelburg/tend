import { afterEach, expect, test } from "bun:test";
import { api } from "../src/app/api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("reports a plain-text API error without a JSON parser message", async () => {
  globalThis.fetch = (async () => new Response("404 Not Found", {
    status: 404,
    headers: { "content-type": "text/plain" },
  })) as typeof fetch;

  await expect(api("/missing")).rejects.toThrow("404 Not Found");
});

test("continues to return JSON responses", async () => {
  globalThis.fetch = (async () => Response.json({ ok: true })) as typeof fetch;

  await expect(api<{ ok: boolean }>("/working")).resolves.toEqual({ ok: true });
});
