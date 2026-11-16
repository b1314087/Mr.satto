import "server-only";

import { createHash, createHmac, randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { getCurrentUser } from "@/lib/auth/user";
import { CANONICAL_HOST, CANONICAL_ORIGIN, siteConfig } from "@/lib/config/site";
import { featureFlags } from "@/lib/config/features";
import { getSupabaseServiceClient } from "@/lib/supabase/service";
import {
  AUTH_FAILURE_MAX,
  AUTH_FAILURE_WINDOW_SEC,
  DEVICE_COOKIE,
  DEVICE_LIMIT_MESSAGE,
  MAX_PASSKEYS,
  RECENT_VERIFICATION_TTL_SEC,
  SESSION_COOKIE,
  SESSION_HINT_COOKIE,
  VERIFY_COOKIE,
} from "./config";
import { createMemoryPasskeyStore } from "./memory-store";
import { createSupabasePasskeyStore } from "./supabase-store";
import { getDevPasskeyUser, isPasskeyDevMode } from "./dev";
import { deviceLabelFromUserAgent, passkeyLabel } from "./labels";
import { decidePaidAccess, type PaidAccessStatus } from "./policy";
import type { PasskeyStore, StoredDevice } from "./store";

/**
 * パスキー・登録端末・同時利用のサーバー側の処理（Route Handler / Server Action / Server Component から使う）。
 *
 * セキュリティの要点：
 *   - パスキーの登録・認証は、必ずサーバーで検証する（チャレンジ・Origin・RP ID・署名・ユーザー確認（生体認証/PIN）・カウンター）。
 *     チャレンジはサーバーが作り、DBに保存して1回だけ使う。
 *   - 端末とセッションは、サーバーが作る乱数をJavaScriptから読めないCookie（httpOnly）に入れ、DBにはハッシュだけを保存する。
 *     ブラウザの値を書き換えても、DBにない値は使えない。端末の数・ロックはDBの関数が判定する。
 *   - 利用者のIDは、検証済みのログイン（Supabase Auth）からだけ取る。リクエストの中のIDは使わない。
 */

export interface PasskeyUser {
  id: string;
  email: string | null;
}

export function isPasskeyFeatureEnabled(): boolean {
  return featureFlags.passkey;
}

export function getPasskeyStore(): PasskeyStore | null {
  if (isPasskeyDevMode()) return createMemoryPasskeyStore();
  const client = getSupabaseServiceClient();
  return client ? createSupabasePasskeyStore(client) : null;
}

/** ログイン中の本人（開発の自動テストでは、テスト用のユーザー） */
export async function getPasskeyUser(): Promise<PasskeyUser | null> {
  const dev = await getDevPasskeyUser();
  if (dev) return dev;
  const user = await getCurrentUser();
  return user ? { id: user.id, email: user.email } : null;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

async function readTokenCookie(name: string): Promise<string | null> {
  const value = (await cookies()).get(name)?.value ?? "";
  return TOKEN_RE.test(value) ? value : null;
}

const secureCookies = process.env.NODE_ENV === "production";

async function setTokenCookie(name: string, value: string, maxAgeSec?: number): Promise<void> {
  (await cookies()).set(name, value, {
    httpOnly: true,
    secure: secureCookies,
    sameSite: "lax",
    path: "/",
    ...(maxAgeSec ? { maxAge: maxAgeSec } : {}),
  });
}

async function setSessionHint(on: boolean): Promise<void> {
  const store = await cookies();
  if (on) store.set(SESSION_HINT_COOKIE, "1", { httpOnly: false, secure: secureCookies, sameSite: "lax", path: "/" });
  else store.delete(SESSION_HINT_COOKIE);
}

async function clearCookie(name: string): Promise<void> {
  (await cookies()).delete(name);
}

/** パスキーのRP（このサイト）の情報。本番は正式なドメインだけ、開発は localhost だけを受け付ける */
export async function relyingParty(): Promise<{ rpID: string; origins: string[] } | null> {
  const h = await headers();
  const origin = h.get("origin");
  if (process.env.NODE_ENV === "production") {
    // 正式なパスキーの利用元は https://mrsatto.com だけ（環境変数ではなく固定値。www・Vercelのアドレスは本番では mrsatto.com へ転送される）
    const origins = [CANONICAL_ORIGIN];
    if (origin && !origins.includes(origin)) return null;
    return { rpID: CANONICAL_HOST, origins };
  }
  const host = h.get("host") ?? "";
  const m = /^localhost(?::(\d+))?$/.exec(host);
  if (!m) return null;
  const devOrigin = `http://${host}`;
  if (origin && origin !== devOrigin) return null;
  return { rpID: "localhost", origins: [devOrigin] };
}

async function requestMeta(): Promise<{ ipHash: string | null; userAgent: string | null }> {
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0]?.trim() || h.get("x-real-ip") || "";
  const secret = process.env.TEMP_ACCESS_SECRET;
  // IPアドレスそのものは保存しない（サーバーだけが知る値と混ぜたハッシュの先頭16文字。補助的な手がかりとしてだけ使う）
  const ipHash = ip && secret ? createHmac("sha256", secret).update(`ip:${ip}`).digest("hex").slice(0, 16) : null;
  return { ipHash, userAgent: (h.get("user-agent") ?? "").slice(0, 300) || null };
}

async function log(store: PasskeyStore, userId: string, kind: string, detail: Record<string, unknown> = {}): Promise<void> {
  try {
    const meta = await requestMeta();
    await store.logEvent(userId, kind, detail, meta.ipHash, meta.userAgent);
  } catch {
    // 記録できなくても、利用者の操作は止めない
  }
}

// ---------------------------------------------------------------------------
// 有料機能を使えるか（getServerPlan から使う）
// ---------------------------------------------------------------------------

export interface PaidAccessResult {
  status: PaidAccessStatus;
}

export async function resolvePaidAccess(userId: string, contractPaid: boolean): Promise<PaidAccessResult> {
  const enabled = isPasskeyFeatureEnabled();
  if (!contractPaid || !enabled) return { status: decidePaidAccess({ contractPaid, enabled, state: null, nowMs: Date.now() }) };
  const store = getPasskeyStore();
  let state: Parameters<typeof decidePaidAccess>[0]["state"] = null;
  if (store) {
    try {
      const [deviceToken, sessionToken] = await Promise.all([readTokenCookie(DEVICE_COOKIE), readTokenCookie(SESSION_COOKIE)]);
      const s = await store.accessState(userId, deviceToken ? hashToken(deviceToken) : null, sessionToken ? hashToken(sessionToken) : null);
      state = {
        credentialCount: s.credentialCount,
        deviceActive: s.deviceId !== null,
        lease: s.lease,
        verifiedAtMs: s.verifiedAt ? Date.parse(s.verifiedAt) : null,
      };
    } catch {
      state = null;
    }
  }
  return { status: decidePaidAccess({ contractPaid, enabled, state, nowMs: Date.now() }) };
}

// ---------------------------------------------------------------------------
// 直近の本人確認
// ---------------------------------------------------------------------------

async function hasRecentVerification(store: PasskeyStore, userId: string): Promise<boolean> {
  const token = await readTokenCookie(VERIFY_COOKIE);
  if (!token) return false;
  return store.checkVerification(userId, hashToken(token));
}

async function markVerified(store: PasskeyStore, userId: string, credentialId: string): Promise<void> {
  const token = newToken();
  await store.createVerification(userId, hashToken(token), credentialId);
  await setTokenCookie(VERIFY_COOKIE, token, RECENT_VERIFICATION_TTL_SEC);
}

// ---------------------------------------------------------------------------
// 端末とセッション
// ---------------------------------------------------------------------------

export type DeviceStepResult =
  | { kind: "ok"; tookOver: boolean }
  | { kind: "device_limit"; devices: StoredDevice[]; message: string }
  | { kind: "rate_limited"; message: string }
  | { kind: "error"; message: string };

/** この端末を（未登録なら登録して）、同時利用のロックを取る。パスキーの本人確認の直後にだけ呼ぶ */
async function attachDeviceAndStartSession(store: PasskeyStore, user: PasskeyUser): Promise<DeviceStepResult> {
  const meta = await requestMeta();
  let deviceToken = await readTokenCookie(DEVICE_COOKIE);
  let reg = deviceToken ? await store.registerDevice(user.id, hashToken(deviceToken), deviceLabelFromUserAgent(meta.userAgent)) : null;
  if (!reg || reg.outcome === "revoked" || reg.outcome === "conflict") {
    // 端末の識別値がない・解除済み・他人のもの → 新しい識別値で登録する
    deviceToken = newToken();
    reg = await store.registerDevice(user.id, hashToken(deviceToken), deviceLabelFromUserAgent(meta.userAgent));
  }
  if (reg.outcome === "limit") {
    await log(store, user.id, "device_limit_hit");
    return { kind: "device_limit", devices: await store.listDevices(user.id), message: DEVICE_LIMIT_MESSAGE };
  }
  if (reg.outcome === "rate_limited") {
    await log(store, user.id, "device_rate_limited");
    return {
      kind: "rate_limited",
      message: "短い期間に端末の登録が続いたため、新しい端末の登録を一時的に止めています。しばらくしてからお試しいただくか、お問い合わせください。",
    };
  }
  if (reg.outcome !== "ok" || !deviceToken) return { kind: "error", message: "端末を登録できませんでした。もう一度お試しください。" };
  await setTokenCookie(DEVICE_COOKIE, deviceToken, 400 * 24 * 60 * 60);
  if (!reg.already) await log(store, user.id, "device_registered", { device: reg.deviceId });

  const sessionToken = newToken();
  // パスキーで本人確認した直後なので、別の端末が使っていても、この端末に切り替える（利用者の選択による仕様）
  const lease = await store.acquireLease(user.id, reg.deviceId, hashToken(sessionToken), true);
  if (lease.outcome !== "ok") return { kind: "error", message: "利用を開始できませんでした。もう一度お試しください。" };
  await setTokenCookie(SESSION_COOKIE, sessionToken);
  await setSessionHint(true);
  if (lease.tookOver) await log(store, user.id, "session_takeover", { from: lease.previousDeviceId, to: reg.deviceId });
  return { kind: "ok", tookOver: lease.tookOver };
}

// ---------------------------------------------------------------------------
// パスキーの登録
// ---------------------------------------------------------------------------

export type CeremonyError = { ok: false; status: number; message: string; code?: string };

export async function startPasskeyRegistration(
  store: PasskeyStore,
  user: PasskeyUser
): Promise<{ ok: true; challengeId: string; options: Awaited<ReturnType<typeof generateRegistrationOptions>> } | CeremonyError> {
  const rp = await relyingParty();
  if (!rp) return { ok: false, status: 400, message: "このページのアドレスでは、パスキーを登録できません。" };
  const existing = await store.listCredentials(user.id);
  if (existing.length >= MAX_PASSKEYS) return { ok: false, status: 409, message: `登録できるパスキーは${MAX_PASSKEYS}個までです。使っていないものを削除してください。` };
  // 2つ目以降のパスキーを追加するときは、登録済みのパスキーでの本人確認（5分以内）を求める（乗っ取られたログインだけでは追加できない）
  if (existing.length > 0 && !(await hasRecentVerification(store, user.id))) {
    return { ok: false, status: 403, code: "verification_required", message: "パスキーを追加するには、先に登録済みのパスキーで本人確認をしてください。" };
  }
  const options = await generateRegistrationOptions({
    rpName: siteConfig.name,
    rpID: rp.rpID,
    userName: user.email ?? user.id,
    userDisplayName: user.email ?? "Mr.Satto",
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({ id: c.credentialId, transports: c.transports as never })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    // 端末の中のパスキー（iCloudキーチェーン・Googleパスワードマネージャー・Windows Hello）をすすめる（物理セキュリティキーは対象外）
    preferredAuthenticatorType: "localDevice",
    timeout: 120_000,
  });
  const challengeId = await store.createChallenge(user.id, "register", options.challenge);
  return { ok: true, challengeId, options };
}

export async function finishPasskeyRegistration(
  store: PasskeyStore,
  user: PasskeyUser,
  challengeId: string,
  response: RegistrationResponseJSON
): Promise<({ ok: true } & DeviceStepResult) | CeremonyError> {
  const rp = await relyingParty();
  if (!rp) return { ok: false, status: 400, message: "このページのアドレスでは、パスキーを登録できません。" };
  const expectedChallenge = await store.consumeChallenge(user.id, challengeId, "register");
  if (!expectedChallenge) return { ok: false, status: 400, message: "登録の有効期限が切れました。もう一度お試しください。" };
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: rp.origins,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
    });
  } catch {
    await log(store, user.id, "register_failed");
    return { ok: false, status: 400, message: "パスキーを確認できませんでした。もう一度お試しください。" };
  }
  if (!verification.verified) {
    await log(store, user.id, "register_failed");
    return { ok: false, status: 400, message: "パスキーを確認できませんでした。もう一度お試しください。" };
  }
  const info = verification.registrationInfo;
  const meta = await requestMeta();
  const inserted = await store.insertCredential(user.id, {
    credentialId: info.credential.id,
    publicKey: isoBase64URL.fromBuffer(info.credential.publicKey),
    counter: info.credential.counter,
    transports: (info.credential.transports ?? []).map(String),
    deviceType: info.credentialDeviceType,
    backedUp: info.credentialBackedUp,
    aaguid: info.aaguid && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(info.aaguid) ? info.aaguid : null,
    label: passkeyLabel(info.aaguid, meta.userAgent),
  });
  if (inserted === "duplicate") return { ok: false, status: 409, message: "このパスキーは、すでに登録されています。" };
  await log(store, user.id, "passkey_registered", { aaguid: info.aaguid, backedUp: info.credentialBackedUp });
  // 登録の操作そのものが、生体認証/PINによる本人確認なので、この端末の登録と利用開始まで続けて行う
  await markVerified(store, user.id, info.credential.id);
  return { ok: true, ...(await attachDeviceAndStartSession(store, user)) };
}

