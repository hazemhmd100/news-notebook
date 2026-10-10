import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  safeURL,
  feedURL,
  fetchText,
  parseFeed,
  summarize,
  extractArticle,
  demoArticles,
  hash,
  discover,
  defaultSettings,
} from "../supabase/functions/_shared/core.js";
import { createHandler } from "../supabase/functions/_shared/handler.js";
import { localStore } from "../server/store.mjs";

const source = {
  id: "bbc",
  name: "BBC",
  url: "https://feeds.bbci.co.uk/arabic/rss.xml",
  section: "عام",
  enabled: true,
};
test("SSRF: only approved HTTPS hosts and ports, no credentials or private addresses", () => {
  for (const url of [
    "http://www.bbc.com/a",
    "https://localhost/a",
    "https://127.0.0.1",
    "https://[::1]",
    "https://www.bbc.com.evil.test/",
    "https://a:b@www.bbc.com/",
    "https://www.bbc.com:8443/",
    "https://demo.invalid/feed",
  ])
    assert.throws(() => safeURL(url));
  assert.equal(
    safeURL("https://www.bbc.com/arabic/articles/test?utm_source=one#x"),
    "https://www.bbc.com/arabic/articles/test",
  );
  assert.equal(
    feedURL("https://www.bbc.com/arabic"),
    "https://feeds.bbci.co.uk/arabic/rss.xml",
  );
});
test("redirect destinations are revalidated; oversized streams and nontext content refused", async () => {
  await assert.rejects(
    fetchText(source.url, {
      fetcher: async () =>
        new Response("", {
          status: 302,
          headers: { location: "http://127.0.0.1/private" },
        }),
    }),
  );
  await assert.rejects(
    fetchText(source.url, {
      maxBytes: 3,
      fetcher: async () =>
        new Response("1234", { headers: { "content-type": "text/html" } }),
    }),
  );
  await assert.rejects(
    fetchText(source.url, {
      fetcher: async () =>
        new Response("x", { headers: { "content-type": "image/png" } }),
    }),
  );
});
test("RSS/Atom metadata normalized, unsafe links and duplicates skipped", async () => {
  const items = await parseFeed(
    "<rss><channel><item><title><![CDATA[أخبار <b>اليوم</b>]]></title><link>https://www.bbc.com/arabic/articles/abc</link><pubDate>bad date</pubDate></item><item><title>repeat</title><link>https://www.bbc.com/arabic/articles/abc#one</link></item><item><title>unsafe</title><link>https://127.0.0.1</link></item></channel></rss>",
    source,
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "أخبار اليوم");
  assert.equal(items[0].publishedAt, null);
  const atom = await parseFeed(
    '<feed><entry><title>عالم المعرفة</title><link href="https://www.bbc.com/arabic/articles/xyz" rel="alternate"/></entry></feed>',
    source,
  );
  assert.equal(atom.length, 1);
  await assert.rejects(parseFeed("<!DOCTYPE x><rss/>", source));
});
test("summary contains 4–6 complete source sentences; short text fails", () => {
  const text = demoArticles[0].text;
  const summary = summarize(text);
  assert.ok(summary.length >= 4 && summary.length <= 6);
  for (const line of summary) assert.ok(text.includes(line));
  assert.throws(() => summarize("هذا نص قصير لا يكفي."));
  const html = `<html><head><title>المكتبة</title></head><body><nav>menu menu</nav><article><h1>المكتبة</h1>${text
    .split(".")
    .filter(Boolean)
    .map((s) => `<p>${s}.</p>`)
    .join("")}</article></body></html>`;
  const extracted = extractArticle(html, "https://www.bbc.com/a");
  assert.ok(extracted.includes("مكتبة"));
  assert.equal(summarize(extracted).length, 5);
});
test("discovery continues after a failed source and interleaves successful feeds", async () => {
  const result = await discover(
    [
      source,
      {
        id: "demo",
        name: "تجربة",
        url: "https://demo.invalid/feed",
        section: "عام",
      },
    ],
    5,
    "total",
    true,
    async () => new Response("", { status: 403 }),
  );
  assert.equal(result.errors.length, 1);
  assert.equal(result.articles.length, 2);
});
test("local persistence, concurrent cap, deduplication and UTC rollover", async () => {
  const dir = await mkdtemp(join(tmpdir(), "notebook-test-"));
  const path = join(dir, "state.json");
  let now = new Date("2026-10-08T23:59:00Z");
  try {
    const store = await localStore(path, { clock: () => now });
    const outcomes = await Promise.allSettled(
      Array.from({ length: 25 }, (_, i) =>
        store.commitSuccess("owner", String(i)),
      ),
    );
    assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 20);
    assert.equal((await store.usage()).used, 20);
    await store.commitSuccess("owner", "0");
    assert.equal((await store.usage()).used, 20);
    assert.equal(
      (await localStore(path, { clock: () => now })).usage instanceof Function,
      true,
    );
    const disk = JSON.parse(await readFile(path));
    assert.deepEqual(disk.archive, []);
    assert.equal(disk.success.length, 20);
    now = new Date("2026-10-09T00:00:00Z");
    assert.equal((await store.usage()).used, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("API: failed summaries do not count; only selected articles persist; origin/auth checked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "notebook-api-"));
  try {
    const store = await localStore(join(dir, "state.json"));
    const handle = createHandler({
      store,
      demo: true,
      authenticate: async () => "owner",
      allowedOrigins: ["http://localhost:5173"],
    });
    const call = async (path, method = "GET", data) => {
      const response = await handle(
        new Request(`http://local/api/${path}`, {
          method,
          headers: { "content-type": "application/json" },
          ...(data ? { body: JSON.stringify(data) } : {}),
        }),
      );
      return { status: response.status, data: await response.json() };
    };
    assert.equal((await call("state")).data.sources.length, 0);
    assert.equal(
      (await call("summarize", "POST", { article: {} })).status,
      400,
    );
    assert.equal((await store.usage()).used, 0);
    await call("settings", "PUT", {
      ...defaultSettings(),
      sources: [
        {
          id: "demo",
          name: "تجربة",
          url: "https://demo.invalid/feed",
          section: "عام",
        },
      ],
    });
    const found = (
      await call("discover", "POST", {
        sourceIds: ["demo"],
        limit: 5,
        countMode: "total",
      })
    ).data.articles;
    const a = (await call("summarize", "POST", { article: found[0] })).data
      .article;
    assert.equal((await store.usage()).used, 1);
    assert.equal((await store.archive()).length, 0);
    await call("summarize", "POST", { article: found[0] });
    assert.equal((await store.usage()).used, 1);
    await call("archive", "POST", { articles: [a] });
    assert.equal((await store.archive()).length, 1);
    await call("archive", "DELETE", { ids: [a.id] });
    assert.equal((await store.archive()).length, 0);
    const denied = await handle(
      new Request("http://local/api/state", {
        headers: { origin: "https://evil.example" },
      }),
    );
    assert.equal(denied.status, 403);
    const authHandle = createHandler({ store, authenticate: async () => null });
    assert.equal(
      (await authHandle(new Request("http://local/api/state"))).status,
      401,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
