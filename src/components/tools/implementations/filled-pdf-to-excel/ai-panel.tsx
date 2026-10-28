"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ResultPopup } from "@/components/common/result-popup";
import { ErrorMessage } from "@/components/common/error-message";
import { featureFlags } from "@/lib/config/features";
import { FORM_CONSENT_VERSION, FORM_MAX_CHARS_TOTAL, FORM_MAX_PAGES, type FormExtractRow } from "@/lib/ai/form-extract";
import type { AiModelTier } from "@/lib/ai/pricing";
import { writeXlsxSheets } from "@/lib/excel/xlsx-simple-io";
import { loadPdfDocument, getPositionedTextItems, pageHasText, type PositionedTextItem } from "@/lib/pdf/pdfjs-client";
import { groupIntoLines } from "@/lib/pdf/table-reconstruction";
import { downloadBlob, stripExtension } from "@/lib/utils/format";
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
 * 記入済みPDF→Excel の「AIで読み取る」補助（プレミアム）。
 *
 * - 従来の自動抽出・テンプレートは、このパネルを開かなくても、すべて今までどおり動く（AIは任意）。
 * - AIに送るのは、PDFから取り出した「文字」だけ（5ページ・6,000文字まで）。PDFファイルそのもの・画像は送らない。
 * - 文字として読めるPDFだけが対象。スキャンPDFは、従来の変換（OCR）をお使いください。
 * - 送る内容を画面に出し、実行のたびに同意を取る。
 * - AIの結果は「提案」。原文に見つからない文字は目立たせ、利用者が直してから、Excelにする。
 */

type UsageState =
  | { status: "loading" }
  | ({ status: "available" } & AiUsage)
  | { status: "unavailable"; reason: "login_required" | "not_premium" | "unavailable" };

type TextState =
  | { status: "idle" }
  | { status: "reading" }
  | { status: "ready"; pages: { page: number; text: string }[]; chars: number }
  | { status: "problem"; message: string };

interface DraftRow {
  id: number;
  page: number;
  kind: FormExtractRow["kind"];
  cells: string[];
  unverified: Set<number>;
}

const UNAVAILABLE_TEXT: Record<"login_required" | "not_premium" | "unavailable", string> = {
  login_required: "AIによる読み取り補助を使うには、ログインが必要です。",
  not_premium: "AIによる読み取り補助は、プレミアムプランの機能です。",
  unavailable: "AIによる読み取り補助は、現在ご利用いただけません。ほかの変換は、そのまま使えます。",
};

function newRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 座標つきの文字から、行ごとの文字にする（行は改行、同じ行の離れた文字はタブで区切る） */
export function itemsToPageText(items: PositionedTextItem[]): string {
  return groupIntoLines(items)
    .map((line) => {
      let out = "";
      let prevEnd: number | null = null;
      for (const item of line.items) {
        const gap = prevEnd === null ? 0 : item.x - prevEnd;
        if (prevEnd !== null && gap > Math.max(3, item.fontHeight * 0.8)) out += "\t";
        out += item.str;
        prevEnd = item.x + item.width;
      }
      return out.trim();
    })
    .filter((line) => line !== "")
    .join("\n");
}

