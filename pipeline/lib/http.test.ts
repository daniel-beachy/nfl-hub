import { describe, expect, test } from "vitest";
import { createHttp, head, SourceError } from "./http.ts";

const URL_OK = "https://example.test/data";
const allowedHosts = new Set(["example.test"]);

function http(responses: Array<Response | Error | (() => Promise<Response>)>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const slept: number[] = [];
  const client = createHttp({
    allowedHosts,
    backoffMs: 10,
    sleep: async (ms) => void slept.push(ms),
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string> });
      const next = responses.shift();
      if (!next) throw new Error("no more responses");
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next() : next;
    }) as typeof fetch,
  });
  return { client, calls, slept };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const kindOf = async (p: Promise<unknown>) => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(SourceError);
  return (err as SourceError).kind;
};

describe("http helper", () => {
  test("returns JSON and sends gzip and a browser user agent", async () => {
    const { client, calls } = http([json({ a: 1 })]);
    expect(await client.getJson(URL_OK)).toEqual({ a: 1 });
    expect(calls[0]!.headers["accept-encoding"]).toBe("gzip");
    expect(calls[0]!.headers["user-agent"]).toMatch(/Mozilla/);
  });

  test("refuses hosts that are not on the allowlist", async () => {
    const { client, calls } = http([]);
    expect(await kindOf(client.getJson("https://evil.test/x"))).toBe("internal");
    expect(calls).toHaveLength(0);
  });

  test("retries network errors and 5xx with backoff, then succeeds", async () => {
    const { client, calls, slept } = http([new TypeError("fetch failed"), json({}, 503), json({ ok: true })]);
    expect(await client.getJson(URL_OK)).toEqual({ ok: true });
    expect(calls).toHaveLength(3);
    expect(slept).toEqual([10, 20]);
  });

  test("gives up after three attempts and reports the last failure", async () => {
    const { client, calls } = http([json({}, 500), json({}, 500), json({ e: 1 }, 502)]);
    const err = (await client.getJson(URL_OK).catch((e: unknown) => e)) as SourceError;
    expect([err.kind, err.httpStatus, calls.length]).toEqual(["http-error", 502, 3]);
    expect(err.toIssue().payloadHead).toBe('{"e":1}');
  });

  test("does not retry a 404", async () => {
    const { client, calls } = http([json({}, 404)]);
    expect(await kindOf(client.getJson(URL_OK))).toBe("http-error");
    expect(calls).toHaveLength(1);
  });

  test("retries a response the source declares empty", async () => {
    const isEmpty = (b: unknown) => Object.keys(b as object).length === 0;
    const first = http([json({}), json({ events: [1] })]);
    expect(await first.client.getJson(URL_OK, { isEmpty })).toEqual({ events: [1] });
    const never = http([json({}), json({}), json({})]);
    expect(await kindOf(never.client.getJson(URL_OK, { isEmpty }))).toBe("empty-response");
  });

  test("classifies non-JSON, oversized and slow responses", async () => {
    expect(await kindOf(http([new Response("<html>")]).client.getJson(URL_OK))).toBe("not-json");
    expect(await kindOf(http([json({ big: "x".repeat(500) })]).client.getJson(URL_OK, { maxBytes: 100 }))).toBe("too-large");
    const hang = () => new Promise<Response>(() => {});
    const slow = createHttp({
      allowedHosts, sleep: async () => {},
      fetch: ((_u: string, init: RequestInit) =>
        Promise.race([hang(), new Promise<Response>((_, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted"))))])) as typeof fetch,
    });
    expect(await kindOf(slow.getJson(URL_OK, { timeoutMs: 5, attempts: 2 }))).toBe("timeout");
  });

  test("bytes: returned as sent, with retries and the size cap", async () => {
    const { client, calls } = http([new Response("busy", { status: 503 }), new Response(new Uint8Array([0, 255, 7]))]);
    expect([...(await client.getBytes(URL_OK))]).toEqual([0, 255, 7]);
    expect(calls[1]!.headers.accept).toBe("application/octet-stream");
    expect(await kindOf(http([new Response(new Uint8Array(200))]).client.getBytes(URL_OK, { maxBytes: 100 }))).toBe("too-large");
    expect(await kindOf(http([]).client.getBytes("https://evil.test/x"))).toBe("internal");
  });

  test("head never exceeds 2 KB, even with multi-byte characters", () => {
    expect(Buffer.byteLength(head("é".repeat(5000)))).toBeLessThanOrEqual(2048);
    expect(head("short")).toBe("short");
  });

  test("a fired signal aborts the open request and makes no retry", async () => {
    const controller = new AbortController();
    let calls = 0;
    const client = createHttp({
      allowedHosts,
      sleep: async () => {},
      fetch: ((_url: string, init: RequestInit) => {
        calls++;
        return new Promise<Response>((_, reject) =>
          init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      }) as typeof fetch,
    });
    const pending = client.getJson(URL_OK, { signal: controller.signal, timeoutMs: 60_000 });
    controller.abort();
    const err = await pending.catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "timeout", message: expect.stringMatching(/deadline/) });
    expect(calls).toBe(1);
  });
});