// ---------------------------------------------------------------------------
// パスキーでの本人確認
// ---------------------------------------------------------------------------

export async function startPasskeyAuthentication(
  store: PasskeyStore,
  user: PasskeyUser
): Promise<{ ok: true; challengeId: string; options: Awaited<ReturnType<typeof generateAuthenticationOptions>> } | CeremonyError> {
  const rp = await relyingParty();
  if (!rp) return { ok: false, status: 400, message: "このページのアドレスでは、パスキーを使えません。" };
  if ((await store.countEvents(user.id, "auth_failed", AUTH_FAILURE_WINDOW_SEC)) >= AUTH_FAILURE_MAX) {
    return { ok: false, status: 429, message: "本人確認の失敗が続いたため、一時的に止めています。15分ほどしてからお試しください。" };
  }
  const creds = await store.listCredentials(user.id);
  if (creds.length === 0) return { ok: false, status: 409, code: "no_passkey", message: "パスキーが登録されていません。先にパスキーを登録してください。" };
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    allowCredentials: creds.map((c) => ({ id: c.credentialId, transports: c.transports as never })),
    userVerification: "required",
    timeout: 120_000,
  });
  const challengeId = await store.createChallenge(user.id, "authenticate", options.challenge);
  return { ok: true, challengeId, options };
}