export function FilledPdfAiPanel({ files, totalPages }: { files: File[]; totalPages: number | null }) {
  const [open, setOpen] = useState(false);
  const [usage, setUsage] = useState<UsageState>({ status: "loading" });
  const [text, setText] = useState<TextState>({ status: "idle" });
  const [tier, setTier] = useState<AiModelTier>("standard");
  const [consent, setConsent] = useState(false);
  const [running, setRunning] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<DraftRow[] | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [rejected, setRejected] = useState(0);
  const [excel, setExcel] = useState<{ blob: Blob; name: string; rowCount: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const eligibleFile = files.length === 1 ? files[0] : null;
  const pageLimitProblem =
    files.length > 1
      ? "AIで読み取れるのは、1つのPDFだけです。ほかのファイルを外してください。"
      : totalPages !== null && totalPages > FORM_MAX_PAGES
        ? `AIで読み取れるのは${FORM_MAX_PAGES}ページまでです（このPDFは${totalPages}ページ）。`
        : null;

  useEffect(() => () => abortRef.current?.abort(), []);

  // PDFを替えたら、前の結果・同意は引き継がない
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRows(null);
    setNotes([]);
    setRejected(0);
    setExcel(null);
    setError(null);
    setConsent(false);
    setText({ status: "idle" });
  }, [eligibleFile]);

  // パネルを開いたときに、利用状況を取得する（AIは呼ばない）
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

  // パネルを開いたときに、送る文字を取り出す（この端末の中だけで行う。AIには送らない）
  useEffect(() => {
    if (!open || !eligibleFile || pageLimitProblem) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setText({ status: "reading" });
    (async () => {
      try {
        const pdf = await loadPdfDocument(eligibleFile);
        const pages: { page: number; text: string }[] = [];
        for (let p = 1; p <= pdf.numPages; p++) {
          const items = await getPositionedTextItems(await pdf.getPage(p));
          if (!pageHasText(items)) {
            if (!cancelled) setText({ status: "problem", message: `${p}ページ目に文字がありません（スキャンした画像のPDFです）。AIには送れません。従来の変換（OCR）をお使いください。` });
            return;
          }
          pages.push({ page: p, text: itemsToPageText(items) });
        }
        const chars = pages.reduce((sum, pg) => sum + pg.text.length, 0);
        if (cancelled) return;
        if (chars > FORM_MAX_CHARS_TOTAL) {
          setText({ status: "problem", message: `文字が多すぎます（${chars.toLocaleString("ja-JP")}文字。送れるのは${FORM_MAX_CHARS_TOTAL.toLocaleString("ja-JP")}文字まで）。ページを減らしたPDFでお試しください。` });
          return;
        }
        setText({ status: "ready", pages, chars });
      } catch {
        if (!cancelled) setText({ status: "problem", message: "PDFの文字を取り出せませんでした。" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, eligibleFile, pageLimitProblem]);

  // 経過時間（読み取り中だけ）
  useEffect(() => {
    if (!running) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSeconds(0);
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  const canRun = usage.status === "available" && text.status === "ready" && consent && !running;
  const sendPages = text.status === "ready" ? text.pages : [];
  const unverifiedTotal = useMemo(() => (rows ?? []).reduce((sum, r) => sum + r.unverified.size, 0), [rows]);

  async function run() {
    if (!canRun || text.status !== "ready") return;
    const controller = new AbortController();
    abortRef.current = controller;
    const timer = setTimeout(() => controller.abort(), 130_000);
    setRunning(true);
    setError(null);
    setExcel(null);
    try {
      const res = await fetch("/api/ai/form-extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        signal: controller.signal,
        body: JSON.stringify({
          requestId: newRequestId(),
          model: tier,
          pages: text.pages,
          consent: { accepted: true, version: FORM_CONSENT_VERSION },
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        setError(typeof data?.message === "string" ? data.message : "AIによる読み取りに失敗しました。ほかの変換は、そのまま使えます。");
        if (data?.usage) setUsage((u) => (u.status === "available" ? { ...u, ...data.usage } : u));
        return;
      }
      const incoming = (data.rows as FormExtractRow[]).map((r, i) => ({ id: i, page: r.page, kind: r.kind, cells: [...r.cells], unverified: new Set(r.unverified) }));
      setRows(incoming);
      setNotes(Array.isArray(data.notes) ? (data.notes as string[]) : []);
      setRejected(typeof data.rejected === "number" ? data.rejected : 0);
      if (data.usage) setUsage({ status: "available", ...data.usage });
    } catch (e) {
      setError(
        e instanceof DOMException && e.name === "AbortError"
          ? "AIの応答を待つ時間を超えたため、中止しました。ほかの変換は、そのまま使えます。"
          : "通信に失敗しました。ほかの変換は、そのまま使えます。",
      );
    } finally {
      clearTimeout(timer);
      abortRef.current = null;
      setRunning(false);
      // 同意は毎回確認する（実行のたびに外れる）
      setConsent(false);
    }
  }

  function updateCell(id: number, col: number, value: string) {
    setExcel(null);
    setRows((prev) =>
      (prev ?? []).map((r) => {
        if (r.id !== id) return r;
        const cells = [...r.cells];
        cells[col] = value;
        // 利用者が書き直した文字は、確認済みとして扱う
        const unverified = new Set(r.unverified);
        unverified.delete(col);
        return { ...r, cells, unverified };
      }),
    );
  }

  function removeRow(id: number) {
    setExcel(null);
    setRows((prev) => (prev ?? []).filter((r) => r.id !== id));
  }

  async function makeExcel() {
    if (!rows || rows.length === 0 || !eligibleFile) return;
    const sheetRows = rows.map((r) => r.cells.map((c) => (r.kind === "header" ? { value: c, fontWeight: "bold" } : c)));
    try {
      const blob = await writeXlsxSheets([{ name: "AI読み取り", rows: sheetRows }]);
      setExcel({ blob, name: `${stripExtension(eligibleFile.name)}_AI読み取り.xlsx`, rowCount: rows.length });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Excelファイルの生成に失敗しました");
    }
  }

  const maxColumns = (rows ?? []).reduce((m, r) => Math.max(m, r.cells.length), 0);

  return (
    <div data-testid="form-ai-panel" className={AI_PANEL_CLASS}>
      <AiPanelHeader
        title="AIで項目を読み取る（任意）"
        sub="文字のPDFを、AIが項目ごとの表に整理します"
        action={
          <button
            type="button"
            data-testid="form-ai-toggle"
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
          {usage.status === "unavailable" && (
            <AiUnavailableNotice reason={usage.reason} text={UNAVAILABLE_TEXT[usage.reason]} loginNext="/tools/filled-pdf-to-excel" />
          )}

          {usage.status === "available" && (
            <>
              <AiUsageMeter usage={usage} />

              {pageLimitProblem && (
                <p data-testid="form-ai-problem" role="alert" className="rounded-lg bg-white px-3 py-2 text-sm text-red-700 dark:bg-neutral-900 dark:text-red-300">
                  {pageLimitProblem}
                </p>
              )}
              {text.status === "reading" && <p className="text-sm text-neutral-600 dark:text-neutral-300">PDFの文字を取り出しています…（この端末の中だけで行います）</p>}
              {text.status === "problem" && (
                <p data-testid="form-ai-problem" role="alert" className="rounded-lg bg-white px-3 py-2 text-sm text-red-700 dark:bg-neutral-900 dark:text-red-300">
                  {text.message}
                </p>
              )}

              {text.status === "ready" && (
                <>
                  <div className="flex flex-col gap-1" data-testid="form-ai-preview">
                    <StepLabel n={1} hint="この文字だけをAIに送ります">送る内容の確認</StepLabel>
                    <div className="max-h-56 overflow-auto rounded border border-violet-200 bg-white p-2 dark:border-violet-800 dark:bg-neutral-950">
                      {sendPages.map((pg) => (
                        <div key={pg.page} className="mb-2 last:mb-0">
                          <p className="text-[11px] font-semibold text-violet-800 dark:text-violet-200">{pg.page}ページ目</p>
                          <pre className="whitespace-pre-wrap break-all font-sans text-xs text-neutral-800 dark:text-neutral-100">{pg.text}</pre>
                        </div>
                      ))}
                    </div>
                    <p data-testid="form-ai-count" className="text-xs text-neutral-700 dark:text-neutral-200">
                      送るページ：{sendPages.length}ページ ／ 送る文字：{text.chars.toLocaleString("ja-JP")}文字
                    </p>
                    <p className="text-xs text-neutral-600 dark:text-neutral-300">PDFファイルそのもの・画像は送りません。</p>
                  </div>

                  <div className="flex flex-col gap-2">
                    <StepLabel n={2}>読み取りの種類</StepLabel>
                    <TierPicker
                      name="form-ai-tier"
                      value={tier}
                      onChange={setTier}
                      standardTestId="form-ai-tier-standard"
                      advancedTestId="form-ai-tier-advanced"
                      advancedHint="標準で読み違えたときの再確認用"
                    />
                  </div>

                  <div className="flex flex-col gap-2">
                    <StepLabel n={3}>同意して実行</StepLabel>
                    <ConsentBox testId="form-ai-consent" checked={consent} onChange={setConsent}>
                      上の内容（PDFの文字）を、AI（OpenAI）に送って読み取ることに同意します
                    </ConsentBox>
                    <AiRunButton
                      testId="form-ai-run"
                      cancelTestId="form-ai-cancel"
                      disabled={!canRun}
                      running={running}
                      label="AIで読み取る"
                      consentGiven={consent}
                      onClick={() => void run()}
                      onCancel={() => abortRef.current?.abort()}
                    />
                    {running && <AiProgress testId="form-ai-progress" seconds={seconds} />}
                  </div>
                </>
              )}

              {error && <ErrorMessage message={error} testId="form-ai-error" />}

              {rows && (
                <div className="flex flex-col gap-2" data-testid="form-ai-result">
                  <StepLabel n={4} hint="直したい文字は、その場で書き換えられます">結果の確認</StepLabel>
                  {notes.map((n, i) => (
                    <p key={i} data-testid="form-ai-note" className="rounded-lg bg-white px-3 py-2 text-xs text-neutral-800 dark:bg-neutral-900 dark:text-neutral-100">
                      AIからの注意：{n}
                    </p>
                  ))}
                  {unverifiedTotal > 0 && (
                    <p data-testid="form-ai-unverified-note" role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                      黄色い欄（{unverifiedTotal}か所）は、元のPDFの文字の中に見つかりませんでした。AIが読み違えた可能性があるので、PDFと見比べて直してください。
                    </p>
                  )}
                  {rejected > 0 && <p className="text-xs text-neutral-600 dark:text-neutral-300">形式が正しくなかった{rejected}行は、使っていません。</p>}
                  {rows.length === 0 ? (
                    <p data-testid="form-ai-empty" className="rounded-lg bg-white px-3 py-2 text-sm dark:bg-neutral-900">表として読み取れませんでした。</p>
                  ) : (
                    <div className="max-h-80 overflow-auto rounded border border-violet-200 bg-white dark:border-violet-800 dark:bg-neutral-950">
                      <table className="min-w-full text-left text-xs">
                        <tbody>
                          {rows.map((r) => (
                            <tr key={r.id} data-testid="form-ai-row" data-kind={r.kind} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                              {Array.from({ length: maxColumns }, (_, c) => (
                                <td key={c} className="px-1 py-1">
                                  <input
                                    aria-label={`${r.page}ページ ${rows.indexOf(r) + 1}行目 ${c + 1}列目`}
                                    value={r.cells[c] ?? ""}
                                    data-unverified={r.unverified.has(c) ? "true" : undefined}
                                    onChange={(e) => updateCell(r.id, c, e.target.value)}
                                    className={`w-full min-w-24 rounded border px-1.5 py-1 ${
                                      r.unverified.has(c)
                                        ? "border-amber-400 bg-amber-50 dark:bg-amber-950/40"
                                        : r.kind === "header"
                                          ? "border-neutral-200 bg-neutral-100 font-semibold dark:border-neutral-700 dark:bg-neutral-900"
                                          : "border-neutral-200 dark:border-neutral-700 dark:bg-neutral-950"
                                    }`}
                                  />
                                </td>
                              ))}
                              <td className="px-1 py-1">
                                <button
                                  type="button"
                                  onClick={() => removeRow(r.id)}
                                  aria-label={`${rows.indexOf(r) + 1}行目を削除`}
                                  className="rounded px-1.5 py-1 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                                >
                                  ×
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {rows.length > 0 && (
                    <button
                      type="button"
                      data-testid="form-ai-make-excel"
                      onClick={() => void makeExcel()}
                      className="w-fit rounded-lg bg-violet-700 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-800"
                    >
                      この内容でExcelを作る
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}

      {excel && (
        <ResultPopup testId="form-ai-excel-result">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{excel.rowCount}行 ・ {(excel.blob.size / 1024).toFixed(1)} KB</p>
          <button
            type="button"
            data-testid="form-ai-download"
            onClick={() => downloadBlob(excel.blob, excel.name)}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
          >
            Excelファイルをダウンロード
          </button>
        </ResultPopup>
      )}
    </div>
  );
}

/** AI読み取り補助を、画面に出すか（課金システムがオンの間だけ。オフの間は入口も出さない） */
export function formAiEnabled(): boolean {
  return featureFlags.billing;
}
