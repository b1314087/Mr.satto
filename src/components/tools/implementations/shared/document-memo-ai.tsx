"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { ErrorMessage } from "@/components/common/error-message";
import { featureFlags } from "@/lib/config/features";
import {
  DOC_MEMO_CONSENT_VERSION,
  DOC_MEMO_MAX_CHARS,
  docMemoToMemoText,
  type DocMemoField,
  type DocMemoItem,
  type DocMemoType,
} from "@/lib/ai/document-memo";
import type { AiModelTier } from "@/lib/ai/pricing";
import {
  AI_PANEL_CLASS,
  AiPanelHeader,
  AiProgress,
  AiRunButton,
  AiUnavailableNotice,
  AiUsageMeter,
  ConsentBox,
  StepLabel,
  TierPicker,
  type AiUsage,
} from "./ai-panel-parts";

/**
 * 見積書・注文書・請求書作成の「AIでメモの形に整える」補助（プレミアム・任意）。
 *
 * - 上のメモ欄に貼り付けた文章（メール・箇条書きなど、決まった書き方でなくてよい）を、AIが「項目名：中身」のメモに整え、メモ欄を書き換える。
 * - 入力欄に入るのは、利用者が整ったメモを確かめて「メモから入力する」を押したとき（AIを使わない従来の読み取り）。
 * - 送るのは、メモ欄の文章だけ。実行のたびに、送る内容を確かめて同意してもらう。
 * - 原文に見つからない値は一覧で知らせる（AIが作った・読み違えた可能性がある）。
 */

type UsageState =
  | { status: "loading" }
  | ({ status: "available" } & AiUsage)
  | { status: "unavailable"; reason: "login_required" | "not_premium" | "unavailable" };

const UNAVAILABLE_TEXT: Record<"login_required" | "not_premium" | "unavailable", string> = {
  login_required: "AIでメモの形に整えるには、ログインが必要です。",
  not_premium: "AIでメモの形に整える機能は、プレミアムプランの機能です。決まった書き方のメモは、そのまま「メモから入力する」で使えます。",
  unavailable: "AIでメモの形に整える機能は、現在ご利用いただけません。決まった書き方のメモは、そのまま「メモから入力する」で使えます。",
};

function newRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** AIの補助を、画面に出すか（課金システムがオンの間だけ） */
export function documentMemoAiEnabled(): boolean {
  return featureFlags.billing;
}

