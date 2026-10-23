import test from "node:test";
import assert from "node:assert/strict";
import { readApiResponse } from "../public/api-response.js";

test("quota propagation immediately after midnight does not block another day", async () => {
  const now = Date.parse("2026-10-23T00:00:10Z");
  const response = new Response("Cloudflare Error 1027", { status: 429 });
  await assert.rejects(
    readApiResponse(response, now),
    (error) => error.retryAfterMs === 60_000,
  );
});

test("Cloudflare quota HTML becomes an actionable error until UTC midnight", async () => {
  const now = Date.parse("2026-10-22T23:10:00Z");
  const response = new Response(
    "<!doctype html><title>Cloudflare Error 1027</title>",
    { status: 429 },
  );
  await assert.rejects(readApiResponse(response, now), (error) => {
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterMs, 50 * 60_000);
    assert.match(error.message, /08:00/);
    assert.doesNotMatch(error.message, /doctype|Unexpected token/);
    return true;
  });
});

test("upstream HTML and malformed JSON do not leak a parser error", async () => {
  for (const status of [200, 403, 503]) {
    await assert.rejects(
      readApiResponse(
        new Response("<!doctype html>untrusted page", { status }),
      ),
      (error) => {
        assert.equal(error.status, status);
        assert.match(error.message, /非预期响应/);
        return true;
      },
    );
  }
});

test("JSON responses preserve application messages and retry timing", async () => {
  assert.deepEqual(await readApiResponse(new Response('{"ok":true}')), {
    ok: true,
  });
  await assert.rejects(
    readApiResponse(
      new Response('{"error":"账号或密码错误"}', { status: 401 }),
    ),
    /账号或密码错误/,
  );
  await assert.rejects(
    readApiResponse(
      new Response("temporary rate limit", {
        status: 429,
        headers: { "Retry-After": "120" },
      }),
    ),
    (error) => error.retryAfterMs === 120_000,
  );
});
