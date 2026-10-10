import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import {
  AppError,
  defaultSettings,
  dayUTC,
  usageFor,
} from "../supabase/functions/_shared/core.js";

export async function localStore(path, { clock = () => new Date() } = {}) {
  let data;
  try {
    data = JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    data = {
      settings: defaultSettings(),
      archive: [],
      day: dayUTC(clock()),
      success: [],
    };
  }
  let queue = Promise.resolve();
  function transaction(fn) {
    const pending = queue.then(async () => {
      const result = fn();
      await mkdir(dirname(path), { recursive: true });
      await writeFile(`${path}.tmp`, JSON.stringify(data, null, 2), "utf8");
      await rename(`${path}.tmp`, path);
      return result;
    });
    queue = pending.catch(() => {});
    return pending;
  }
  const rollover = () => {
    const day = dayUTC(clock());
    if (day !== data.day) {
      data.day = day;
      data.success = [];
    }
  };
  return {
    settings: async () => structuredClone(data.settings),
    saveSettings: async (_user, settings) =>
      transaction(() => {
        data.settings = structuredClone(settings);
      }),
    archive: async () => structuredClone(data.archive),
    saveArchive: async (_user, articles) =>
      transaction(() => {
        const map = new Map(data.archive.map((a) => [a.id, a]));
        for (const a of articles) map.set(a.id, a);
        data.archive = [...map.values()];
      }),
    deleteArchive: async (_user, ids) =>
      transaction(() => {
        data.archive = data.archive.filter((a) => !ids.includes(a.id));
      }),
    usage: async () => {
      await queue;
      rollover();
      return usageFor(data.success.length, data.day);
    },
    commitSuccess: async (_user, id) =>
      transaction(() => {
        rollover();
        if (!data.success.includes(id)) {
          if (data.success.length >= 20)
            throw new AppError(
              "وصلت إلى الحد اليومي: 20 ملخصاً ناجحاً.",
              429,
              "DAILY_LIMIT",
            );
          data.success.push(id);
        }
        return usageFor(data.success.length, data.day);
      }),
  };
}
