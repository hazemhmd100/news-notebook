import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
test("real PostgreSQL migration: atomic quota, RLS and grants deny browser bypass", async () => {
  const db = new PGlite();
  const owner = "00000000-0000-4000-8000-000000000001";
  try {
    await db.exec(
      "create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users(id uuid primary key);",
    );
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202610080001_notebook.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await db.query("insert into auth.users values ($1)", [owner]);
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, (_, i) =>
        db.query("select public.notebook_commit_success($1,$2) as result", [
          owner,
          i.toString(16).padStart(64, "0"),
        ]),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 20);
    let result = await db.query("select public.notebook_usage($1) as result", [
      owner,
    ]);
    assert.equal(result.rows[0].result.used, 20);
    await db.query("select public.notebook_commit_success($1,$2)", [
      owner,
      "0".repeat(64),
    ]);
    result = await db.query("select public.notebook_usage($1) as result", [
      owner,
    ]);
    assert.equal(result.rows[0].result.used, 20);
    await db.exec("set role authenticated");
    await assert.rejects(
      db.query("select public.notebook_commit_success($1,$2)", [
        owner,
        "f".repeat(64),
      ]),
      /permission denied/,
    );
    await assert.rejects(
      db.query("select * from public.notebook_archive"),
      /permission denied/,
    );
    await assert.rejects(
      db.query("update public.notebook_daily set used=0"),
      /permission denied/,
    );
    await db.exec("reset role");
    result = await db.query(
      "select count(*)::int as count from public.notebook_archive",
    );
    assert.equal(result.rows[0].count, 0);
    await db.query(
      "update public.notebook_daily set day=day-1 where user_id=$1",
      [owner],
    );
    result = await db.query("select public.notebook_usage($1) as result", [
      owner,
    ]);
    assert.equal(result.rows[0].result.used, 0);
  } finally {
    await db.close();
  }
});
