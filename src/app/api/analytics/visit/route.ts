import { NextResponse } from "next/server";
import { getSupabaseServiceClient } from "@/lib/supabase/service";
import { supabaseServiceConfig } from "@/lib/supabase/service-config";
import { checkRateLimit } from "@/lib/utils/rate-limit";
import { dailyVisitorHash, isLikelyBot, parseVisitPath } from "@/lib/analytics/visit";
import { excludedEmailsFromEnv, isExcludedFromAccessCount } from "@/lib/analytics/exclude";
import { getCurrentUser } from "@/lib/auth/user";

/**
 * サイトの訪問数の記録（個人を特定しない・Cookieなし）。画面（src/components/analytics/visit-beacon.tsx）が、
 * ページを開くたびに、パスだけを送ってくる。保存するのは、日ごとの訪問者数・閲覧数だけ（詳細は src/lib/analytics/visit.ts）。
 *
 * - 記録に失敗しても、利用者には何も影響させない（常に 204 を返す）。
 * - 他のサイトからの送信・ボット・数えないページ・Do Not Track・運営者のアカウントでのログイン中などは、記録しない。
 */
const NO_STORE = { "Cache-Control": "no-store" };
const MAX_BODY_BYTES = 1_000;
// 同じ接続元からの送信が多すぎるときは、記録しない（メモリ内の簡易な制限。rate-limit.ts 参照）
const VISIT_RATE_LIMIT = { limit: 120, windowMs: 60_000 };

function done() {
  return new NextResponse(null, { status: 204, headers: NO_STORE });
}

export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin");
    if (origin) {
      let sameOrigin = false;
      try {
        sameOrigin = new URL(origin).host === request.headers.get("host");
      } catch {
        sameOrigin = false;
      }
      if (!sameOrigin) return done();
    }
    if (request.headers.get("dnt") === "1" || request.headers.get("sec-gpc") === "1") return done();
    const userAgent = request.headers.get("user-agent");
    if (isLikelyBot(userAgent)) return done();

    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return done();
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return done();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return done();
    }
    if (!parseVisitPath(body)) return done();

    // 運営者などのアカウントでログインしている場合は、数えない（ログイン中のブラウザだけが対象。メールアドレスは保存しない）
    const excluded = excludedEmailsFromEnv({ ADMIN_EMAILS: process.env.ADMIN_EMAILS, ANALYTICS_EXCLUDED_EMAILS: process.env.ANALYTICS_EXCLUDED_EMAILS });
    if (excluded.length > 0 && (request.headers.get("cookie") ?? "").includes("-auth-token")) {
      const user = await getCurrentUser().catch(() => null);
      if (isExcludedFromAccessCount(user?.email, excluded)) return done();
    }

    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
    if (checkRateLimit(`visit:${ip}`, VISIT_RATE_LIMIT).limited) return done();

    const service = getSupabaseServiceClient();
    const secret = process.env.VISIT_HASH_SECRET || supabaseServiceConfig.serviceRoleKey;
    if (!service || !secret) return done();

    const hash = dailyVisitorHash(secret, ip, userAgent ?? "", new Date());
    await service.rpc("record_site_visit", { p_visitor_hash: hash });
  } catch {
    // 記録できなくても、何もしない
  }
  return done();
}
