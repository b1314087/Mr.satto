"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { MAX_DEVICES } from "@/lib/passkey/config";
import { PAID_ACCESS_MESSAGE, type PaidAccessStatus } from "@/lib/passkey/policy";

/**
 * パスキーと登録端末の管理画面の本体（ブラウザ側）。
 * パスキーの作成・利用はブラウザ（OS）の画面で行い、結果は必ずサーバーで検証する（ここでは判定しない）。
 */

interface Credential { id: string; label: string; createdAt: string; lastUsedAt: string | null }
interface Device { id: string; label: string; createdAt: string; lastSeenAt: string; current: boolean }

type ApiResult = { ok: true; data: Record<string, unknown> } | { ok: false; status: number; error: string; code?: string };

async function api(action: string, body: Record<string, unknown> = {}): Promise<ApiResult> {
  try {
    const res = await fetch(`/api/passkey/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { ok: false, status: res.status, error: String(data.error ?? "処理できませんでした。"), code: data.code as string | undefined };
    return { ok: true, data };
  } catch {
    return { ok: false, status: 0, error: "通信できませんでした。接続を確かめて、もう一度お試しください。" };
  }
}

function webauthnErrorMessage(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "AbortError") {
    return "パスキーの操作が取り消されたか、時間切れになりました。もう一度お試しください。";
  }
  if (name === "InvalidStateError") return "このパスキーは、すでに登録されています。";
  if (name === "SecurityError") return "このページのアドレスでは、パスキーを使えません。";
  return "パスキーを使えませんでした。お使いの端末・ブラウザがパスキーに対応しているか、ご確認ください。";
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function PasskeyManager({
  status,
  contractPaid,
  credentials,
  devices,
  next,
}: {
  status: PaidAccessStatus;
  contractPaid: boolean;
  credentials: Credential[];
  devices: Device[];
  next: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);
  const [deviceLimit, setDeviceLimitState] = useState(false);
  // 同じ操作の途中で変わった値を読むため、最新の値をrefにも持つ（stateは次の描画まで古いまま）
  const deviceLimitRef = useRef(false);
  const setDeviceLimit = (v: boolean) => {
    deviceLimitRef.current = v;
    setDeviceLimitState(v);
  };
  const [confirming, setConfirming] = useState<string | null>(null);
  // 新しい端末（2台目以降）の登録のための、メールの確認コードの入力（null のときは出さない）
  const [emailStep, setEmailStep] = useState<{ maskedEmail: string; sent: boolean } | null>(null);
  const [emailCode, setEmailCode] = useState("");
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!emailStep) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [emailStep]);
  const resendWaitSec = Math.max(0, Math.ceil((resendAt - now) / 1000));

  const supported = typeof window === "undefined" ? true : browserSupportsWebAuthn();

  /** パスキーでの本人確認（この端末の登録・利用開始・切り替えまでサーバーが行う）。成功したら true */
  async function authenticate(): Promise<boolean> {
    const opts = await api("auth-options");
    if (!opts.ok) {
      setMessage({ tone: "error", text: opts.error });
      return false;
    }
    let response;
    try {
      response = await startAuthentication({ optionsJSON: opts.data.options as never });
    } catch (e) {
      setMessage({ tone: "error", text: webauthnErrorMessage(e) });
      return false;
    }
    const verified = await api("auth-verify", { challengeId: opts.data.challengeId, response });
    if (!verified.ok) {
      setMessage({ tone: "error", text: verified.error });
      return false;
    }
    return handleDeviceStep(verified.data);
  }

  /** サーバーの「端末の登録・利用開始」の結果を画面に出す */
  function handleDeviceStep(data: Record<string, unknown>): boolean {
    if (data.kind === "ok") {
      setDeviceLimit(false);
      setEmailStep(null);
      setMessage({
        tone: "ok",
        text: data.tookOver
          ? "本人確認ができました。別の端末での利用を終了し、この端末で利用を開始しました。"
          : "本人確認ができました。この端末で有料プランの機能を使えます。",
      });
      return true;
    }
    if (data.kind === "email_required") {
      setEmailStep({ maskedEmail: String(data.maskedEmail ?? "登録しているメールアドレス"), sent: false });
      setEmailCode("");
      setMessage({ tone: "info", text: String(data.message) });
      return false;
    }
    if (data.kind === "device_limit") {
      setDeviceLimit(true);
      setMessage({ tone: "error", text: String(data.message) });
      router.refresh();
      return false;
    }
    setMessage({ tone: "error", text: String(data.message ?? "処理できませんでした。") });
    return false;
  }

  async function run(task: () => Promise<boolean>, after?: () => void) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const ok = await task();
      if (ok) {
        after?.();
        router.refresh();
      }
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  }

  /**
   * 直近の本人確認が必要な操作：必要なら先にパスキーで確認してから、もう一度行う。
   * 本人確認はサーバーで記録される（端末が上限でこの端末を登録できなかったときも、確認そのものは有効）
   */
  async function withVerification(action: string, body: Record<string, unknown>): Promise<ApiResult> {
    const first = await api(action, body);
    if (first.ok || first.code !== "verification_required") return first;
    setMessage({ tone: "info", text: "この操作の前に、パスキーで本人確認をします。" });
    await authenticate();
    return api(action, body);
  }

  async function registerPasskey(): Promise<boolean> {
    let opts = await api("register-options");
    if (!opts.ok && opts.code === "verification_required") {
      setMessage({ tone: "info", text: "パスキーを追加する前に、登録済みのパスキーで本人確認をします。" });
      await authenticate();
      opts = await api("register-options");
    }
    if (!opts.ok) {
      setMessage({ tone: "error", text: opts.error });
      return false;
    }
    let response;
    try {
      response = await startRegistration({ optionsJSON: opts.data.options as never });
    } catch (e) {
      setMessage({ tone: "error", text: webauthnErrorMessage(e) });
      return false;
    }
    const verified = await api("register-verify", { challengeId: opts.data.challengeId, response });
    if (!verified.ok) {
      setMessage({ tone: "error", text: verified.error });
      return false;
    }
    const ok = handleDeviceStep(verified.data);
    if (ok) setMessage({ tone: "ok", text: "パスキーを登録しました。この端末で有料プランの機能を使えます。" });
    return ok;
  }

  async function sendEmailCode(): Promise<boolean> {
    const r = await api("email-send");
    if (!r.ok) {
      setMessage({ tone: "error", text: r.error });
      if (r.code === "too_soon") setResendAt(Date.now() + 10_000);
      return false;
    }
    setEmailStep({ maskedEmail: String(r.data.maskedEmail ?? emailStep?.maskedEmail ?? ""), sent: true });
    setResendAt(Date.now() + 60_000);
    setNow(Date.now());
    setMessage({ tone: "info", text: `${String(r.data.maskedEmail)} に確認コードを送りました。メールに書かれた6桁の数字を入力してください（有効期限は10分です）。` });
    return false; // 画面の読み込み直しはしない（入力を続ける）
  }

  async function verifyEmailCode(): Promise<boolean> {
    const r = await api("email-verify", { code: emailCode });
    if (!r.ok) {
      setMessage({ tone: "error", text: r.error });
      if (r.code === "expired" || r.code === "locked" || r.code === "no_code") {
        setEmailCode("");
        setEmailStep((cur) => (cur ? { ...cur, sent: false } : cur));
      }
      return false;
    }
    return handleDeviceStep(r.data);
  }

  async function revoke(id: string): Promise<boolean> {
    const r = await withVerification("device-revoke", { deviceId: id });
    if (!r.ok) {
      setMessage({ tone: "error", text: r.error });
      return false;
    }
    if (deviceLimitRef.current) {
      // 上限で止まっていたときは、空いた枠にこの端末を登録する
      const reg = await api("device-register");
      if (!reg.ok) {
        setMessage({ tone: "error", text: reg.error });
        return true;
      }
      handleDeviceStep(reg.data);
      return true;
    }
    setMessage({ tone: "ok", text: "端末の登録を解除しました。" });
    return true;
  }

  async function removePasskey(id: string): Promise<boolean> {
    const r = await withVerification("credential-delete", { id });
    if (!r.ok) {
      setMessage({ tone: "error", text: r.error });
      return false;
    }
    const remaining = Number(r.data.remaining ?? 0);
    setMessage({
      tone: remaining === 0 && contractPaid ? "error" : "ok",
      text:
        remaining === 0 && contractPaid
          ? "パスキーを削除しました。パスキーがないため、もう一度登録するまで有料プランの機能は使えません。"
          : "パスキーを削除しました。",
    });
    return true;
  }

  const needsAction = status !== "ok" && status !== "not_paid" && status !== "disabled";
  const statusText = needsAction ? PAID_ACCESS_MESSAGE[status as keyof typeof PAID_ACCESS_MESSAGE] : null;

  return (
    <div className="flex flex-col gap-6" data-testid="passkey-manager" data-status={status}>
      {!supported && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          このブラウザはパスキーに対応していません。Safari・Chrome・Edgeなどの新しいブラウザでお試しください。
        </p>
      )}

      <section className="ms-glass flex flex-col gap-3 p-6">
        <h2 className="text-base font-bold text-ms-text">この端末の状態</h2>
        {status === "ok" && <p className="text-sm text-ms-text" data-testid="passkey-status-ok">この端末で、有料プランの機能をご利用中です。</p>}
        {status === "not_paid" && <p className="text-sm text-ms-muted">有料プランのご契約はありません（パスキーの登録は必要ありません）。</p>}
        {statusText && <p className="text-sm leading-relaxed text-ms-text">{statusText}</p>}
        <div className="flex flex-wrap gap-3">
          {status === "needs_passkey" && (
            <button type="button" className="ms-btn ms-btn-primary" disabled={busy || !supported} onClick={() => void run(registerPasskey)} data-testid="passkey-register">
              {busy ? "処理しています..." : "パスキーを登録する"}
            </button>
          )}
          {(status === "needs_device" || status === "needs_verification" || status === "in_use_elsewhere") && (
            <button type="button" className="ms-btn ms-btn-primary" disabled={busy || !supported} onClick={() => void run(authenticate)} data-testid="passkey-authenticate">
              {busy ? "処理しています..." : "パスキーで本人確認する"}
            </button>
          )}
          {status === "unavailable" && (
            <button type="button" className="ms-btn ms-btn-secondary" disabled={busy} onClick={() => router.refresh()}>
              もう一度確かめる
            </button>
          )}
          {next && status === "ok" && (
            <a href={next} className="ms-btn ms-btn-secondary" data-testid="passkey-back">
              元のページに戻る
            </a>
          )}
        </div>
        <div role="status" aria-live="polite" data-testid="passkey-message">
          {message && (
            <p
              className={`rounded-lg px-3 py-2 text-sm ${
                message.tone === "ok"
                  ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
                  : message.tone === "error"
                    ? "bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100"
                    : "bg-blue-50 text-blue-900 dark:bg-blue-950 dark:text-blue-100"
              }`}
            >
              {message.text}
            </p>
          )}
        </div>
      </section>

      {emailStep && (
        <section className="ms-glass flex flex-col gap-3 p-6" data-testid="email-step">
          <h2 className="text-base font-bold text-ms-text">メールの確認コード（新しい端末の登録）</h2>
          <p className="text-sm leading-relaxed text-ms-text">
            2台目以降の端末を登録するときは、本人確認のため、{emailStep.maskedEmail} に確認コードを送ります。
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="ms-btn ms-btn-secondary"
              disabled={busy || resendWaitSec > 0}
              onClick={() => void run(sendEmailCode)}
              data-testid="email-send"
            >
              {resendWaitSec > 0 ? `送り直しは${resendWaitSec}秒後` : emailStep.sent ? "確認コードを送り直す" : "確認コードを送る"}
            </button>
          </div>
          {emailStep.sent && (
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                void run(verifyEmailCode);
              }}
            >
              <label className="flex flex-col gap-1 text-sm text-ms-text">
                確認コード（6桁）
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={emailCode}
                  onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  className="w-40 rounded-lg border border-ms-border bg-white px-3 py-2 text-lg tracking-widest text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100"
                  data-testid="email-code"
                />
              </label>
              <button type="submit" className="ms-btn ms-btn-primary" disabled={busy || emailCode.length !== 6} data-testid="email-verify">
                確認して登録する
              </button>
            </form>
          )}
          <p className="text-xs leading-relaxed text-ms-muted">
            届かないときは、迷惑メールのフォルダもご確認ください。送り直しは60秒に1回、1時間に5通までです。コードは5回まで入力できます。
          </p>
        </section>
      )}

      <section className="ms-glass flex flex-col gap-3 p-6" data-testid="device-list">
        <h2 className="text-base font-bold text-ms-text">
          登録端末（{devices.length}/{MAX_DEVICES}台）
        </h2>
        {deviceLimit && (
          <p className="text-sm text-ms-text">解除する端末を選んでください。解除すると、続けてこの端末を登録します。</p>
        )}
        {devices.length === 0 ? (
          <p className="text-sm text-ms-muted">まだ登録された端末はありません。パスキーで本人確認をすると、この端末が登録されます。</p>
        ) : (
          <ul className="flex flex-col divide-y divide-ms-border">
            {devices.map((d) => (
              <li key={d.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between" data-testid="device-item">
                <div className="text-sm">
                  <p className="font-medium text-ms-text">
                    {d.label}
                    {d.current && <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-800 dark:bg-blue-900 dark:text-blue-100">この端末</span>}
                  </p>
                  <p className="text-xs text-ms-muted">
                    登録：{formatDateTime(d.createdAt)}　最終利用：{formatDateTime(d.lastSeenAt)}
                  </p>
                </div>
                {confirming === `device:${d.id}` ? (
                  <div className="flex gap-2">
                    <button type="button" className="ms-btn ms-btn-primary" disabled={busy} onClick={() => void run(() => revoke(d.id))} data-testid="device-revoke-confirm">
                      解除する
                    </button>
                    <button type="button" className="ms-btn ms-btn-secondary" disabled={busy} onClick={() => setConfirming(null)}>
                      やめる
                    </button>
                  </div>
                ) : (
                  <button type="button" className="ms-btn ms-btn-secondary self-start" disabled={busy} onClick={() => setConfirming(`device:${d.id}`)} data-testid="device-revoke">
                    登録を解除
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="ms-glass flex flex-col gap-3 p-6" data-testid="passkey-list">
        <h2 className="text-base font-bold text-ms-text">パスキー（{credentials.length}個）</h2>
        <p className="text-xs leading-relaxed text-ms-muted">
          パスキーは、iCloudキーチェーン・Googleパスワードマネージャーなどで、同じアカウントの別の端末にも同期されることがあります。
          同期されていても、有料プランを使えるのは登録端末（最大{MAX_DEVICES}台）だけです。表示名は目安で、保存先を正確に判別できないことがあります。
        </p>
        {credentials.length > 0 && (
          <ul className="flex flex-col divide-y divide-ms-border">
            {credentials.map((c) => (
              <li key={c.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between" data-testid="passkey-item">
                <div className="text-sm">
                  <p className="font-medium text-ms-text">{c.label}</p>
                  <p className="text-xs text-ms-muted">
                    登録：{formatDateTime(c.createdAt)}　最終利用：{formatDateTime(c.lastUsedAt)}
                  </p>
                </div>
                {confirming === `passkey:${c.id}` ? (
                  <div className="flex gap-2">
                    <button type="button" className="ms-btn ms-btn-primary" disabled={busy} onClick={() => void run(() => removePasskey(c.id))} data-testid="passkey-delete-confirm">
                      削除する
                    </button>
                    <button type="button" className="ms-btn ms-btn-secondary" disabled={busy} onClick={() => setConfirming(null)}>
                      やめる
                    </button>
                  </div>
                ) : (
                  <button type="button" className="ms-btn ms-btn-secondary self-start" disabled={busy} onClick={() => setConfirming(`passkey:${c.id}`)} data-testid="passkey-delete">
                    削除
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {credentials.length > 0 && (
          <button type="button" className="ms-btn ms-btn-secondary self-start" disabled={busy || !supported} onClick={() => void run(registerPasskey)} data-testid="passkey-add">
            パスキーを追加する
          </button>
        )}
      </section>
    </div>
  );
}
