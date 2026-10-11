import {
  AppError,
  defaultSettings,
  validateSettings,
  validateArchive,
  discover,
  buildSummary,
  usageFor,
} from "./core.js";

// All production stores are scoped to a server-verified owner UUID.
export function createHandler({
  store,
  authenticate,
  demo = false,
  allowedOrigins = /** @type {string[]} */ ([]),
  fetcher = fetch,
}) {
  return async function handle(request) {
    const origin = request.headers.get("origin");
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      Vary: "Origin",
    };
    if (origin && allowedOrigins.includes(origin))
      headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Headers"] =
      "authorization, apikey, content-type, x-client-info";
    headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS";
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers });
    try {
      if (origin && !allowedOrigins.includes(origin))
        throw new AppError(
          "هذا الموقع غير مصرح له بالاتصال.",
          403,
          "ORIGIN_DENIED",
        );
      if (request.method === "OPTIONS")
        return new Response(null, { status: 204, headers });
      const path = new URL(request.url).pathname
        .split("/")
        .filter(Boolean)
        .pop();
      if (path === "health" && request.method === "GET")
        return json({
          ok: true,
          mode: demo ? "demo" : "cloud",
          paidAPIs: false,
        });
      const user = await authenticate(request);
      if (!user) throw new AppError("يرجى تسجيل الدخول.", 401, "AUTH_REQUIRED");
      let input = {};
      if (["POST", "PUT", "DELETE"].includes(request.method)) {
        if (!request.headers.get("content-type")?.includes("application/json"))
          throw new AppError("مطلوب محتوى JSON.", 415);
        const reader = request.body?.getReader();
        let size = 0;
        const chunks = [];
        if (reader)
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 180000) {
              await reader.cancel();
              throw new AppError("حجم الطلب كبير جداً.", 413);
            }
            chunks.push(value);
          }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        try {
          input = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          throw new AppError("بيانات غير صالحة.");
        }
        if (!input || typeof input !== "object" || Array.isArray(input))
          throw new AppError("بيانات غير صالحة.");
      }
      if (path === "state" && request.method === "GET") {
        const [settings, archive, usage] = await Promise.all([
          store.settings(user),
          store.archive(user),
          store.usage(user),
        ]);
        return json({
          ...settings,
          archive,
          usage,
          mode: demo ? "demo" : "cloud",
        });
      }
      if (path === "settings" && request.method === "PUT") {
        const settings = validateSettings(input, demo);
        await store.saveSettings(user, settings);
        return json(settings);
      }
      if (path === "discover" && request.method === "POST") {
        if (
          !Array.isArray(input.sourceIds) ||
          input.sourceIds.length < 1 ||
          input.sourceIds.length > 1
        )
          throw new AppError("اختر موقعاً واحداً في كل مرة.");
        if (
          !Number.isInteger(input.limit) ||
          input.limit < 1 ||
          input.limit > 20 ||
          !["total", "per-source"].includes(input.countMode)
        )
          throw new AppError("العدد يجب أن يكون بين 1 و20.");
        const settings = await store.settings(user);
        const sources = settings.sources.filter(
          (s) => input.sourceIds.includes(s.id) && s.enabled,
        );
        if (!sources.length)
          throw new AppError("لا يوجد مصدر مفعّل ضمن اختيارك.");
        return json(
          await discover(sources, input.limit, input.countMode, demo, fetcher, input.period === '24h' ? '24h' : 'latest'),
        );
      }
      if (path === "summarize" && request.method === "POST") {
        if ((await store.usage(user)).remaining < 1)
          throw new AppError(
            "وصلت إلى حد 20 ملخصاً ناجحاً اليوم. يتجدد الحد عند منتصف الليل UTC.",
            429,
            "DAILY_LIMIT",
          );
        const settings = await store.settings(user);
        const article = await buildSummary(
          input.article,
          settings.sources,
          demo,
          fetcher,
        );
        // Commit AFTER successful extraction and summarization. Atomic DB operation
        // admits at most 20 distinct successes even with concurrent tabs/devices.
        const usage = await store.commitSuccess(user, article.id);
        return json({ article, usage });
      }
      if (path === "archive" && request.method === "POST") {
        const articles = await validateArchive(input.articles, demo);
        await store.saveArchive(user, articles);
        return json({ archive: await store.archive(user) });
      }
      if (path === "archive" && request.method === "DELETE") {
        if (
          !Array.isArray(input.ids) ||
          input.ids.length > 1000 ||
          input.ids.some(
            (id) => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id),
          )
        )
          throw new AppError("اختيار غير صالح.");
        await store.deleteArchive(user, input.ids);
        return json({ archive: await store.archive(user) });
      }
      throw new AppError("المسار غير موجود.", 404, "NOT_FOUND");
    } catch (error) {
      return json(
        {
          error:
            error instanceof AppError
              ? error.message
              : "تعذر إتمام العملية. تحقق من إعداد الخدمة ثم أعد المحاولة.",
          code: error.code || "SERVICE_ERROR",
        },
        error instanceof AppError ? Number(error.status) : 503,
      );
    }
  };
}

export function cloudStore(url, key, fetcher = fetch) {
  async function db(path, options = {}) {
    const r = await fetcher(`${url}/rest/v1/${path}`, {
      ...options,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        ...options.headers,
      },
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      if (body.message?.includes("DAILY_LIMIT"))
        throw new AppError(
          "وصلت إلى الحد اليومي: 20 ملخصاً ناجحاً.",
          429,
          "DAILY_LIMIT",
        );
      throw new AppError(
        "تعذر الوصول لقاعدة البيانات. تحقق من إعدادها.",
        503,
        "DATABASE_ERROR",
      );
    }
    return r.status === 204 ? null : r.json();
  }
  return {
    async settings(user) {
      const rows = await db(`notebook_settings?user_id=eq.${user}&select=data`);
      return rows[0]?.data || defaultSettings();
    },
    async saveSettings(user, data) {
      await db("notebook_settings?on_conflict=user_id", {
        method: "POST",
        headers: {
          Prefer: "resolution=merge-duplicates,return=representation",
        },
        body: JSON.stringify({ user_id: user, data }),
      });
    },
    async archive(user) {
      const rows = await db(
        `notebook_archive?user_id=eq.${user}&select=data&order=created_at.desc&limit=1000`,
      );
      return rows.map((row) => row.data);
    },
    async saveArchive(user, articles) {
      await db("notebook_archive?on_conflict=user_id,id", {
        method: "POST",
        headers: {
          Prefer: "resolution=merge-duplicates,return=representation",
        },
        body: JSON.stringify(
          articles.map((a) => ({ user_id: user, id: a.id, data: a })),
        ),
      });
    },
    async deleteArchive(user, ids) {
      if (ids.length)
        await db(
          `notebook_archive?user_id=eq.${user}&id=in.(${ids.join(",")})`,
          { method: "DELETE" },
        );
    },
    async usage(user) {
      const value = await db("rpc/notebook_usage", {
        method: "POST",
        body: JSON.stringify({ p_user: user }),
      });
      return usageFor(value.used, value.day);
    },
    async commitSuccess(user, id) {
      const value = await db("rpc/notebook_commit_success", {
        method: "POST",
        body: JSON.stringify({ p_user: user, p_article: id }),
      });
      return usageFor(value.used, value.day);
    },
  };
}