export function DocumentMemoAi({
  docType,
  text,
  onMemo,
}: {
  docType: DocMemoType;
  /** メモ欄の今の文章（これをAIに送る） */
  text: string;
  /** 整えたメモで、メモ欄を書き換える */
  onMemo: (memo: string) => void;
}) {
  // ログインのあと、このツールのページに戻す
  const loginNext = usePathname() ?? "/tools";
  const [open, setOpen] = useState(false);
  const [usage, setUsage] = useState<UsageState>({ status: "loading" });
  const [tier, setTier] = useState<AiModelTier>("standard");
  const [consent, setConsent] = useState(false);
  const [running, setRunning] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ fields: DocMemoField[]; items: DocMemoItem[]; notes: string[]; rejected: number; original: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  // 開いたときに、利用状況を取得する（AIは呼ばない）
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/ai/usage", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data?.available && data.usage) setUsage({ status: "available", ...data.usage });
        else setUsage({ status: "unavailable", reason: data?.reason === "login_required" || data?.reason === "not_premium" ? data.reason : "unavailable" });
      })
      .catch(() => {
        if (!cancelled) setUsage({ status: "unavailable", reason: "unavailable" });
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // 送る文章が変わったら、前の同意は使わない（同意した内容と、送る内容を一致させる）
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConsent(false);
  }, [text]);

  useEffect(() => {
    if (!running) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSeconds(0);
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  const trimmed = text.trim();
  const tooLong = text.length > DOC_MEMO_MAX_CHARS;
  const canRun = usage.status === "available" && trimmed !== "" && !tooLong && consent && !running;

  async function run() {
    if (!canRun) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const timer = setTimeout(() => controller.abort(), 70_000);
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/ai/document-memo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        signal: controller.signal,
        body: JSON.stringify({
          requestId: newRequestId(),
          model: tier,
          docType,
          text,
          consent: { accepted: true, version: DOC_MEMO_CONSENT_VERSION },
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        setError(typeof data?.message === "string" ? data.message : "AIでメモの形に整えられませんでした。決まった書き方のメモは、そのまま使えます。");
        if (data?.usage) setUsage((u) => (u.status === "available" ? { ...u, ...data.usage } : u));
        return;
      }
      const fields = (data.fields ?? []) as DocMemoField[];
      const items = (data.items ?? []) as DocMemoItem[];
      setOutcome({ fields, items, notes: Array.isArray(data.notes) ? data.notes : [], rejected: typeof data.rejected === "number" ? data.rejected : 0, original: text });
      if (fields.length > 0 || items.length > 0) onMemo(docMemoToMemoText({ fields, items }));
      if (data.usage) setUsage({ status: "available", ...data.usage });
    } catch (e) {
      setError(e instanceof DOMException && e.name === "AbortError" ? "AIの応答を待つ時間を超えたため、中止しました。" : "通信に失敗しました。");
    } finally {
      clearTimeout(timer);
      abortRef.current = null;
      setRunning(false);
      setConsent(false);
    }
  }

  const unverified = outcome ? [...outcome.fields.filter((f) => f.unverified).map((f) => `${f.label}：${f.value}`), ...outcome.items.filter((i) => i.unverified).map((i) => `明細：${i.name}`)] : [];

  return (
    <div data-testid="memo-ai-panel" className={AI_PANEL_CLASS}>
      <AiPanelHeader
        title="AIでメモの形に整える（任意）"
        sub="メールの文面や箇条書きなど、決まった書き方でない文章から、AIが宛先・明細などを取り出して、上のメモの形に整えます"
        action={
          <button
            type="button"
            data-testid="memo-ai-toggle"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="rounded-lg border border-violet-400 bg-white px-3 py-1.5 text-sm font-medium text-violet-900 hover:bg-violet-50 dark:border-violet-600 dark:bg-neutral-900 dark:text-violet-100 dark:hover:bg-violet-950"
          >
            {open ? "閉じる" : "使ってみる"}
          </button>
        }
      />
      {open && (
        <>
          {usage.status === "loading" && <p className="text-sm text-neutral-600 dark:text-neutral-300">利用状況を確認しています…</p>}
          {usage.status === "unavailable" && <AiUnavailableNotice reason={usage.reason} text={UNAVAILABLE_TEXT[usage.reason]} loginNext={loginNext} />}
          {usage.status === "available" && (
            <>
              <AiUsageMeter usage={usage} />
              <div className="flex flex-col gap-1" data-testid="memo-ai-preview">
                <StepLabel n={1} hint="上のメモ欄の文章だけをAIに送ります">送る内容の確認</StepLabel>
                {trimmed === "" ? (
                  <p className="text-sm text-neutral-600 dark:text-neutral-300">上のメモ欄に、メールの文面などを貼り付けてください。</p>
                ) : (
                  <>
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded border border-violet-200 bg-white p-2 font-sans text-xs text-neutral-800 dark:border-violet-800 dark:bg-neutral-950 dark:text-neutral-100">{text}</pre>
                    <p data-testid="memo-ai-count" className={`text-xs ${tooLong ? "font-semibold text-red-700 dark:text-red-300" : "text-neutral-700 dark:text-neutral-200"}`}>
                      送る文字：{text.length.toLocaleString("ja-JP")}文字（{DOC_MEMO_MAX_CHARS.toLocaleString("ja-JP")}文字まで）
                    </p>
                  </>
                )}
              </div>
              {trimmed !== "" && !tooLong && (
                <>
                  <div className="flex flex-col gap-2">
                    <StepLabel n={2}>読み取りの種類</StepLabel>
                    <TierPicker
                      name="memo-ai-tier"
                      value={tier}
                      onChange={setTier}
                      standardTestId="memo-ai-tier-standard"
                      advancedTestId="memo-ai-tier-advanced"
                      advancedHint="標準で取り出せなかったときの再確認用"
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <StepLabel n={3}>同意して実行</StepLabel>
                    <ConsentBox testId="memo-ai-consent" checked={consent} onChange={setConsent}>
                      上の文章を、AI（OpenAI）に送って、メモの形に整えることに同意します
                    </ConsentBox>
                    <AiRunButton
                      testId="memo-ai-run"
                      cancelTestId="memo-ai-cancel"
                      disabled={!canRun}
                      running={running}
                      label="AIでメモの形に整える"
                      consentGiven={consent}
                      onClick={() => void run()}
                      onCancel={() => abortRef.current?.abort()}
                    />
                    {running && <AiProgress testId="memo-ai-progress" seconds={seconds} />}
                  </div>
                </>
              )}
              {error && <ErrorMessage message={error} testId="memo-ai-error" />}
              {outcome && (
                <div className="flex flex-col gap-2" data-testid="memo-ai-result">
                  {outcome.fields.length + outcome.items.length === 0 ? (
                    <p data-testid="memo-ai-empty" className="rounded-lg bg-white px-3 py-2 text-sm dark:bg-neutral-900">書類に入れる項目が見つかりませんでした。メモ欄はそのままです。</p>
                  ) : (
                    <p className="rounded-lg bg-white px-3 py-2 text-sm text-neutral-800 dark:bg-neutral-900 dark:text-neutral-100">
                      上のメモ欄を、整えたメモ（{outcome.fields.length}項目・明細{outcome.items.length}行）に書き換えました。内容を確かめてから「メモから入力する」を押してください。
                    </p>
                  )}
                  {outcome.notes.map((n, i) => (
                    <p key={i} data-testid="memo-ai-note" className="rounded-lg bg-white px-3 py-2 text-xs text-neutral-800 dark:bg-neutral-900 dark:text-neutral-100">
                      AIからの注意：{n}
                    </p>
                  ))}
                  {unverified.length > 0 && (
                    <div data-testid="memo-ai-unverified" role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                      <p className="font-semibold">次の値は、元の文章の中に見つかりませんでした。AIが読み違えた可能性があるので、確かめてください。</p>
                      <ul className="mt-1 list-disc pl-5">
                        {unverified.map((u) => (
                          <li key={u} className="break-all">
                            {u}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {outcome.rejected > 0 && <p className="text-xs text-neutral-600 dark:text-neutral-300">形式が正しくなかった{outcome.rejected}件は、使っていません。</p>}
                  {(outcome.fields.length > 0 || outcome.items.length > 0) && (
                    <button
                      type="button"
                      data-testid="memo-ai-undo"
                      onClick={() => {
                        onMemo(outcome.original);
                        setOutcome(null);
                      }}
                      className="w-fit rounded-lg border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 hover:border-violet-400 dark:border-neutral-700 dark:text-neutral-300"
                    >
                      元の文章に戻す
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
