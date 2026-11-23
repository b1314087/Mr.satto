"use client";

import { useEffect, useRef, useState } from "react";
import { ErrorMessage } from "@/components/common/error-message";
import { FORM_CONSENT_VERSION, FORM_MAX_IMAGE_PAGES, type FormExtractRow } from "@/lib/ai/form-extract";
import type { AiModelTier } from "@/lib/ai/pricing";
import type { PersonRecord } from "@/lib/pdf-template/person-extraction";
import type { Template } from "@/lib/pdf-template/types";
import { batchRegionItems, buildRegionAiItems, type RegionAiItem } from "@/lib/pdf-template/region-ai";
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
} from "../shared/ai-panel-parts";

/**
 * 記入済みPDF→Excelの「指定した場所をAIで読み取る」（プレミアム・2026-11-20）。
 *
 * - AIに送るのは、利用者が囲んだ枠（と、字が切れないための少しの余白）の画像だけ（ページ全体・PDFファイルそのものは送らない）。
 * - 送る画像は、実行の前に画面に出して見せ、実行のたびに同意を取る。
 * - 結果は、下の一覧の欄にそのまま入る（利用者が確かめて直してから、Excelにする）。
 * - 量が多いときは、4件ずつ自動で分けて順に送る。途中で利用枠が足りなくなったら、そこまでの結果を残す。
 */

type UsageState =
  | { status: "loading" }
  | ({ status: "available" } & AiUsage)
  | { status: "unavailable"; reason: "login_required" | "not_premium" | "unavailable" };

const UNAVAILABLE_TEXT: Record<"login_required" | "not_premium" | "unavailable", string> = {
  login_required: "指定した場所をAIで読み取るには、ログインが必要です。",
  not_premium: "指定した場所をAIで読み取るのは、プレミアムプランの機能です。",
  unavailable: "AIによる読み取りは、現在ご利用いただけません。下の一覧は、そのまま使えます。",
};

export interface RegionAiUpdate {
  recordId: string;
  fieldIndex: number;
  value: string;
}

function newRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function RegionAiPanel({
  records,
  template,
  files,
  defaultOpen = false,
  onApply,
}: {
  records: PersonRecord[];
  template: Template;
  files: File[];
  defaultOpen?: boolean;
  onApply: (updates: RegionAiUpdate[]) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [usage, setUsage] = useState<UsageState>({ status: "loading" });
  const [items, setItems] = useState<RegionAiItem[] | null>(null);
  const [preparing, setPreparing] = useState<{ done: number; total: number } | null>(null);
  const [tier, setTier] = useState<AiModelTier>("standard");
  const [consent, setConsent] = useState(false);
  const [running, setRunning] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [doneCount, setDoneCount] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // 一覧の欄を利用者が直しても、送る画像は作り直さない（作り直すのは、件や欄の読み取り方が変わったときだけ）
  const recordsKey = records.map((r) => `${r.id}:${r.fields.map((f) => f.method).join(",")}`).join("|");

  useEffect(() => () => abortRef.current?.abort(), []);

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

  // 送る画像を作る（この端末の中だけで行う。AIには送らない）
  useEffect(() => {
    if (!open || usage.status !== "available") return;
    const signal = { cancelled: false };
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setItems(null);
    setPreparing({ done: 0, total: 0 });
    void buildRegionAiItems({ records, template, files, signal, onProgress: (done, total) => !signal.cancelled && setPreparing({ done, total }) })
      .then((built) => {
        if (!signal.cancelled) setItems(built);
      })
      .catch(() => {
        if (!signal.cancelled) setError("指定した場所の画像を作れませんでした。");
      })
      .finally(() => {
        if (!signal.cancelled) setPreparing(null);
      });
    return () => {
      signal.cancelled = true;
    };
    // recordsKey が変わったときだけ作り直す
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, usage.status, recordsKey]);

  useEffect(() => {
    if (!running) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSeconds(0);
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  const batches = items ? batchRegionItems(items, FORM_MAX_IMAGE_PAGES) : [];
  const canRun = usage.status === "available" && !!items && items.length > 0 && consent && !running;

  async function run() {
    if (!canRun || !items) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setError(null);
    setNotes([]);
    setDoneCount(null);
    setProgress({ done: 0, total: batches.length });
    const updates: RegionAiUpdate[] = [];
    const allNotes: string[] = [];
    let readCount = 0;
    try {
      for (const [bi, batch] of batches.entries()) {
        const timer = setTimeout(() => controller.abort(), 130_000);
        let data: Record<string, unknown> | null = null;
        let ok = false;
        try {
          const res = await fetch("/api/ai/form-extract", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            cache: "no-store",
            signal: controller.signal,
            body: JSON.stringify({
              requestId: newRequestId(),
              model: tier,
              purpose: "region",
              fields: batch[0].labels,
              // ページ番号は、この依頼の中の通し番号（1件＝1ページ）。画像は枠の中だけ
              pages: batch.map((it, i) => ({ page: i + 1, text: it.hint, image: { mediaType: it.image.mediaType, base64: it.image.base64 } })),
              consent: { accepted: true, version: FORM_CONSENT_VERSION },
            }),
          });
          data = await res.json().catch(() => null);
          ok = res.ok && data?.ok === true;
        } finally {
          clearTimeout(timer);
        }
        if (data?.usage) setUsage((u) => (u.status === "available" ? { ...u, ...(data!.usage as Partial<AiUsage>) } : u));
        if (!ok) {
          const message = typeof data?.message === "string" ? data.message : "AIによる読み取りに失敗しました。下の一覧は、そのまま使えます。";
          setError(bi > 0 ? `${message}（${readCount}件分の結果は、下の一覧に入れました）` : message);
          break;
        }
        for (const row of data!.rows as FormExtractRow[]) {
          const it = batch[row.page - 1];
          if (!it) continue;
          readCount++;
          it.fieldIndexes.forEach((fieldIndex, i) => updates.push({ recordId: it.recordId, fieldIndex, value: row.cells[i] ?? "" }));
        }
        if (Array.isArray(data!.notes)) for (const n of data!.notes as string[]) if (allNotes.length < 10) allNotes.push(n);
        setProgress({ done: bi + 1, total: batches.length });
      }
    } catch (e) {
      setError(
        e instanceof DOMException && e.name === "AbortError"
          ? "AIの応答を待つ時間を超えたか、中止したため、止めました。"
          : "通信に失敗しました。下の一覧は、そのまま使えます。",
      );
    } finally {
      if (updates.length > 0) onApply(updates);
      setDoneCount(readCount);
      setNotes(allNotes);
      abortRef.current = null;
      setRunning(false);
      setProgress(null);
      setConsent(false);
    }
  }

  return (
    <section data-testid="region-ai-panel" className={AI_PANEL_CLASS}>
      <AiPanelHeader
        title="指定した場所をAIで読み取る（プレミアム）"
        sub="囲んだ枠の中だけをAIが読み取り、下の一覧に入れます（手書きも読めます）"
        action={
          <button
            type="button"
            data-testid="region-ai-toggle"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="rounded-lg border border-violet-300 bg-white px-3 py-1.5 text-xs font-semibold text-violet-800 hover:bg-violet-50 dark:border-violet-700 dark:bg-neutral-900 dark:text-violet-200"
          >
            {open ? "閉じる" : "開く"}
          </button>
        }
      />
      {open && (
        <div className="mt-3 flex flex-col gap-4">
          {usage.status === "loading" && <p className="text-sm text-neutral-600 dark:text-neutral-300">利用状況を確認しています…</p>}
          {usage.status === "unavailable" && <AiUnavailableNotice reason={usage.reason} text={UNAVAILABLE_TEXT[usage.reason]} loginNext="/tools/filled-pdf-to-excel" />}
          {usage.status === "available" && (
            <>
              <AiUsageMeter usage={usage} />
              {preparing && (
                <p data-testid="region-ai-preparing" className="text-sm text-neutral-600 dark:text-neutral-300">
                  枠の中の画像を作っています…{preparing.total > 0 ? `（${preparing.done} / ${preparing.total}件）` : ""}（この端末の中だけで行います）
                </p>
              )}
              {items && items.length === 0 && (
                <p data-testid="region-ai-nothing" className="rounded-lg bg-white px-3 py-2 text-sm text-neutral-800 dark:bg-neutral-900 dark:text-neutral-100">
                  AIで読み取る欄はありません（すべての欄を、PDFの中の文字から読み取れました）。
                </p>
              )}
              {items && items.length > 0 && (
                <>
                  <div className="flex flex-col gap-2">
                    <StepLabel n={1} hint="この画像（囲んだ枠と、そのまわりの少しの余白だけ）をAIに送ります。赤い四角が囲んだ場所です">送る内容の確認</StepLabel>
                    <p data-testid="region-ai-count" className="text-xs text-neutral-600 dark:text-neutral-300">
                      送る件数：{items.length}件（1件＝枠を上から並べた画像1枚）
                      {batches.length > 1 ? ` ／ ${batches.length}回に分けて順に送ります（AI利用枠を、送る量に応じて使います）` : ""}
                    </p>
                    <div className="max-h-72 overflow-auto rounded border border-violet-200 bg-white p-2 dark:border-violet-800 dark:bg-neutral-950">
                      {items.map((it) => (
                        <div key={it.recordId} className="mb-3 last:mb-0">
                          <p className="text-[11px] font-semibold text-violet-800 dark:text-violet-200">
                            {it.label}：{it.labels.join("・")}
                          </p>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            data-testid="region-ai-image"
                            src={`data:${it.image.mediaType};base64,${it.image.base64}`}
                            alt={`AIに送る${it.label}の枠の画像`}
                            className="mt-1 max-h-48 w-auto max-w-full rounded border border-neutral-200 dark:border-neutral-800"
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-col gap-2">
                    <StepLabel n={2}>読み取りの種類</StepLabel>
                    <TierPicker
                      name="region-ai-tier"
                      value={tier}
                      onChange={setTier}
                      standardTestId="region-ai-tier-standard"
                      advancedTestId="region-ai-tier-advanced"
                      advancedHint="手書きの読み違いが多いとき用"
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <StepLabel n={3}>同意して実行</StepLabel>
                    <ConsentBox testId="region-ai-consent" checked={consent} onChange={setConsent}>
                      上の画像（囲んだ枠と、そのまわりの少しの余白だけ）を、AI（OpenAI）に送って読み取ることに同意します
                    </ConsentBox>
                    <AiRunButton
                      testId="region-ai-run"
                      cancelTestId="region-ai-cancel"
                      disabled={!canRun}
                      running={running}
                      label="AIで読み取る"
                      consentGiven={consent}
                      onClick={() => void run()}
                      onCancel={() => abortRef.current?.abort()}
                    />
                    {running && <AiProgress testId="region-ai-progress" seconds={seconds} />}
                    {running && progress && progress.total > 1 && (
                      <p data-testid="region-ai-batch-progress" role="status" className="text-xs text-violet-900 dark:text-violet-100">
                        {progress.done} / {progress.total} 回目まで終わりました
                      </p>
                    )}
                  </div>
                </>
              )}
              {error && (
                <div data-testid="region-ai-error">
                  <ErrorMessage message={error} />
                </div>
              )}
              {doneCount !== null && doneCount > 0 && (
                <p data-testid="region-ai-done" role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                  {doneCount}件をAIで読み取り、下の一覧に入れました。AIは読み違えることがあるので、元のPDFと見比べて確かめてから、Excelをダウンロードしてください。
                </p>
              )}
              {notes.map((n, i) => (
                <p key={i} data-testid="region-ai-note" className="rounded-lg bg-white px-3 py-2 text-xs text-neutral-800 dark:bg-neutral-900 dark:text-neutral-100">
                  AIからの注意：{n}
                </p>
              ))}
            </>
          )}
        </div>
      )}
    </section>
  );
}
