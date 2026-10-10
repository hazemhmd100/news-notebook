import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import { XMLParser } from "fast-xml-parser";

export const LIMIT = 20;
export class AppError extends Error {
  constructor(message, status = 400, code = "INVALID_INPUT") {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const defaultSettings = () => ({
  sources: [],
  sections: ["عام", "سياسة", "اقتصاد", "تقنية"],
});
const hosts = new Set([
  "feeds.bbci.co.uk",
  "www.bbc.com",
  "www.bbc.co.uk",
  "bbc.com",
  "bbc.co.uk",
  "www.aljazeera.net",
  "aljazeera.net",
  "news.un.org",
]);
export function safeURL(value, demo = false) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AppError("الرابط غير صالح.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    (!hosts.has(url.hostname) && !(demo && url.hostname === "demo.invalid"))
  )
    throw new AppError(
      "هذا المصدر غير مدعوم في النسخة الأولى. استخدم BBC عربي أو الجزيرة أو أخبار الأمم المتحدة.",
      "400",
      "UNSUPPORTED_SOURCE",
    );
  url.hash = "";
  for (const key of [...url.searchParams.keys()])
    if (/^(utm_|at_|traffic_source|fbclid|gclid)/i.test(key))
      url.searchParams.delete(key);
  return url.href;
}
export function feedURL(value, demo = false) {
  const url = new URL(safeURL(value, demo));
  if (/^\/(arabic)?\/?$/.test(url.pathname) && /bbc\./.test(url.hostname))
    return "https://feeds.bbci.co.uk/arabic/rss.xml";
  if (url.pathname === "/" && /aljazeera.net$/.test(url.hostname))
    return "https://www.aljazeera.net/aljazeerarss/ar/all.xml";
  if (/^\/ar\/?$/.test(url.pathname) && url.hostname === "news.un.org")
    return "https://news.un.org/feed/subscribe/ar/news/all/rss.xml";
  return url.href;
}
export function validateSettings(input, demo = false) {
  if (
    !Array.isArray(input.sections) ||
    !Array.isArray(input.sources) ||
    input.sections.length > 30 ||
    input.sources.length > 20
  )
    throw new AppError("الحد الأقصى 20 مصدراً و30 قسماً.");
  const sections = [
    ...new Set(input.sections.map((s) => String(s).trim()).filter(Boolean)),
  ];
  if (!sections.length || sections.some((s) => s.length > 60))
    throw new AppError("أضف قسماً صالحاً أولاً.");
  const ids = new Set();
  const sources = input.sources.map((s) => {
    if (
      typeof s.id !== "string" ||
      !/^[\w-]{1,80}$/.test(s.id) ||
      ids.has(s.id)
    )
      throw new AppError("معرّف مصدر غير صالح أو مكرر.");
    ids.add(s.id);
    if (
      typeof s.name !== "string" ||
      !s.name.trim() ||
      s.name.length > 100 ||
      !sections.includes(s.section)
    )
      throw new AppError("تحقق من اسم المصدر وقسمه.");
    return {
      id: s.id,
      name: s.name.trim(),
      url: feedURL(s.url, demo),
      section: s.section,
      enabled: s.enabled !== false,
    };
  });
  return { sections, sources };
}
export async function hash(value) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export const dayUTC = (now = new Date()) => now.toISOString().slice(0, 10);
export const usageFor = (used, day = dayUTC()) => ({
  day,
  used,
  limit: LIMIT,
  remaining: Math.max(0, LIMIT - used),
});
export async function fetchText(
  value,
  { fetcher = fetch, maxBytes = 1500000, timeout = 15000 } = {},
) {
  let url = safeURL(value);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    for (let redirects = 0; redirects <= 4; redirects++) {
      const response = await fetcher(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept:
            "application/rss+xml, application/atom+xml, text/html, application/xml;q=0.9",
          "User-Agent": "PrivateNewsNotebook/0.1 (personal RSS reader)",
        },
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) throw new AppError("إعادة توجيه بلا وجهة.", 502);
        url = safeURL(new URL(location, url).href);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new AppError(
          `المصدر أعاد الخطأ ${response.status}.`,
          502,
          "SOURCE_ERROR",
        );
      }
      const type = response.headers.get("content-type") || "";
      if (!/html|xml|text\/plain/i.test(type)) {
        await response.body?.cancel();
        throw new AppError("نوع محتوى المصدر غير مدعوم.", 422);
      }
      if (Number(response.headers.get("content-length")) > maxBytes) {
        await response.body?.cancel();
        throw new AppError("صفحة المصدر أكبر من الحد المسموح.", 422);
      }
      const reader = response.body.getReader();
      let size = 0;
      const chunks = [];
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        size += chunk.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new AppError("صفحة المصدر أكبر من الحد المسموح.", 422);
        }
        chunks.push(chunk);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return { text: new TextDecoder().decode(bytes), url, type };
    }
    throw new AppError("تعذر متابعة إعادة توجيه المصدر.", 502);
  } catch (error) {
    if (error.name === "AbortError")
      throw new AppError(
        "انتهت مهلة المصدر. جرّب لاحقاً.",
        504,
        "SOURCE_TIMEOUT",
      );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
const array = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const plain = (x) =>
  typeof x === "object" ? String(x?.["#text"] || "") : String(x || "");
function cleanText(value) {
  return parseHTML(`<html><body>${String(value)}</body></html>`)
    .document.body.textContent.replace(/\s+/g, " ")
    .trim();
}
export async function parseFeed(text, source, demo = false) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text))
    throw new AppError("ملف تغذية غير آمن أو غير مدعوم.", 422);
  const data = new XMLParser({
    ignoreAttributes: false,
    processEntities: false,
  }).parse(text);
  let entries = array(data.rss?.channel?.item || data.feed?.entry);
  if (!entries.length)
    throw new AppError(
      "لم نجد أخباراً في الرابط. أضف رابط RSS للقسم المطلوب.",
      422,
      "NO_FEED",
    );
  const articles = [],
    seen = new Set();
  for (const item of entries.slice(0, 80)) {
    try {
      const links = array(item.link);
      const link = links.find(
        (l) =>
          typeof l === "string" || !l["@_rel"] || l["@_rel"] === "alternate",
      );
      const url = safeURL(
        new URL(
          cleanText(typeof link === "object" ? link["@_href"] : plain(link)),
          source.url,
        ).href,
        demo,
      );
      const title = cleanText(plain(item.title)).slice(0, 300);
      if (!title || seen.has(url)) continue;
      seen.add(url);
      const rawDate = plain(item.pubDate || item.published || item.updated);
      const date = new Date(rawDate);
      articles.push({
        id: await hash(url),
        title,
        url,
        sourceId: source.id,
        source: source.name,
        section: source.section,
        publishedAt: Number.isNaN(date.valueOf()) ? null : date.toISOString(),
      });
    } catch {
      /* Reject unsafe individual feed links, continue other articles. */
    }
  }
  return articles;
}
export function extractArticle(html, url) {
  const { document } = parseHTML(html);
  const result = new Readability(document, { charThreshold: 160 }).parse();
  if (!result?.textContent)
    throw new AppError(
      "تعذر قراءة نص المقال. قد يكون محمياً أو يحتاج JavaScript.",
      422,
      "NO_ARTICLE",
    );
  return result.textContent.replace(/\s+/g, " ").trim().slice(0, 60000);
}
const stop = new Set(
  "في من على إلى عن أن إن مع هذا هذه ذلك التي الذي ما لا لم لن كان كانت كما أو و هو هي بعد قبل بين عند كل خلال وقد وقال the a an is are was were to of in on for with and or it that this as by at from".split(
    " ",
  ),
);
function words(s) {
  return (s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter(
    (w) => !stop.has(w),
  );
}
export function summarize(text) {
  const parts = text.match(/[^.!?؟\n]+(?:[.!?؟]+|$)/gu) || [];
  const sentences = [
    ...new Set(
      parts
        .map((s) => s.trim())
        .filter((s) => s.length >= 35 && s.length <= 900),
    ),
  ];
  if (sentences.length < 4)
    throw new AppError(
      "نص المقال قصير؛ لا يكفي لأربعة أسطر موثوقة.",
      422,
      "INSUFFICIENT_TEXT",
    );
  const freq = new Map();
  for (const s of sentences)
    for (const w of new Set(words(s))) freq.set(w, (freq.get(w) || 0) + 1);
  const scored = sentences.map((s, i) => ({
    s,
    i,
    score:
      words(s).reduce((n, w) => n + (freq.get(w) || 0), 0) /
        Math.sqrt(Math.max(1, words(s).length)) +
      (i === 0 ? 8 : 0),
  }));
  const chosen = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(5, sentences.length))
    .sort((a, b) => a.i - b.i);
  return chosen.map((x) => x.s);
}
export const demoArticles = [
  {
    title: "مساحة تجريبية: مكتبة الحي توسّع أنشطتها",
    text: "أعلنت مكتبة الحي في هذا المثال التدريبي توسيع أنشطتها خلال الشهر المقبل لتشمل لقاءات للقراءة الجماعية. وستفتح المكتبة قاعة إضافية لاستقبال الطلاب في فترات المساء وفق جدول يعلن لاحقاً. وأوضح فريق المكتبة أن التسجيل في اللقاءات سيكون مجانياً ومتاحاً لسكان المنطقة. وتتضمن الخطة ورشات للتعريف بأساليب البحث والتحقق من مصادر المعلومات على الإنترنت. ويشارك متطوعون في تنظيم الفعاليات ومساعدة الزوار على الوصول إلى الكتب المناسبة. ويؤكد المنظمون أن هذه بيانات تدريبية لا تصف حدثاً إخبارياً حقيقياً.",
  },
  {
    title: "مساحة تجريبية: مشروع حديقة مجتمعية جديدة",
    text: "ناقش سكان الحي في هذا المثال التدريبي اقتراح إنشاء حديقة مجتمعية في مساحة غير مستخدمة. ويهدف المقترح إلى توفير مكان للمشي وممارسة الأنشطة الخارجية لجميع الفئات العمرية. وتضم التصورات الأولية أشجاراً محلية ومقاعد للراحة ومساراً يسهل الوصول إليه. وسيجمع فريق المبادرة آراء السكان قبل تحديد التصميم النهائي للحديقة المقترحة. ولم يحدد المشاركون موعداً للتنفيذ لأن المشروع ما زال في مرحلة النقاش الأولي. وهذا النص للتجربة فقط ولا يشير إلى مشروع قائم أو خبر حقيقي.",
  },
];
export async function discover(
  sources,
  limit,
  countMode,
  demo = false,
  fetcher = fetch,
) {
  const errors = [],
    groups = [];
  for (const source of sources) {
    try {
      let articles;
      if (demo && new URL(source.url).hostname === "demo.invalid")
        articles = await Promise.all(
          demoArticles.map(async (a, i) => ({
            id: await hash(`https://demo.invalid/article/${i}`),
            title: a.title,
            url: `https://demo.invalid/article/${i}`,
            sourceId: source.id,
            source: source.name,
            section: source.section,
            publishedAt: null,
          })),
        );
      else {
        const response = await fetchText(source.url, { fetcher });
        articles = await parseFeed(response.text, source, demo);
      }
      groups.push(articles.slice(0, limit));
    } catch (e) {
      errors.push({
        source: source.name,
        message: e instanceof AppError ? e.message : "تعذر الاتصال بالمصدر.",
      });
    }
  }
  const seen = new Set(),
    articles = [];
  // Round robin gives multiple sources a fair share of a total limit.
  for (let i = 0; i < limit; i++)
    for (const group of groups) {
      const a = group[i];
      if (a && !seen.has(a.url)) {
        seen.add(a.url);
        articles.push(a);
      }
    }
  return {
    articles: articles.slice(0, countMode === "total" ? limit : 20),
    errors,
  };
}
export async function buildSummary(
  article,
  sources,
  demo = false,
  fetcher = fetch,
) {
  const source = sources.find((s) => s.id === article?.sourceId);
  if (!source) throw new AppError("المصدر غير موجود.");
  const url = safeURL(article.url, demo);
  if (
    typeof article.title !== "string" ||
    !article.title.trim() ||
    article.title.length > 300
  )
    throw new AppError("عنوان الخبر غير صالح.");
  let text;
  if (demo && new URL(url).hostname === "demo.invalid") {
    const index = Number(new URL(url).pathname.split("/").pop());
    text = demoArticles[index]?.text;
    if (!text) throw new AppError("خبر التجربة غير موجود.", 404);
  } else {
    const response = await fetchText(url, { fetcher });
    text = extractArticle(response.text, response.url);
  }
  return {
    id: await hash(url),
    url,
    title: article.title,
    sourceId: source.id,
    source: source.name,
    section: source.section,
    publishedAt:
      article.publishedAt && Number.isFinite(Date.parse(article.publishedAt))
        ? new Date(article.publishedAt).toISOString()
        : null,
    summary: summarize(text),
    summarizedAt: new Date().toISOString(),
  };
}
export async function validateArchive(articles, demo = false) {
  if (!Array.isArray(articles) || articles.length < 1 || articles.length > 20)
    throw new AppError("اختر من خبر واحد إلى 20 خبراً.");
  return Promise.all(
    articles.map(async (a) => {
      const url = safeURL(a.url, demo);
      if (
        !Array.isArray(a.summary) ||
        a.summary.length < 4 ||
        a.summary.length > 6 ||
        a.summary.some((s) => typeof s !== "string" || s.length > 1000)
      )
        throw new AppError("الملخص غير صالح.");
      for (const field of ["title", "source", "section"])
        if (typeof a[field] !== "string" || a[field].length > 300)
          throw new AppError("بيانات الخبر غير صالحة.");
      return {
        id: await hash(url),
        url,
        title: a.title,
        source: a.source,
        sourceId: String(a.sourceId || "").slice(0, 80),
        section: a.section,
        summary: a.summary,
        publishedAt:
          a.publishedAt && Number.isFinite(Date.parse(a.publishedAt))
            ? new Date(a.publishedAt).toISOString()
            : null,
        summarizedAt:
          a.summarizedAt && Number.isFinite(Date.parse(a.summarizedAt))
            ? new Date(a.summarizedAt).toISOString()
            : new Date().toISOString(),
      };
    }),
  );
}