export async function finishPasskeyAuthentication(
  store: PasskeyStore,
  user: PasskeyUser,
  challengeId: string,
  response: AuthenticationResponseJSON
): Promise<({ ok: true } & DeviceStepResult) | CeremonyError> {
  const rp = await relyingParty();
  if (!rp) return { ok: false, status: 400, message: "このページのアドレスでは、パスキーを使えません。" };
  const expectedChallenge = await store.consumeChallenge(user.id, challengeId, "authenticate");
  if (!expectedChallenge) return { ok: false, status: 400, message: "本人確認の有効期限が切れました。もう一度お試しください。" };
  const credential = typeof response?.id === "string" ? await store.getCredential(user.id, response.id) : null;
  if (!credential) {
    await log(store, user.id, "auth_failed", { reason: "unknown_credential" });
    return { ok: false, status: 400, message: "このパスキーは、このアカウントに登録されていません。" };
  }
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: rp.origins,
      expectedRPID: rp.rpID,
      credential: {
        id: credential.credentialId,
        publicKey: isoBase64URL.toBuffer(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports as never,
      },
      requireUserVerification: true,
    });
  } catch {
    verification = null;
  }
  if (!verification?.verified) {
    await log(store, user.id, "auth_failed", { reason: "invalid_signature" });
    return { ok: false, status: 400, message: "パスキーを確認できませんでした。もう一度お試しください。" };
  }
  await store.updateCredentialUsage(user.id, credential.credentialId, verification.authenticationInfo.newCounter, verification.authenticationInfo.credentialBackedUp);
  await log(store, user.id, "auth_ok");
  await markVerified(store, user.id, credential.credentialId);
  return { ok: true, ...(await attachDeviceAndStartSession(store, user)) };
}

