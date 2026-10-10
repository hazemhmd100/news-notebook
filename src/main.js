import { createClient } from "@supabase/supabase-js";
import { articlesToText, exportTxt, exportDocx, exportPdf } from "./export.js";
import "./style.css";

const env = import.meta.env,
  configured = !!(env.VITE_SUPABASE_URL && env.VITE_SUPABASE_ANON_KEY);
const supabase = configured
  ? createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
      auth: { flowType: "pkce" },
    })
  : null;
const base = (
  env.VITE_API_URL ||
  (configured ? `${env.VITE_SUPABASE_URL}/functions/v1/notebook` : "/api")
).replace(/\/$/, "");
const app = document.querySelector("#app");
let session = null,
  state = null,
  page = "notebook",
  results = [],
  selected = new Set(),
  sourceSelection = new Set(),
  busy = false,
  cancelled = false,
  search = "",
  sectionFilter = "",
  sortOrder = "newest",
  message = "",
  messageError = false,
  runErrors = [],
  editingId = null;
let mutationBusy = false,
  runProgress = null;
let runOptions = { limit: 5, countMode: "total", resultMode: "replace" };
document.documentElement.dataset.theme =
  localStorage.getItem("mojaz-theme") || "light";
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on"))
      e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "text") e.textContent = v;
    else if (k in e) e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c !== null && c !== undefined)
      e.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return e;
}
const button = (text, onClick, cls = "", disabled = false) =>
  el("button", { type: "button", class: cls, onClick, disabled }, text);
const field = (label, input, cls = "") =>
  el("label", { class: `field ${cls}` }, label, input);
