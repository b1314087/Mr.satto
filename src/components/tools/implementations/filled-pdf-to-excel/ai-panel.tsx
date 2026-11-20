"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ResultPopup } from "@/components/common/result-popup";
import { ErrorMessage } from "@/components/common/error-message";
import { featureFlags } from "@/lib/config/features";
import { FORM_CONSENT_VERSION, FORM_MAX_CHARS_TOTAL, FORM_MAX_IMAGE_PAGES, FORM_MAX_PAGES, type FormExtractRow, type FormPurpose } from "@/lib/ai/form-extract";
import type { AiModelTier } from "@/lib/ai/pricing";
import { writeXlsxSheets } from "@/lib/excel/xlsx-simple-io";
import { closePdfDocument, loadPdfDocument, getPositionedTextItems, pageHasText, renderPageToCanvas, type PositionedTextItem } from "@/lib/pdf/pdfjs-client";
import { ocrWordsToPositionedTextItems, recognizeImageWithWords } from "@/lib/ocr/tesseract-client";
import { removeRuledLinesFromCanvas } from "@/lib/ocr/remove-ruled-lines";
import { encodeCanvasForAi, type PreparedImage } from "@/lib/calendar/event-image";
import { groupIntoLines } from "@/lib/pdf/table-reconstruction";
import { downloadBlob, stripExtension } from "@/lib/utils/format";
import { chunkWordParagraphsForAi } from "@/lib/office-convert/word-ai-text";
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
 * - 文字のあるPDFは、PDFから取り出した「文字」だけを送る。PDFファイルそのものは送らない。
 * - 2026-11-20：ページ数・ファイル数の上限をなくした（上限はAI利用枠＝トークンで決まる）。
 *   1回に送れる量（5ページ・6,000文字・画像4枚）を超えるときは、自動で何回かに分けて順に送り、結果をつなげる。
 *   途中で利用枠が足りなくなったときは、そこまでの結果を残す。
 * - スキャンしたページ（PDF→Excelだけ）は、端末内でOCRして文字（参考）を取り出し、
 *   縮小した画像（JPEG）と一緒に送る。送る画像は画面に出して見せ、同意を取る。
 * - 送る内容を画面に出し、実行のたびに同意を取る。
 * - AIの結果は「提案」。原文に見つからない文字は目立たせ、利用者が直してから、Excelにする。
 */

type UsageState =
  | { status: "loading" }
  | ({ status: "available" } & AiUsage)
  | { status: "unavailable"; reason: "login_required" | "not_premium" | "unavailable" };

/** 画面に出し、AIに送るページ。スキャンしたページは image がある（text は端末内のOCRの文字） */
interface SendPage {
  /** AIに送るページの番号（ファイルが複数のときは、全部のファイルを通した番号） */
  page: number;
  text: string;
  image?: PreparedImage;
  /** 画面に出すページの名前（ファイルが複数のときは、ファイル名つき） */
  label: string;
}