// ---------------------------------------------------------------------------
// 端末・パスキーの管理（直近の本人確認が必要）
// ---------------------------------------------------------------------------

const VERIFY_FIRST: CeremonyError = {
  ok: false,
  status: 403,
  code: "verification_required",
  message: "この操作には、パスキーでの本人確認が必要です（確認から5分間有効です）。",
};

export async function registerCurrentDevice(store: PasskeyStore, user: PasskeyUser): Promise<({ ok: true } & DeviceStepResult) | CeremonyError> {
  if (!(await hasRecentVerification(store, user.id))) return VERIFY_FIRST;
  return { ok: true, ...(await attachDeviceAndStartSession(store, user)) };
}

export async function revokeDevice(store: PasskeyStore, user: PasskeyUser, deviceId: string): Promise<{ ok: true } | CeremonyError> {
  if (!(await hasRecentVerification(store, user.id))) return VERIFY_FIRST;
  const ok = await store.revokeDevice(user.id, deviceId);
  if (!ok) return { ok: false, status: 404, message: "その端末は見つかりませんでした。" };
  await log(store, user.id, "device_revoked", { device: deviceId });
  // 今使っている端末を解除したときは、この端末のセッションも終わる
  const deviceToken = await readTokenCookie(DEVICE_COOKIE);
  if (deviceToken) {
    const state = await store.accessState(user.id, hashToken(deviceToken), null);
    if (!state.deviceId) {
      await clearCookie(SESSION_COOKIE);
      await setSessionHint(false);
    }
  }
  return { ok: true };
}