function select(options, value, onChange) {
  return el(
    "select",
    {
      "aria-label":
        options[0]?.[0] === ""
          ? "تصفية حسب القسم"
          : options[0]?.[0] === "newest"
            ? "ترتيب الأرشيف"
            : options[0]?.[0] === "total"
              ? "توزيع العدد"
              : options[0]?.[0] === "replace"
                ? "نتائج القراءة"
                : "القسم",
      onChange: (e) => onChange(e.target.value),
    },
    options.map(([v, t]) =>
      el("option", { value: v, selected: v === value }, t),
    ),
  );
}
function safeUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : "#";
  } catch {
    return "#";
  }
}
function notice(text, error = false) {
  message = text;
  messageError = error;
  render();
}
function inlineError(text) {
  message = text;
  messageError = true;
  const status = document.querySelector(".status");
  if (status) {
    status.textContent = text;
    status.classList.add("error");
    status.setAttribute("role", "alert");
  } else render();
}
function lockMutations(locked) {
  mutationBusy = locked;
  document
    .querySelectorAll("#app button,#app input,#app select")
    .forEach((control) => (control.disabled = locked));
}
async function api(path, method = "GET", data) {
  const headers = { "Content-Type": "application/json" };
  if (configured) {
    const { data: auth } = await supabase.auth.getSession();
    if (!auth.session)
      throw new Error("انتهت جلسة الدخول. سجّل الدخول مجدداً.");
    headers.Authorization = `Bearer ${auth.session.access_token}`;
    headers.apikey = env.VITE_SUPABASE_ANON_KEY;
  }
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  let json;
  try {
    json = await response.json();
  } catch {
    throw new Error(
      "تعذر قراءة استجابة الخادم. تحقق من تشغيله وإعداد عنوان الخدمة.",
    );
  }
  if (!response.ok) {
    const err = new Error(json.error || "تعذر إكمال العملية");
    err.code = json.code;
    throw err;
  }
  return json;
}
async function load() {
  app.replaceChildren(
    el("div", { class: "loading", role: "status" }, "جارٍ فتح المفكرة…"),
  );
  try {
    state = await api("/state");
    sourceSelection = new Set(
      state.sources.filter((s) => s.enabled).map((s) => s.id),
    );
    render();
  } catch (e) {
    state = null;
    authView(e.message);
  }
}
function authView(error = "") {
  app.replaceChildren(
    el(
      "main",
      { class: "auth" },
      el("div", { class: "brand" }, "موجز", el("span", {}, ".")),
      el("h1", {}, "مساحة هادئة لأخبارك"),
      el("p", {}, "اقرأ المهم، احتفظ بما تختار، وعد إليه متى شئت."),
    ),
  );
  const box = app.firstChild;
  if (!configured && !["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname)) {
    box.append(el("div", { class: "notice", role: "status" }, "المفكرة قيد الإعداد. لم يتم ربط تسجيل الدخول والخدمة الخلفية بعد؛ جلب الأخبار والحفظ غير متاحين حالياً."));
    return;
  }
  if (!configured) {
    box.append(
      el(
        "div",
        { class: "notice" },
        "وضع محلي تجريبي — لم يتم إعداد تسجيل الدخول أو الحفظ السحابي. بيانات الأرشيف محلية على خادم التجربة.",
      ),
      button("فتح المفكرة المحلية", load, "primary"),
    );
  } else {
    const email = el("input", {
        type: "email",
        required: true,
        autocomplete: "username",
        dir: "ltr",
      }),
      password = el("input", {
        type: "password",
        required: true,
        minLength: 6,
        autocomplete: "current-password",
        dir: "ltr",
      });
    const submit = el(
      "button",
      { type: "submit", class: "primary" },
      "تسجيل الدخول",
    );
    const form = el(
      "form",
      {
        onSubmit: async (e) => {
          e.preventDefault();
          submit.disabled = true;
          const { error } = await supabase.auth.signInWithPassword({
            email: email.value,
            password: password.value,
          });
          submit.disabled = false;
          if (error) authStatus(error.message);
        },
      },
      field("البريد الإلكتروني", email),
      field("كلمة المرور", password),
      submit,
    );
    box.append(
      form,
      el("div", { class: "divider" }, "أو"),
      button("المتابعة باستخدام Google", async () => {
        const { error } = await supabase.auth.signInWithOAuth({
          provider: "google",
          options: { redirectTo: window.location.origin + window.location.pathname },
        });
        if (error) authStatus(error.message);
      }),
      el(
        "p",
        {},
        "هذه مفكرة خاصة. أنشئ حساب المالك من لوحة إدارة الخدمة أولاً.",
      ),
    );
  }
  box.append(el("div", { class: "auth-status", role: "alert" }, error));
}
function authStatus(text) {
  document.querySelector(".auth-status").textContent = text;
}
function render() {
  if (!state) return;
  const nav = el(
    "nav",
    { class: "nav", "aria-label": "التنقل الرئيسي" },
    [
      ["notebook", "مفكرة اليوم", "01"],
      ["archive", "الأرشيف", String(state.archive.length)],
      ["sources", "المصادر والأقسام", "＋"],
    ].map(([id, label, number]) =>
      button(
        "",
        () => {
          page = id;
          selected.clear();
          message = "";
          render();
        },
        page === id ? "active" : "",
        busy,
      ),
    ),
  );
  [...nav.children].forEach((b, i) =>
    b.append(
      el("span", {}, ["مفكرة اليوم", "الأرشيف", "المصادر والأقسام"][i]),
      el("span", {}, ["01", String(state.archive.length), "＋"][i]),
    ),
  );
  const sidebar = el(
    "aside",
    { class: "sidebar" },
    el(
      "div",
      {},
      el("div", { class: "brand" }, "موجز", el("span", {}, ".")),
      el("p", { class: "eyebrow" }, "مفكرتك الإخبارية الخاصة"),
    ),
    nav,
    el(
      "p",
      { class: "sidebar-note" },
      "مساحة لما يستحق القراءة.",
      el("br"),
      "الأخبار تمرّ، والمعرفة تبقى.",
    ),
    el(
      "div",
      { class: "sidebar-bottom" },
      button(
        document.documentElement.dataset.theme === "dark"
          ? "☀ الوضع الفاتح"
          : "◐ الوضع الداكن",
        () => {
          const theme =
            document.documentElement.dataset.theme === "dark"
              ? "light"
              : "dark";
          document.documentElement.dataset.theme = theme;
          localStorage.setItem("mojaz-theme", theme);
          render();
        },
      ),
      configured
        ? button("خروج", () => supabase.auth.signOut(), "", busy)
        : null,
    ),
  );
  const main = el(
    "main",
    { class: "main" },
    el(
      "header",
      { class: "topline" },
      el(
        "span",
        {},
        new Intl.DateTimeFormat("ar", { dateStyle: "full" }).format(new Date()),
      ),
      el(
        "span",
        { class: "mode" },
        el("i", { class: "dot" }),
        state.mode === "demo" ? "نسخة محلية تجريبية" : "مفكرة خاصة • متصل",
      ),
    ),
  );
  const headings = {
    notebook: [
      "أخبار اليوم، بوضوح.",
      "اختر مصادرك. اقرأ خلاصة الخبر. احتفظ بما يهمّك.",
    ],
    archive: [
      "ما اخترت الاحتفاظ به.",
      "أرشيفك الخاص، من الأخبار التي حفظتها بنفسك.",
    ],
    sources: [
      "نافذتك على الأخبار.",
      "نظّم المصادر والأقسام لتصنع مفكرتك بطريقتك.",
    ],
  };
  main.append(
    el(
      "div",
      { class: "page-heading" },
      el(
        "div",
        {},
        el("h1", {}, headings[page][0]),
        el("p", {}, headings[page][1]),
      ),
      el("div", { class: "edition", "aria-hidden": "true" }, "م / ٠١"),
    ),
  );
  if (state.mode === "demo")
    main.append(
      el(
        "div",
        { class: "notice" },
        "تجربة محلية بلا حساب سحابي. شغّل الخادم المحلي لاستخدامها. لم يتم نشر هذه المفكرة على الإنترنت.",
      ),
    );
  main.append(
    el(
      "div",
      { class: "quota" },
      el("strong", {}, "رصيد القراءة اليومي"),
      el(
        "small",
        {},
        `${state.usage.used} / ${state.usage.limit} ملخصاً ناجحاً · متبقي ${state.usage.remaining} · يتجدد 00:00 UTC`,
      ),
      el("progress", {
        max: state.usage.limit,
        value: state.usage.used,
        "aria-label": "استخدام الملخصات اليومي",
      }),
    ),
  );
  main.append(
    el(
      "div",
      {
        class: `status ${messageError ? "error" : ""}`,
        role: messageError ? "alert" : "status",
        "aria-live": "polite",
      },
      message,
    ),
  );
  if (runProgress)
    main.append(
      el(
        "div",
        { class: "status", role: "status" },
        `تقدم القراءة: ${runProgress.attempted} / ${runProgress.total}`,
        el("progress", {
          class: "progress-track",
          max: Math.max(runProgress.total, 1),
          value: runProgress.attempted,
          "aria-label": "تقدم القراءة الحالية",
        }),
      ),
    );
  if (page === "notebook") notebook(main);
  else if (page === "archive") archive(main);
  else sources(main);
  main.append(
    el(
      "footer",
      { class: "footer" },
      el("span", {}, "موجز — اقرأ أقل، افهم أكثر."),
      el("span", {}, "تلخيص استخراجي دون واجهات ذكاء اصطناعي مدفوعة"),
    ),
  );
  app.replaceChildren(el("div", { class: "layout" }, sidebar, main));
}
function notebook(main) {
  const panel = el(
    "section",
    { class: "panel" },
    el(
      "div",
      { class: "panel-head" },
      el("h2", {}, el("span", { class: "step" }, "01 /"), "جهّز قراءتك"),
      button(
        "إدارة المصادر ←",
        () => {
          page = "sources";
          render();
        },
        "",
        busy,
      ),
    ),
  );
  if (!state.sources.length)
    panel.append(
      el(
        "p",
        { class: "hint" },
        "ابدأ بإضافة مصدر من صفحة المصادر والأقسام. لا توجد مصادر محفوظة بعد.",
      ),
    );
  panel.append(
    el(
      "div",
      { class: "source-options" },
      state.sources.map((s) =>
        el(
          "label",
          { class: "source-chip" },
          el("input", {
            type: "checkbox",
            checked: sourceSelection.has(s.id),
            disabled: busy || !s.enabled,
            onChange: (e) => {
              e.target.checked
                ? sourceSelection.add(s.id)
                : sourceSelection.delete(s.id);
            },
          }),
          s.name,
        ),
      ),
    ),
  );
  panel.append(
    el(
      "div",
      { class: "controls" },
      field(
        "عدد الأخبار",
        el("input", {
          type: "number",
          min: 1,
          max: 20,
          value: runOptions.limit,
          disabled: busy,
          onChange: (e) => {
            runOptions.limit = Math.max(
              1,
              Math.min(20, Number(e.target.value) || 1),
            );
            e.target.value = runOptions.limit;
          },
        }),
      ),
      field(
        "توزيع العدد",
        select(
          [
            ["total", "إجمالي المصادر"],
            ["per-source", "لكل مصدر"],
          ],
          runOptions.countMode,
          (v) => (runOptions.countMode = v),
        ),
      ),
      field(
        "نتائج القراءة",
        select(
          [
            ["replace", "استبدال النتائج"],
            ["append", "إضافة إلى النتائج"],
          ],
          runOptions.resultMode,
          (v) => (runOptions.resultMode = v),
        ),
      ),
      button(
        busy ? "جارٍ إعداد الملخصات…" : "اجلب الأخبار ولخّصها ←",
        run,
        "primary",
        busy || !state.sources.length,
      ),
      busy
        ? button(
            cancelled ? "سيتم الإيقاف…" : "إيقاف بعد الخبر الحالي",
            () => {
              cancelled = true;
              render();
            },
            "",
            cancelled,
          )
        : null,
    ),
  );
  panel.querySelectorAll("select").forEach((s) => (s.disabled = busy));
  panel.append(
    el(
      "p",
      { class: "hint" },
      "اختر حتى خمسة مصادر في الدفعة. ملخص من 4–6 فقرات مستخرجة من النص الأصلي؛ قد يختلف عدد الأسطر بحسب الشاشة. تحتفظ الأخبار بلغة المصدر. لا يُحفظ شيء في الأرشيف تلقائياً.",
    ),
  );
  main.append(panel);
  if (runErrors.length)
    main.append(
      el(
        "details",
        { class: "errors" },
        el(
          "summary",
          {},
          `تعذر إكمال ${runErrors.length} من العمليات — عرض التفاصيل`,
        ),
        runErrors.map((s) => el("p", {}, s)),
      ),
    );
  main.append(
    el(
      "div",
      { class: "results-heading" },
      el("h2", {}, "دفتر القراءة"),
      el("span", {}, `${results.length} ملخصاً`),
    ),
  );
  articleList(main, results, false);
}
async function run() {
  if (busy) return;
  if (!sourceSelection.size)
    return notice("اختر مصدراً واحداً على الأقل.", true);
  if (sourceSelection.size > 5)
    return notice("اختر خمسة مصادر على الأكثر في الدفعة الواحدة.", true);
  busy = true;
  cancelled = false;
  runProgress = { attempted: 0, total: 0 };
  runErrors = [];
  selected.clear();
  message = "جارٍ جلب قائمة الأخبار من المصادر المحددة…";
  messageError = false;
  render();
  let success = 0,
    attempted = 0,
    total = 0;
  try {
    // Refresh server date/quota when the page stayed open across midnight or
    // another device consumed the remaining allowance.
    state.usage = (await api("/state")).usage;
    if (state.usage.remaining <= 0)
      throw new Error("اكتمل حد اليوم: 20 ملخصاً ناجحاً. يتجدد عند 00:00 UTC.");
    if (runOptions.resultMode === "replace") results = [];
    const found = await api("/discover", "POST", {
      sourceIds: [...sourceSelection],
      limit: runOptions.limit,
      countMode: runOptions.countMode,
    });
    runErrors.push(
      ...(found.errors || []).map((e) => `${e.source}: ${e.message}`),
    );
    const existing = new Set(results.map((a) => a.url));
    const articles = found.articles.filter((a) => {
      if (existing.has(a.url)) return false;
      existing.add(a.url);
      return true;
    });
    total = articles.length;
    runProgress = { attempted: 0, total };
    for (const article of articles) {
      if (cancelled || state.usage.remaining <= 0) break;
      attempted++;
      message = `جلب النص وتلخيصه: ${attempted} من ${total} · نجح ${success} · أخطاء ${runErrors.length}\n${article.title}`;
      render();
      try {
        const response = await api("/summarize", "POST", { article });
        results.push(response.article);
        state.usage = response.usage;
        success++;
      } catch (e) {
        runErrors.push(`${article.title}: ${e.message}`);
        if (e.code === "DAILY_LIMIT") {
          state.usage.used = state.usage.limit;
          state.usage.remaining = 0;
          break;
        }
      }
      runProgress = { attempted, total };
      render();
    }
    message = `${cancelled ? "توقفت القراءة" : "اكتملت القراءة"} · ${success} ملخصاً جديداً · ${attempted} محاولة من ${total} · ${runErrors.length} أخطاء.${state.usage.remaining === 0 ? " بلغ رصيد اليوم الحد الأقصى." : ""}${!total ? " لا توجد أخبار جديدة في المصادر المختارة." : ""}`;
  } catch (e) {
    message = e.message;
    messageError = true;
  } finally {
    busy = false;
    runProgress = { attempted, total };
    render();
  }
}
function archive(main) {
  const filtered = state.archive
    .filter(
      (a) =>
        (!sectionFilter || a.section === sectionFilter) &&
        `${a.title} ${(a.summary || []).join(" ")} ${a.source}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((a, b) => {
      const delta =
        (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0);
      return sortOrder === "newest" ? delta : -delta;
    });
  const input = el("input", {
    type: "search",
    placeholder: "ابحث في عنوان الخبر أو ملخصه…",
    value: search,
    "aria-label": "البحث في الأرشيف",
    onInput: (e) => {
      search = e.target.value;
      const start = e.target.selectionStart;
      render();
      const next = document.querySelector("input[type=search]");
      next.focus();
      try {
        next.setSelectionRange(start, start);
      } catch {}
    },
  });
  main.append(
    el(
      "div",
      { class: "filter" },
      input,
      select(
        [["", "كل الأقسام"], ...state.sections.map((s) => [s, s])],
        sectionFilter,
        (v) => {
          sectionFilter = v;
          render();
        },
      ),
      select(
        [
          ["newest", "الأحدث أولاً"],
          ["oldest", "الأقدم أولاً"],
        ],
        sortOrder,
        (v) => {
          sortOrder = v;
          render();
        },
      ),
    ),
  );
  articleList(main, filtered, true);
}
function articleList(main, articles, isArchive) {
  if (!articles.length) {
    main.append(
      el(
        "section",
        { class: "empty" },
        el("div", { class: "empty-symbol", "aria-hidden": "true" }, "▤"),
        el("h3", {}, isArchive ? "لا أخبار هنا بعد" : "صفحة جديدة، كل يوم."),
        el(
          "p",
          {},
          isArchive
            ? "احفظ الأخبار التي تهمّك من دفتر القراءة لتجدها هنا. إن كنت تستخدم مرشحاً، جرّب تغييره."
            : "أضف مصدراً، ثم ابدأ قراءتك الأولى. ستظهر الملخصات هنا، ولن ينتقل إلى الأرشيف إلا ما تختاره.",
        ),
      ),
    );
    return;
  }
  const picked = () => articles.filter((a) => selected.has(a.id));
  const count = picked().length;
  const guarded = (fn) => async () => {
    if (mutationBusy || busy) return;
    const items = picked();
    lockMutations(true);
    try {
      await fn(items);
    } catch (e) {
      message = e.message;
      messageError = true;
    } finally {
      mutationBusy = false;
      render();
    }
  };
  const toolbar = el(
    "div",
    { class: "toolbar" },
    el(
      "label",
      {},
      el("input", {
        type: "checkbox",
        checked: count === articles.length,
        disabled: busy,
        onChange: (e) => {
          for (const a of articles)
            e.target.checked ? selected.add(a.id) : selected.delete(a.id);
          render();
        },
      }),
      `تحديد الكل (${count})`,
    ),
    button(
      isArchive ? "حذف المحدد" : "حفظ في الأرشيف",
      guarded(async (a) => {
        if (isArchive && !confirm(`حذف ${a.length} أخبار من الأرشيف؟`)) return;
        if (isArchive) {
          const response = await api("/archive", "DELETE", {
            ids: a.map((x) => x.id),
          });
          state.archive = response.archive;
        } else {
          for (let offset = 0; offset < a.length; offset += 20) {
            const response = await api("/archive", "POST", {
              articles: a.slice(offset, offset + 20),
            });
            state.archive = response.archive;
          }
        }
        selected.clear();
        message = isArchive
          ? "حُذفت الأخبار المحددة."
          : "حُفظت الأخبار المحددة فقط في أرشيفك.";
        messageError = false;
      }),
      isArchive ? "danger" : "accent",
      !count || busy,
    ),
    button("TXT", guarded(exportTxt), "", !count || busy),
    button("DOCX", guarded(exportDocx), "", !count || busy),
    button("حفظ PDF / طباعة", guarded(exportPdf), "", !count || busy),
    button(
      "نسخ",
      guarded(async (a) => {
        await navigator.clipboard.writeText(articlesToText(a));
        notice("نُسخت الأخبار المحددة.");
      }),
      "",
      !count || busy,
    ),
  );
  main.append(toolbar);
  for (const a of articles) {
    main.append(
      el(
        "article",
        { class: "article" },
        el("input", {
          type: "checkbox",
          checked: selected.has(a.id),
          disabled: busy,
          "aria-label": `تحديد ${a.title}`,
          onChange: (e) => {
            e.target.checked ? selected.add(a.id) : selected.delete(a.id);
            render();
          },
        }),
        el(
          "div",
          {},
          el(
            "div",
            { class: "article-meta" },
            el("span", { class: "tag" }, a.section || "عام"),
            el("span", {}, a.source),
            el(
              "span",
              {},
              a.publishedAt && !Number.isNaN(Date.parse(a.publishedAt))
                ? new Date(a.publishedAt).toLocaleDateString("ar")
                : "دون تاريخ منشور",
            ),
          ),
          el("h3", {}, a.title),
          (a.summary || []).map((t) => el("p", {}, t)),
          el(
            "a",
            {
              href: safeUrl(a.url),
              target: "_blank",
              rel: "noopener noreferrer",
            },
            "قراءة الخبر الأصلي ↗",
          ),
        ),
      ),
    );
  }
}
async function saveSettings(sourcesList, sections) {
  if (mutationBusy) throw new Error("انتظر اكتمال الحفظ الحالي.");
  lockMutations(true);
  try {
    const response = await api("/settings", "PUT", {
      sources: sourcesList,
      sections,
    });
    state.sources = response.sources;
    state.sections = response.sections;
  } finally {
    lockMutations(false);
  }
  sourceSelection = new Set(
    [...sourceSelection].filter((id) => sourcesList.some((s) => s.id === id)),
  );
}
function sources(main) {
  const current = state.sources.find((s) => s.id === editingId),
    name = el("input", {
      required: true,
      maxLength: 80,
      value: current?.name || "",
      placeholder: "مثال: أخبار الأمم المتحدة",
    }),
    url = el("input", {
      required: true,
      type: "url",
      dir: "ltr",
      value: current?.url || "",
      placeholder: "https://news.un.org/ar/rss.xml",
    });
  let chosenSection = current?.section || state.sections[0] || "عام";
  const submit = el(
    "button",
    { type: "submit", class: "primary" },
    current ? "حفظ التعديل" : "إضافة المصدر",
  );
  const form = el(
    "form",
    {
      onSubmit: async (e) => {
        e.preventDefault();
        try {
          const parsed = new URL(url.value);
          if (parsed.protocol !== "https:")
            throw new Error("استخدم رابط HTTPS.");
          submit.disabled = true;
          const item = {
            id: current?.id || crypto.randomUUID(),
            name: name.value.trim(),
            url: url.value.trim(),
            section: chosenSection,
            enabled: current?.enabled ?? true,
          };
          if (!item.name) throw new Error("أدخل اسم المصدر.");
          await saveSettings(
            current
              ? state.sources.map((s) => (s.id === current.id ? item : s))
              : [...state.sources, item],
            state.sections,
          );
          sourceSelection.add(item.id);
          editingId = null;
          notice("حُفظ المصدر.");
        } catch (e) {
          submit.disabled = false;
          inlineError(e.message);
        }
      },
    },
    el(
      "div",
      { class: "controls" },
      field("اسم المصدر", name),
      field("رابط الموقع أو موجز RSS", url, "wide"),
      field(
        "القسم",
        select(
          state.sections.map((s) => [s, s]),
          chosenSection,
          (v) => (chosenSection = v),
        ),
      ),
      submit,
      current
        ? button("إلغاء التعديل", () => {
            editingId = null;
            render();
          })
        : null,
    ),
  );
  const panel = el(
    "section",
    { class: "panel" },
    el("h2", {}, "أضف صوتاً إلى مفكرتك"),
    form,
    el(
      "p",
      { class: "hint" },
      "تدعم هذه النسخة مواقع BBC عربي والجزيرة وأخبار الأمم المتحدة فقط. بعض المقالات قد تمنع جلب النص. أضف مصدراً مقترحاً بضغطة واحدة:",
    ),
  );
  const presets = [
    ["BBC عربي", "https://feeds.bbci.co.uk/arabic/rss.xml"],
    ["الجزيرة", "https://www.aljazeera.net/aljazeerarss/ar/all.xml"],
    [
      "أخبار الأمم المتحدة",
      "https://news.un.org/feed/subscribe/ar/news/all/rss.xml",
    ],
  ];
  if (state.mode === "demo")
    presets.push(["مصدر تجريبي محلي", "https://demo.invalid/feed"]);
  panel.append(
    el(
      "div",
      { class: "source-options" },
      presets.map(([n, u]) =>
        button(`＋ ${n}`, async () => {
          try {
            if (state.sources.some((s) => s.url === u))
              return notice("هذا المصدر موجود بالفعل.");
            const s = {
              id: u.includes("demo.invalid") ? "demo" : crypto.randomUUID(),
              name: n,
              url: u,
              section: state.sections[0] || "عام",
              enabled: true,
            };
            await saveSettings([...state.sources, s], state.sections);
            sourceSelection.add(s.id);
            notice("أُضيف المصدر.");
          } catch (e) {
            notice(e.message, true);
          }
        }),
      ),
    ),
  );
  main.append(panel);
  main.append(
    el(
      "section",
      { class: "panel" },
      el(
        "div",
        { class: "panel-head" },
        el("h2", {}, "مصادرك"),
        el("span", { class: "hint" }, `${state.sources.length} مصادر`),
      ),
      state.sources.length
        ? state.sources.map((s) =>
            el(
              "div",
              { class: "source-row" },
              el(
                "div",
                {},
                el("strong", {}, s.name),
                el("p", {}, s.url),
                el("p", {}, s.section),
              ),
              el(
                "div",
                { class: "row-actions" },
                button(s.enabled ? "مفعّل" : "معطّل", async () => {
                  try {
                    await saveSettings(
                      state.sources.map((x) =>
                        x.id === s.id ? { ...x, enabled: !x.enabled } : x,
                      ),
                      state.sections,
                    );
                    if (s.enabled) sourceSelection.delete(s.id);
                    render();
                  } catch (e) {
                    notice(e.message, true);
                  }
                }),
                button("تعديل", () => {
                  editingId = s.id;
                  render();
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }),
                button(
                  "حذف",
                  async () => {
                    try {
                      await saveSettings(
                        state.sources.filter((x) => x.id !== s.id),
                        state.sections,
                      );
                      render();
                    } catch (e) {
                      notice(e.message, true);
                    }
                  },
                  "danger",
                ),
              ),
            ),
          )
        : el("p", { class: "hint" }, "لا توجد مصادر. أضف أول مصدر أعلاه."),
    ),
  );
  const sectionInput = el("input", {
    required: true,
    maxLength: 40,
    placeholder: "اسم القسم الجديد",
    "aria-label": "اسم القسم الجديد",
  });
  main.append(
    el(
      "section",
      { class: "panel" },
      el("h2", {}, "أقسام المفكرة"),
      el(
        "form",
        {
          class: "controls",
          onSubmit: async (e) => {
            e.preventDefault();
            const value = sectionInput.value.trim();
            if (!value || state.sections.includes(value)) return;
            try {
              await saveSettings(state.sources, [...state.sections, value]);
              notice("أُضيف القسم.");
            } catch (e) {
              notice(e.message, true);
            }
          },
        },
        sectionInput,
        el("button", { type: "submit" }, "إضافة قسم"),
      ),
      el(
        "div",
        { class: "section-list" },
        state.sections.map((s) =>
          el(
            "span",
            {},
            s,
            button("×", async () => {
              if (state.sections.length === 1)
                return notice("احتفظ بقسم واحد على الأقل.", true);
              if (state.sources.some((x) => x.section === s))
                return notice(
                  "غيّر قسم المصادر المرتبطة قبل حذف هذا القسم.",
                  true,
                );
              try {
                await saveSettings(
                  state.sources,
                  state.sections.filter((x) => x !== s),
                );
                render();
              } catch (e) {
                notice(e.message, true);
              }
            }),
          ),
        ),
      ),
    ),
  );
}
if (supabase) {
  const { data } = await supabase.auth.getSession();
  session = data.session;
  if (session) await load();
  else authView();
  supabase.auth.onAuthStateChange((event, next) => {
    session = next;
    if (event === "SIGNED_IN" && !state) setTimeout(load, 0);
    if (event === "SIGNED_OUT") {
      state = null;
      results = [];
      selected.clear();
      authView();
    }
  });
} else authView();
