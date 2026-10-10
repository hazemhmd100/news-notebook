import { createHandler, cloudStore } from "../_shared/handler.js";
import { AppError } from "../_shared/core.js";

const url = Deno.env.get("SUPABASE_URL") || "";
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const owner = Deno.env.get("OWNER_USER_ID") || "";
const origins = (Deno.env.get("ALLOWED_ORIGINS") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const handler = createHandler({
  store: cloudStore(url, key),
  allowedOrigins: origins,
  authenticate: async (request: Request) => {
    if (!url || !key || !owner || !origins.length)
      throw new AppError("الإعداد السحابي غير مكتمل.", 503, "NOT_CONFIGURED");
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer "))
      throw new AppError("يرجى تسجيل الدخول.", 401, "AUTH_REQUIRED");
    const response = await fetch(`${url}/auth/v1/user`, {
      headers: { apikey: key, Authorization: authorization },
    });
    if (!response.ok)
      throw new AppError(
        "انتهت الجلسة. سجّل الدخول مجدداً.",
        401,
        "AUTH_REQUIRED",
      );
    const user = await response.json();
    if (user.id !== owner)
      throw new AppError("هذه مفكرة خاصة بصاحب الحساب فقط.", 403, "OWNER_ONLY");
    return user.id;
  },
});
Deno.serve(handler);
