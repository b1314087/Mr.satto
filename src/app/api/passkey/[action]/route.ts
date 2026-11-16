import { NextResponse } from "next/server";
import {
  deletePasskey,
  finishPasskeyAuthentication,
  finishPasskeyRegistration,
  getPasskeyStore,
  getPasskeyUser,
  heartbeat,
  isPasskeyFeatureEnabled,
  registerCurrentDevice,
  relyingParty,
  revokeDevice,
  endAllSessions,
  startPasskeyAuthentication,
  startPasskeyRegistration,
} from "@/lib/passkey/server";
import { isPasskeyDevMode } from "@/lib/passkey/dev";
import { ageMemoryLeaseVerification, expireMemoryLease } from "@/lib/passkey/memory-store";

/**
 * パスキー・登録端末・同時利用のAPI（POSTだけ。JSONで受け取り、JSONで返す）。
 *   register-options / register-verify : パスキーの登録
 *   auth-options / auth-verify         : パスキーでの本人確認（この端末の登録・利用開始・切り替えまで行う）
 *   device-register                    : 端末を解除したあと、この端末を登録する（直近の本人確認が必要）
 *   device-revoke                      : 端末の登録を解除する（直近の本人確認が必要）
 *   credential-delete                  : パスキーを削除する（直近の本人確認が必要）
 *   heartbeat                          : 利用状態の定期確認（同時利用のロックを延長する）
 *
 * どの操作も、検証済みのログインの本人だけを対象にする（リクエストの中のユーザーIDは受け取らない）。
 * 別のサイトからの呼び出しは、Originの確認で断る。
 */

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  if (!isPasskeyFeatureEnabled()) return json({ error: "この機能は準備中です。" }, 404);
  if (!(await relyingParty())) return json({ error: "このページのアドレスからは操作できません。" }, 403);

  const user = await getPasskeyUser();
  if (!user) return json({ error: "ログインが必要です。", code: "login_required" }, 401);
  const store = getPasskeyStore();
  if (!store) return json({ error: "現在この機能を利用できません。しばらくしてからお試しください。" }, 503);

  let body: Record<string, unknown> = {};
  try {
    const text = await request.text();
    if (text.length > 64_000) return json({ error: "リクエストが大きすぎます。" }, 413);
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return json({ error: "リクエストの形式が正しくありません。" }, 400);
  }
  const challengeId = typeof body.challengeId === "string" && UUID.test(body.challengeId) ? body.challengeId : null;

  try {
    switch (action) {
      case "register-options": {
        const r = await startPasskeyRegistration(store, user);
        return r.ok ? json({ challengeId: r.challengeId, options: r.options }) : json({ error: r.message, code: r.code }, r.status);
      }
      case "register-verify": {
        if (!challengeId || typeof body.response !== "object" || !body.response) return json({ error: "リクエストの形式が正しくありません。" }, 400);
        const r = await finishPasskeyRegistration(store, user, challengeId, body.response as never);
        return r.ok ? json(r) : json({ error: r.message, code: r.code }, r.status);
      }
      case "auth-options": {
        const r = await startPasskeyAuthentication(store, user);
        return r.ok ? json({ challengeId: r.challengeId, options: r.options }) : json({ error: r.message, code: r.code }, r.status);
      }
      case "auth-verify": {
        if (!challengeId || typeof body.response !== "object" || !body.response) return json({ error: "リクエストの形式が正しくありません。" }, 400);
        const r = await finishPasskeyAuthentication(store, user, challengeId, body.response as never);
        return r.ok ? json(r) : json({ error: r.message, code: r.code }, r.status);
      }
      case "device-register": {
        const r = await registerCurrentDevice(store, user);
        return r.ok ? json(r) : json({ error: r.message, code: r.code }, r.status);
      }
      case "device-revoke": {
        const deviceId = typeof body.deviceId === "string" && UUID.test(body.deviceId) ? body.deviceId : null;
        if (!deviceId) return json({ error: "リクエストの形式が正しくありません。" }, 400);
        const r = await revokeDevice(store, user, deviceId);
        return r.ok ? json(r) : json({ error: r.message, code: r.code }, r.status);
      }
      case "credential-delete": {
        const id = typeof body.id === "string" && UUID.test(body.id) ? body.id : null;
        if (!id) return json({ error: "リクエストの形式が正しくありません。" }, 400);
        const r = await deletePasskey(store, user, id);
        return r.ok ? json(r) : json({ error: r.message, code: r.code }, r.status);
      }
      case "heartbeat":
        return json({ status: await heartbeat(store, user) });
      // ここから下は、開発の自動テスト専用（本番では isPasskeyDevMode() が常に false なので、すべて404）
      case "dev-age-verification":
        if (!isPasskeyDevMode()) return json({ error: "見つかりません。" }, 404);
        ageMemoryLeaseVerification(user.id, Number(body.seconds ?? 0));
        return json({ ok: true });
      case "dev-end-all-sessions":
        if (!isPasskeyDevMode()) return json({ error: "見つかりません。" }, 404);
        await endAllSessions(user.id);
        return json({ ok: true });
      case "dev-expire-lease":
        // 開発の自動テスト専用（スリープ・通信切断で期限が切れた状態を作る）。本番では isPasskeyDevMode() が常に false
        if (!isPasskeyDevMode()) return json({ error: "見つかりません。" }, 404);
        expireMemoryLease(user.id);
        return json({ ok: true });
      default:
        return json({ error: "見つかりません。" }, 404);
    }
  } catch {
    return json({ error: "処理できませんでした。しばらくしてから、もう一度お試しください。" }, 500);
  }
}