export async function deletePasskey(store: PasskeyStore, user: PasskeyUser, id: string): Promise<{ ok: true; remaining: number } | CeremonyError> {
  if (!(await hasRecentVerification(store, user.id))) return VERIFY_FIRST;
  const ok = await store.deleteCredential(user.id, id);
  if (!ok) return { ok: false, status: 404, message: "そのパスキーは見つかりませんでした。" };
  await log(store, user.id, "passkey_deleted");
  return { ok: true, remaining: (await store.listCredentials(user.id)).length };
}

// ---------------------------------------------------------------------------
// 定期確認・ログアウト・パスワード変更
// ---------------------------------------------------------------------------

export async function heartbeat(store: PasskeyStore, user: PasskeyUser): Promise<"ok" | "lost" | "none"> {
  const token = await readTokenCookie(SESSION_COOKIE);
  if (!token) {
    await setSessionHint(false);
    return "none";
  }
  const result = await store.heartbeat(user.id, hashToken(token));
  if (result === "lost") {
    await clearCookie(SESSION_COOKIE);
    await setSessionHint(false);
  }
  return result;
}

/** ログアウト：この端末の利用ロックを解放する（端末の登録は残す） */
export async function endCurrentSession(userId: string | null): Promise<void> {
  const token = await readTokenCookie(SESSION_COOKIE);
  const store = userId && token ? getPasskeyStore() : null;
  if (store && userId && token) {
    try {
      await store.releaseLease(userId, hashToken(token));
    } catch {
      // 解放できなくても、期限（3分）が来れば空く
    }
  }
  await clearCookie(SESSION_COOKIE);
  await clearCookie(VERIFY_COOKIE);
  await setSessionHint(false);
}

/** パスワード変更のあと：すべての端末の利用ロックと本人確認を終わらせる（この端末も、もう一度パスキーでの確認が必要） */
export async function endAllSessions(userId: string): Promise<void> {
  const store = getPasskeyStore();
  if (store) {
    try {
      await store.endAllSessions(userId);
      await log(store, userId, "password_changed");
    } catch {
      // 失敗しても、パスワードの変更そのものは終わっている
    }
  }
  await clearCookie(SESSION_COOKIE);
  await clearCookie(VERIFY_COOKIE);
  await setSessionHint(false);
}

// ---------------------------------------------------------------------------
// 管理画面（/account/security）に出す情報（本人の分だけ。公開鍵などは出さない）
// ---------------------------------------------------------------------------

export interface SecurityOverview {
  credentials: { id: string; label: string; createdAt: string; lastUsedAt: string | null }[];
  devices: { id: string; label: string; createdAt: string; lastSeenAt: string; current: boolean }[];
}

export async function loadSecurityOverview(userId: string): Promise<SecurityOverview | null> {
  const store = getPasskeyStore();
  if (!store) return null;
  try {
    const deviceToken = await readTokenCookie(DEVICE_COOKIE);
    const [credentials, devices, state] = await Promise.all([
      store.listCredentials(userId),
      store.listDevices(userId),
      store.accessState(userId, deviceToken ? hashToken(deviceToken) : null, null),
    ]);
    return {
      credentials: credentials.map((c) => ({ id: c.id, label: c.label, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt })),
      devices: devices.map((d) => ({ ...d, current: d.id === state.deviceId })),
    };
  } catch {
    return null;
  }
}
