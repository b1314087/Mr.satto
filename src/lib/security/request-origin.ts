import "server-only";

import { NextResponse } from "next/server";
import { siteConfig } from "@/lib/config/site";
import { allowedOriginsFor, checkRequestOrigin } from "./origin";

/**
 * Stripe関連のPOST（決済ページの作成・契約管理ページの作成）で、送信元（Origin）を確認する。
 * 許可しない場合は 403 のレスポンスを返す。許可する場合は null。
 * 許可する送信元は、サーバー側の設定（siteConfig.url）だけを基準にする（src/lib/security/origin.ts）。
 */
export function rejectUntrustedOrigin(request: Request, route: string): NextResponse | null {
  const decision = checkRequestOrigin(
    { origin: request.headers.get("origin"), secFetchSite: request.headers.get("sec-fetch-site") },
    allowedOriginsFor(siteConfig.url, process.env.NODE_ENV),
  );
  if (decision.ok) return null;
  // 値そのもの（Origin）はログに出さない（理由の種類だけ）
  console.warn(`[${route}] request rejected: origin check failed (${decision.reason})`);
  return NextResponse.json({ error: "このリクエストは受け付けられません。" }, { status: 403 });
}