/** 1回に送れる量に収まるように、ページを順に分ける（ページの途中では分けない） */
export function batchSendPages<T extends { text: string; image?: unknown }>(pages: T[]): T[][] {
  const batches: T[][] = [];
  let cur: T[] = [];
  let chars = 0;
  let images = 0;
  for (const pg of pages) {
    const img = pg.image ? 1 : 0;
    if (cur.length > 0 && (cur.length >= FORM_MAX_PAGES || chars + pg.text.length > FORM_MAX_CHARS_TOTAL || images + img > FORM_MAX_IMAGE_PAGES)) {
      batches.push(cur);
      cur = [];
      chars = 0;
      images = 0;
    }
    cur.push(pg);
    chars += pg.text.length;
    images += img;
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}

/** スキャンしたページを画像にするときの、OCR用の描画サイズ（PDF→Excelの変換と同じ） */
const OCR_RENDER_SCALE = 2.5;
const MAX_OCR_DIMENSION = 2200;

type TextState =
  | { status: "idle" }
  | { status: "reading"; message: string }
  | { status: "ready"; pages: SendPage[]; chars: number; imageCount: number; batches: number }
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

/** 目的ごとの画面の文言（記入済みPDF→Excelは「項目」、PDF→Excelは「表」、Word→Excelは「表になっていない文章」） */
const PURPOSE_COPY: Record<
  FormPurpose,
  {
    title: string;
    sub: string;
    sheet: string;
    loginNext: string;
    /** 送る文字の呼び方（同意文・説明に使う） */
    textName: string;
    /** 元のファイルの呼び方 */
    sourceName: string;
    /** まとまりの呼び方（「1ページ目」「1つ目のまとまり」） */
    unit: (n: number) => string;
    unitCount: string;
    fileSuffix: string;
    runLabel: string;
  }
> = {
  form: { title: "AIで項目を読み取る（任意）", sub: "文字のPDFを、AIが項目ごとの表に整理します", sheet: "AI読み取り", loginNext: "/tools/filled-pdf-to-excel", textName: "PDFの文字", sourceName: "PDF", unit: (n) => `${n}ページ目`, unitCount: "ページ", fileSuffix: "_AI読み取り", runLabel: "AIで読み取る" },
  table: { title: "AIで表を読み取る（任意）", sub: "PDFの表（スキャンしたPDFも）を、AIが整理してExcelの行にします", sheet: "AI読み取り", loginNext: "/tools/pdf-to-excel", textName: "PDFの文字", sourceName: "PDF", unit: (n) => `${n}ページ目`, unitCount: "ページ", fileSuffix: "_AI読み取り", runLabel: "AIで読み取る" },
  word: { title: "AIで表にする（任意）", sub: "表になっていない文章（項目と内容の並び・箇条書きなど）を、AIが列に分けて表にします", sheet: "AIで表にした文章", loginNext: "/tools/word-to-excel", textName: "Word文書の表以外の文章", sourceName: "Word文書", unit: (n) => `${n}つ目のまとまり`, unitCount: "まとまり", fileSuffix: "_AIで表にした文章", runLabel: "AIで表にする" },
};

export function FilledPdfAiPanel({ files, totalPages, purpose = "form" }: { files: File[]; totalPages: number | null; purpose?: FormPurpose }) {
  const copy = PURPOSE_COPY[purpose];
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

  // Word→Excel は、今までどおり1つの文書だけ。PDFは、ファイルの数・ページの数の上限なし（AI利用枠で決まる）
  const eligibleFile = files.length >= 1 ? files[0] : null;
  const filesKey = files.map((f) => `${f.name}:${f.size}:${f.lastModified}`).join("|");
  const pageLimitProblem =
    purpose === "word" && files.length > 1 ? `AIで読み取れるのは、1つの${copy.sourceName}だけです。ほかのファイルを外してください。` : null;
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  // totalPages は、ほかの画面との呼び出しの形をそろえるために受け取る（AIの上限には使わない）
  void totalPages;

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
  }, [filesKey]);

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
    setText({ status: "reading", message: `${copy.textName}を取り出しています…（この端末の中だけで行います）` });
    (async () => {
      // Word→Excel：表以外の段落を、文書の順に、いくつかのまとまりにして送る
      if (purpose === "word") {
        try {
          // Wordの解析は、Word→Excelのときだけ読み込む（PDFのツールの画面を重くしない）
          const { readWordBodyParagraphs } = await import("@/lib/office-convert/word-to-excel");
          const chunked = chunkWordParagraphsForAi(await readWordBodyParagraphs(eligibleFile));
          if (cancelled) return;
          if (!chunked.ok) {
            setText({
              status: "problem",
              message:
                chunked.reason === "empty"
                  ? "この文書には、表以外の文章がありません。表は、上の変換でそのままExcelにできます。"
                  : `文章が多すぎます（${chunked.chars.toLocaleString("ja-JP")}文字。送れるのは${FORM_MAX_CHARS_TOTAL.toLocaleString("ja-JP")}文字まで）。表にしたい部分だけを残したWord文書でお試しください。`,
            });
            return;
          }
          const wordPages = chunked.pages.map((pg) => ({ ...pg, label: copy.unit(pg.page) }));
          setText({ status: "ready", pages: wordPages, chars: chunked.chars, imageCount: 0, batches: batchSendPages(wordPages).length });
        } catch (e) {
          if (!cancelled) setText({ status: "problem", message: e instanceof Error ? e.message : "Word文書の文章を取り出せませんでした。" });
        }
        return;
      }
      try {
        const pages: SendPage[] = [];
        const multi = files.length > 1;
        let globalPage = 0;
        for (const file of files) {
          const pdf = await loadPdfDocument(file);
          try {
            for (let p = 1; p <= pdf.numPages; p++) {
              if (cancelled) return;
              globalPage++;
              const label = multi ? `${file.name} ${p}ページ目` : `${p}ページ目`;
              const page = await pdf.getPage(p);
              const items = await getPositionedTextItems(page);
              if (pageHasText(items)) {
                const pageText = itemsToPageText(items);
                if (pageText.length > FORM_MAX_CHARS_TOTAL) {
                  setText({ status: "problem", message: `${label}の文字が多すぎます（${pageText.length.toLocaleString("ja-JP")}文字。1ページで送れるのは${FORM_MAX_CHARS_TOTAL.toLocaleString("ja-JP")}文字まで）。` });
                  return;
                }
                pages.push({ page: globalPage, text: pageText, label });
                continue;
              }
              // 文字のないページ（スキャンした画像）
              if (purpose !== "table") {
                setText({ status: "problem", message: `${label}に文字がありません（スキャンした画像のPDFです）。この機能では送れません。従来の変換（OCR）をお使いください。` });
                return;
              }
              setText({ status: "reading", message: `${label}はスキャンした画像です。画像にして、文字を読み取っています…（この端末の中だけで行います。時間がかかることがあります）` });
              let canvas: HTMLCanvasElement;
              try {
                canvas = (await renderPageToCanvas(page, OCR_RENDER_SCALE, MAX_OCR_DIMENSION)).canvas;
              } catch {
                if (!cancelled) setText({ status: "problem", message: `${label}を画像にできませんでした。` });
                return;
              }
              // 参考にする文字（端末内のOCR）。読めなくても、画像は送れる
              let ocrText = "";
              try {
                const result = await recognizeImageWithWords(removeRuledLinesFromCanvas(canvas), "ja+en", () => {}, { pageSegMode: "6" });
                ocrText = itemsToPageText(ocrWordsToPositionedTextItems(result.words)).slice(0, FORM_MAX_CHARS_TOTAL);
              } catch {
                ocrText = "";
              }
              if (cancelled) return;
              const image = await encodeCanvasForAi(canvas, label);
              if (!image) {
                setText({ status: "problem", message: `${label}の画像を、送れる大きさに小さくできませんでした。` });
                return;
              }
              pages.push({ page: globalPage, text: ocrText, image, label });
            }
          } finally {
            await closePdfDocument(pdf);
          }
        }
        const chars = pages.reduce((sum, pg) => sum + pg.text.length, 0);
        const imageCount = pages.filter((pg) => pg.image).length;
        if (cancelled) return;
        if (pages.length === 0) {
          setText({ status: "problem", message: "送れるページがありませんでした。" });
          return;
        }
        setText({ status: "ready", pages, chars, imageCount, batches: batchSendPages(pages).length });
      } catch {
        if (!cancelled) setText({ status: "problem", message: "PDFの文字を取り出せませんでした。" });
      }
    })();
    return () => {
      cancelled = true;
    };
    // filesKey が変わったときだけ取り出し直す（files は毎回の描画で新しい配列になることがある）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, filesKey, pageLimitProblem, purpose, copy.textName]);

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
  // 結果を出したときに、画像つきで送ったか（黄色い欄の説明に使う）
  const [sentImages, setSentImages] = useState(false);
  const unverifiedTotal = useMemo(() => (rows ?? []).reduce((sum, r) => sum + r.unverified.size, 0), [rows]);

  async function run() {
    if (!canRun || text.status !== "ready") return;
    const controller = new AbortController();
    abortRef.current = controller;
    const batches = batchSendPages(text.pages);
    setRunning(true);
    setError(null);
    setExcel(null);
    setProgress({ done: 0, total: batches.length });
    const collected: DraftRow[] = [];
    const allNotes: string[] = [];
    let rejectedTotal = 0;
    let stoppedAt: string | null = null;
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
              // 記入済みPDF→Excelは、目的を省略して送る（従来どおりの依頼）。PDF→Excelは "table"、Word→Excelは "word" を付ける
              ...(purpose !== "form" ? { purpose } : {}),
              // スキャンしたページは、縮小した画像（JPEG）を付ける。表示用の名前・大きさは送らない
              pages: batch.map((pg) => ({
                page: pg.page,
                text: pg.text,
                ...(pg.image ? { image: { mediaType: pg.image.mediaType, base64: pg.image.base64 } } : {}),
              })),
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
          const message = typeof data?.message === "string" ? data.message : "AIによる読み取りに失敗しました。ほかの変換は、そのまま使えます。";
          stoppedAt = batch[0].label;
          setError(
            bi > 0
              ? `${message}（${batches[bi - 1][batches[bi - 1].length - 1].label}までの結果を下に出しています）`
              : message,
          );
          break;
        }
        for (const r of data!.rows as FormExtractRow[]) {
          collected.push({ id: collected.length, page: r.page, kind: r.kind, cells: [...r.cells], unverified: new Set(r.unverified) });
        }
        if (Array.isArray(data!.notes)) for (const n of data!.notes as string[]) if (!allNotes.includes(n) && allNotes.length < 10) allNotes.push(n);
        if (typeof data!.rejected === "number") rejectedTotal += data!.rejected as number;
        setProgress({ done: bi + 1, total: batches.length });
      }
      if (collected.length > 0 || stoppedAt === null) {
        setSentImages(text.imageCount > 0);
        setRows(collected);
        setNotes(allNotes);
        setRejected(rejectedTotal);
      }
    } catch (e) {
      setError(
        e instanceof DOMException && e.name === "AbortError"
          ? "AIの応答を待つ時間を超えたか、中止したため、止めました。ほかの変換は、そのまま使えます。"
          : "通信に失敗しました。ほかの変換は、そのまま使えます。",
      );
      if (collected.length > 0) {
        setSentImages(text.imageCount > 0);
        setRows(collected);
        setNotes(allNotes);
        setRejected(rejectedTotal);
      }
    } finally {
      abortRef.current = null;
      setRunning(false);
      setProgress(null);
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
      const blob = await writeXlsxSheets([{ name: copy.sheet, rows: sheetRows }]);
      setExcel({ blob, name: `${stripExtension(eligibleFile.name)}${copy.fileSuffix}.xlsx`, rowCount: rows.length });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Excelファイルの生成に失敗しました");
    }
  }

  const pageLabels = new Map(sendPages.map((pg) => [pg.page, pg.label] as const));
  const maxColumns = (rows ?? []).reduce((m, r) => Math.max(m, r.cells.length), 0);

  return (
    <div data-testid="form-ai-panel" className={AI_PANEL_CLASS}>
      <AiPanelHeader
        title={copy.title}
        sub={copy.sub}
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
            <AiUnavailableNotice reason={usage.reason} text={UNAVAILABLE_TEXT[usage.reason]} loginNext={copy.loginNext} />
          )}

          {usage.status === "available" && (
            <>
              <AiUsageMeter usage={usage} />

              {pageLimitProblem && (
                <p data-testid="form-ai-problem" role="alert" className="rounded-lg bg-white px-3 py-2 text-sm text-red-700 dark:bg-neutral-900 dark:text-red-300">
                  {pageLimitProblem}
                </p>
              )}
              {text.status === "reading" && <p data-testid="form-ai-reading" className="text-sm text-neutral-600 dark:text-neutral-300">{text.message}</p>}
              {text.status === "problem" && !pageLimitProblem && (
                <p data-testid="form-ai-problem" role="alert" className="rounded-lg bg-white px-3 py-2 text-sm text-red-700 dark:bg-neutral-900 dark:text-red-300">
                  {text.message}
                </p>
              )}

              {text.status === "ready" && (
                <>
                  <div className="flex flex-col gap-1" data-testid="form-ai-preview">
                    <StepLabel n={1} hint={text.imageCount > 0 ? "この文字と画像だけをAIに送ります" : "この文字だけをAIに送ります"}>送る内容の確認</StepLabel>
                    <div className="max-h-56 overflow-auto rounded border border-violet-200 bg-white p-2 dark:border-violet-800 dark:bg-neutral-950">
                      {sendPages.map((pg) => (
                        <div key={pg.page} className="mb-2 last:mb-0">
                          <p className="text-[11px] font-semibold text-violet-800 dark:text-violet-200">
                            {pg.label}{pg.image ? "（スキャンした画像）" : ""}
                          </p>
                          {pg.image && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              data-testid="form-ai-image"
                              src={`data:${pg.image.mediaType};base64,${pg.image.base64}`}
                              alt={`AIに送る${pg.label}の画像`}
                              className="mb-1 max-h-48 rounded border border-neutral-200 dark:border-neutral-700"
                            />
                          )}
                          {pg.image && (
                            <p className="text-[11px] text-neutral-600 dark:text-neutral-300">
                              {pg.text.trim() === "" ? "端末内のOCRでは文字を読み取れませんでした（画像だけを送ります）。" : "下の文字は、端末内のOCRが読み取った参考です（誤りを含むことがあります）。"}
                            </p>
                          )}
                          {pg.text.trim() !== "" && <pre className="whitespace-pre-wrap break-all font-sans text-xs text-neutral-800 dark:text-neutral-100">{pg.text}</pre>}
                        </div>
                      ))}
                    </div>
                    <p data-testid="form-ai-count" className="text-xs text-neutral-700 dark:text-neutral-200">
                      送る{copy.unitCount}：{sendPages.length}{purpose === "word" ? "つ" : copy.unitCount} ／ 送る文字：{text.chars.toLocaleString("ja-JP")}文字
                      {text.imageCount > 0 ? ` ／ 送る画像：${text.imageCount}枚` : ""}
                      {text.batches > 1 ? ` ／ ${text.batches}回に分けて順に送ります（AI利用枠を、送る量に応じて使います）` : ""}
                    </p>
                    <p className="text-xs text-neutral-600 dark:text-neutral-300">
                      {text.imageCount > 0 ? "PDFファイルそのものは送りません。スキャンしたページは、縮小した画像を送ります。" : purpose === "word" ? "Word文書のファイルそのもの・画像は送りません。" : "PDFファイルそのもの・画像は送りません。"}
                    </p>
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
                      {text.imageCount > 0
                        ? "上の内容（PDFの文字と、スキャンしたページの画像）を、AI（OpenAI）に送って読み取ることに同意します"
                        : `上の内容（${copy.textName}）を、AI（OpenAI）に送って${purpose === "word" ? "表にする" : "読み取る"}ことに同意します`}
                    </ConsentBox>
                    <AiRunButton
                      testId="form-ai-run"
                      cancelTestId="form-ai-cancel"
                      disabled={!canRun}
                      running={running}
                      label={copy.runLabel}
                      consentGiven={consent}
                      onClick={() => void run()}
                      onCancel={() => abortRef.current?.abort()}
                    />
                    {running && <AiProgress testId="form-ai-progress" seconds={seconds} />}
                    {running && progress && progress.total > 1 && (
                      <p data-testid="form-ai-batch-progress" role="status" className="text-xs text-violet-900 dark:text-violet-100">
                        {progress.done} / {progress.total} 回目まで終わりました
                      </p>
                    )}
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
                      黄色い欄（{unverifiedTotal}か所）は、{sentImages ? "端末内のOCRの文字やPDFの文字の中に" : `元の${copy.sourceName}の文字の中に`}見つかりませんでした。AIが読み違えた可能性があるので、{copy.sourceName}と見比べて直してください。
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
                                    aria-label={`${pageLabels.get(r.page) ?? copy.unit(r.page)} ${rows.indexOf(r) + 1}行目 ${c + 1}列目`}
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
