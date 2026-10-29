"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { unzipSync } from "fflate";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { prepareImageBytes, type PreparedImage } from "@/lib/calendar/event-image";
import { PPTX_TEXT_CONSENT_VERSION, PPTX_TEXT_MAX_IMAGES_PER_REQUEST, type PptxTextLine } from "@/lib/ai/pptx-text";
import type { AiModelTier } from "@/lib/ai/pricing";
import { sniffRasterKind } from "@/lib/pptx/image-invert";
import { invertPptx } from "@/lib/pptx/invert-pptx";
import { buildTextZoneMask, ZONE_KINDS } from "@/lib/pptx/text-zones";
import { applyTextReplacements, scanSlidePictures, type ImageReplacement, type TextReplaceReport } from "@/lib/pptx/text-replace";
import { PPTX_MIME, type PptxInvertOutput } from "@/lib/processors/browser/pptx-invert";
import { stripExtension, downloadBlob, formatBytes } from "@/lib/utils/format";
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
} from "./shared/ai-panel-parts";

/**
 * 変換した .pptx の、画像の中の文字を、AIで読み取って本物の文字（PowerPointのテキスト）に置き換える（プレミアム）。
 *
 * - AIへ送るのは、変換前の（白地・黒文字の）画像を縮小したものだけ。元のファイルそのものは送らない。
 * - 毎回、送る画像を確認して同意してから実行する。送った画像も読み取り結果も、サービスには保存しない。
 * - 読み取り結果は「候補」。画像と見比べて、チェックと修正をしてから、変換後のファイルに反映する。
 * - 普通の文字の行だけを置き換える。数式・図の中の文字は、画像のまま残す。
 */

interface Candidate {
  path: string;
  label: string;
  prepared: PreparedImage;
}

interface DraftLine extends PptxTextLine {
  id: number;
  adopt: boolean;
}

type UsageState =
  | { status: "loading" }
  | ({ status: "available" } & AiUsage)
  | { status: "unavailable"; reason: "login_required" | "not_premium" | "unavailable" };

const UNAVAILABLE_TEXT: Record<"login_required" | "not_premium" | "unavailable", string> = {
  login_required: "画像の文字をAIで本物の文字にするには、ログインが必要です。",
  not_premium: "画像の文字をAIで本物の文字にする機能は、プレミアムプランの機能です。",
  unavailable: "AIによる読み取りは、現在ご利用いただけません。通常の白黒反転は、そのままご利用いただけます。",
};

const KIND_LABEL: Record<PptxTextLine["kind"], string> = {
  text: "文字",
  math: "数式（画像のまま）",
  label: "図の中の文字（画像のまま）",
  other: "その他（画像のまま）",
};

const MAX_CANDIDATES = 12;
/** 候補にする画像の、縦横の最小（これより小さい画像は、飾りや記号として扱う） */
const MIN_SIDE = 160;

function newRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function slideNumberOf(path: string): number | null {
  const m = /slide(\d+)\.xml$/.exec(path);
  return m ? Number(m[1]) : null;
}

export function PptxInvertAiPanel({ file, result }: { file: File; result: PptxInvertOutput }) {
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [prepareNote, setPrepareNote] = useState<string | null>(null);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageState>({ status: "loading" });
  const [tier, setTier] = useState<AiModelTier>("standard");
  const [consent, setConsent] = useState(false);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Map<string, DraftLine[]> | null>(null);
  const [rejected, setRejected] = useState(0);
  const [applying, setApplying] = useState(false);
  const [output, setOutput] = useState<{ blob: Blob; name: string; report: TextReplaceReport } | null>(null);
  const [zoning, setZoning] = useState(false);
  const [zoneOutput, setZoneOutput] = useState<{ blob: Blob; name: string; zoned: number; notes: string[] } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);

  useEffect(() => () => abortRef.current?.abort(), []);

  // AIに送る画像を、元のファイルから選んで縮小する（この時点では、何も送信しない）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const files = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: (f) => /^ppt\/(slides\/[^/]+\.xml|slides\/_rels\/[^/]+\.rels|media\/[^/]+)$/i.test(f.name) });
        const { pictures, skipped } = scanSlidePictures(files);
        const documentLike = new Map(result.report.images.filter((i) => i.outcome === "inverted" || i.outcome === "inverted-gray").map((i) => [i.path, i]));
        const seen = new Set<string>();
        const picked: { path: string; slide: number | null }[] = [];
        for (const pic of pictures) {
          const info = documentLike.get(pic.imagePath);
          if (!info || seen.has(pic.imagePath)) continue;
          if ((info.width ?? 0) < MIN_SIDE || (info.height ?? 0) < MIN_SIDE) continue;
          seen.add(pic.imagePath);
          picked.push({ path: pic.imagePath, slide: slideNumberOf(pic.slidePath) });
        }
        const used = picked.slice(0, MAX_CANDIDATES);
        const prepared: Candidate[] = [];
        for (const p of used) {
          const bytes = files[p.path];
          const kind = bytes ? sniffRasterKind(bytes) : null;
          if (!bytes || !kind) continue;
          const label = p.slide ? `スライド${p.slide}の画像` : (p.path.split("/").pop() ?? p.path);
          prepared.push({ path: p.path, label, prepared: await prepareImageBytes(bytes, kind === "png" ? "image/png" : "image/jpeg", label) });
          if (cancelled) return;
        }
        if (cancelled) return;
        const notes: string[] = [];
        if (picked.length > MAX_CANDIDATES) notes.push(`画像が多いため、先頭の${MAX_CANDIDATES}枚だけを対象にします。`);
        if (skipped > 0) notes.push(`回転した画像・グループの中の画像（${skipped}枚）は、位置を合わせられないため対象外です。`);
        setPrepareNote(notes.length > 0 ? notes.join(" ") : null);
        setCandidates(prepared);
      } catch (e) {
        if (!cancelled) setPrepareError(e instanceof Error ? e.message : "画像の準備に失敗しました。");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file, result]);

  useEffect(() => {
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
  }, []);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  const imageCount = candidates?.length ?? 0;
  const canRun = usage.status === "available" && !running && consent && imageCount > 0;

  async function run() {
    if (!canRun || runningRef.current || !candidates) return;
    runningRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    setElapsed(0);
    setRunning(true);
    setError(null);
    setOutput(null);
    const collected = new Map<string, DraftLine[]>();
    let counter = 0;
    let rejectedTotal = 0;
    let failed = false;
    try {
      const batches: Candidate[][] = [];
      for (let i = 0; i < candidates.length; i += PPTX_TEXT_MAX_IMAGES_PER_REQUEST) batches.push(candidates.slice(i, i + PPTX_TEXT_MAX_IMAGES_PER_REQUEST));
      for (let b = 0; b < batches.length; b++) {
        const batch = batches[b];
        setProgress(batches.length > 1 ? `${b + 1}/${batches.length}回目を読み取っています…` : "");
        const timer = setTimeout(() => controller.abort(), 130_000);
        let res: Response;
        try {
          res = await fetch("/api/ai/pptx-text", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            cache: "no-store",
            signal: controller.signal,
            body: JSON.stringify({
              requestId: newRequestId(),
              model: tier,
              images: batch.map((c) => ({ mediaType: c.prepared.mediaType, base64: c.prepared.base64 })),
              consent: { accepted: true, version: PPTX_TEXT_CONSENT_VERSION },
            }),
          });
        } finally {
          clearTimeout(timer);
        }
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.ok) {
          setError(
            (typeof data?.message === "string" ? data.message : res.status === 413 ? "送る画像が大きすぎます。" : "AIによる読み取りに失敗しました。") +
              (collected.size > 0 ? "（ここまでに読み取れた分は、下に表示しています）" : ""),
          );
          if (data?.usage) setUsage((u) => (u.status === "available" ? { ...u, ...data.usage } : u));
          failed = true;
          break;
        }
        for (const line of data.lines as PptxTextLine[]) {
          const target = batch[line.image - 1];
          if (!target) continue;
          const list = collected.get(target.path) ?? [];
          list.push({ ...line, id: ++counter, adopt: line.kind === "text" && line.confidence !== "low" });
          collected.set(target.path, list);
        }
        rejectedTotal += typeof data.rejected === "number" ? data.rejected : 0;
        if (data.usage) setUsage({ status: "available", ...data.usage });
      }
      // 失敗して、読み取れた分もないときは、結果の欄を出さない（エラーだけを表示する）
      if (!failed || collected.size > 0) {
        setDrafts(collected);
        setRejected(rejectedTotal);
      }
    } catch (e) {
      setDrafts(collected.size > 0 ? collected : null);
      setError(
        e instanceof DOMException && e.name === "AbortError"
          ? "読み取りを中止しました（または、AIの応答を待つ時間を超えました）。利用枠が消費されている場合があります。"
          : "通信に失敗しました。",
      );
    } finally {
      abortRef.current = null;
      runningRef.current = false;
      setRunning(false);
      setProgress("");
      // 同意は毎回確認する（実行のたびに外れる）
      setConsent(false);
    }
  }

  function update(path: string, id: number, patch: Partial<DraftLine>) {
    setDrafts((prev) => {
      if (!prev) return prev;
      const next = new Map(prev);
      next.set(path, (next.get(path) ?? []).map((l) => (l.id === id ? { ...l, ...patch } : l)));
      return next;
    });
  }

  const chosenCount = useMemo(() => {
    let n = 0;
    for (const list of drafts?.values() ?? []) n += list.filter((l) => l.adopt && l.kind === "text" && l.text.trim() !== "").length;
    return n;
  }, [drafts]);

  async function apply() {
    if (!drafts || chosenCount === 0 || applying) return;
    setApplying(true);
    setError(null);
    try {
      const replacements: ImageReplacement[] = [];
      for (const [path, list] of drafts) {
        const lines = list
          .filter((l) => l.adopt && l.kind === "text" && l.text.trim() !== "")
          .map((l) => ({ text: l.text.trim(), x: l.x, y: l.y, w: l.w, h: l.h, underline: l.underline, bold: l.bold }));
        if (lines.length > 0) replacements.push({ imagePath: path, lines });
      }
      const bytes = new Uint8Array(await result.blob.arrayBuffer());
      const done = await applyTextReplacements(bytes, replacements, { textColor: result.report.colorChoice.text, backgroundColor: result.report.colorChoice.background });
      const blob = new Blob([done.bytes as BlobPart], { type: PPTX_MIME });
      setOutput({ blob, name: `${stripExtension(result.suggestedName)}_AI文字.pptx`, report: done.report });
    } catch (e) {
      setError(e instanceof Error ? e.message : "文字の置き換えに失敗しました。");
    } finally {
      setApplying(false);
    }
  }

  /** AIが見つけた文字・数式の行の範囲を使って、画像は画像のまま、白黒を反転し直す（文字を消したり入れ直したりしない） */
  const zoneLineCount = useMemo(() => {
    let n = 0;
    for (const list of drafts?.values() ?? []) n += list.filter((l) => ZONE_KINDS.has(l.kind)).length;
    return n;
  }, [drafts]);

  async function applyZones() {
    if (!drafts || zoneLineCount === 0 || zoning) return;
    setZoning(true);
    setError(null);
    try {
      const byPath = new Map<string, { x: number; y: number; w: number; h: number }[]>();
      for (const [path, list] of drafts) {
        const lines = list.filter((l) => ZONE_KINDS.has(l.kind)).map((l) => ({ x: l.x, y: l.y, w: l.w, h: l.h }));
        if (lines.length > 0) byPath.set(path, lines);
      }
      const original = new Uint8Array(await file.arrayBuffer());
      const done = await invertPptx(original, {
        ...result.options,
        textZoneFor: (path, image) => {
          const lines = byPath.get(path);
          return lines ? buildTextZoneMask(image, lines) : null;
        },
      });
      const blob = new Blob([done.bytes as BlobPart], { type: PPTX_MIME });
      const zoned = done.report.images.filter((i) => i.zoned).length;
      setZoneOutput({ blob, name: `${stripExtension(result.suggestedName)}_AI判断.pptx`, zoned, notes: done.report.notes.filter((n) => n.startsWith("AIが見つけた文字の範囲")) });
    } catch (e) {
      setError(e instanceof Error ? e.message : "反転し直しに失敗しました。");
    } finally {
      setZoning(false);
    }
  }

  return (
    <div data-testid="pptx-ai" className={AI_PANEL_CLASS}>
      <AiPanelHeader title="AIで、画像の文字を本物の文字にする" sub="画像の中の文字を読み取り、PowerPointで編集できる文字に置き換えます" />

      {usage.status === "loading" && <p className="text-xs text-neutral-600 dark:text-neutral-300">利用状況を確認しています…</p>}
      {usage.status === "unavailable" && <AiUnavailableNotice reason={usage.reason} text={UNAVAILABLE_TEXT[usage.reason]} loginNext="/tools/pptx-invert" />}
      {usage.status === "available" && <AiUsageMeter usage={usage} />}

      {prepareError && (
        <p role="alert" data-testid="pptx-ai-prepare-error" className="rounded-lg bg-red-50 px-3 py-2 text-red-800 dark:bg-red-950 dark:text-red-200">
          {prepareError}
        </p>
      )}
      {!prepareError && candidates === null && <p className="text-xs text-neutral-600 dark:text-neutral-300">対象の画像を調べています…</p>}
      {candidates && candidates.length === 0 && (
        <p data-testid="pptx-ai-none" className="rounded-lg bg-white px-3 py-2 text-xs text-neutral-700 dark:bg-neutral-900 dark:text-neutral-200">
          文字を読み取れる画像（白地に黒文字の画像）が見つかりませんでした。{prepareNote}
        </p>
      )}

      {candidates && candidates.length > 0 && (
        <>
          <div className="flex flex-col gap-2" data-testid="pptx-ai-send-preview">
            <StepLabel n={1}>送る画像</StepLabel>
            <ul className="flex flex-wrap gap-2">
              {candidates.map((c) => (
                <li key={c.path} className="flex w-24 flex-col gap-0.5">
                  {/* eslint-disable-next-line @next/next/no-img-element -- 送る画像そのもの(data URL)の確認用の表示 */}
                  <img src={`data:${c.prepared.mediaType};base64,${c.prepared.base64}`} alt={`AIに送る画像：${c.label}`} className="h-24 w-24 rounded-lg border border-violet-200 bg-white object-contain shadow-sm dark:border-violet-800" />
                  <span className="break-all text-[11px] text-neutral-600 dark:text-neutral-300">{c.label}</span>
                </li>
              ))}
            </ul>
            <p data-testid="pptx-ai-send-count" className="text-xs text-neutral-700 dark:text-neutral-200">
              送る画像：{candidates.length}枚（{file.name}の中の、白地に黒文字の画像を縮小したもの）。元のファイルそのものは送りません。
            </p>
            {prepareNote && <p className="text-xs text-neutral-600 dark:text-neutral-300">{prepareNote}</p>}
            <p className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
              <span aria-hidden="true" className="shrink-0 font-bold">!</span>
              画像に写る文字は、すべてAIに送られます。個人情報や、公開できない内容（未公開のテスト問題など）が写っていないか確認してください。
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <StepLabel n={2}>読み取りの種類</StepLabel>
            <TierPicker name="pptx-ai-tier" value={tier} onChange={setTier} standardTestId="pptx-ai-tier-standard" advancedTestId="pptx-ai-tier-advanced" advancedHint="小さい文字・細かい表向け" />
          </div>

          <div className="flex flex-col gap-2">
            <StepLabel n={3}>同意して実行</StepLabel>
            <ConsentBox testId="pptx-ai-consent" checked={consent} onChange={setConsent}>
              上の画像（{candidates.length}枚）を、AI（OpenAI）に送って、文字を読み取ることに同意します
            </ConsentBox>
            <AiRunButton
              testId="pptx-ai-run"
              cancelTestId="pptx-ai-cancel"
              disabled={!canRun}
              running={running}
              label={drafts ? "もう一度AIで読み取る" : "AIで読み取る"}
              consentGiven={consent}
              onClick={() => void run()}
              onCancel={() => abortRef.current?.abort()}
            />
          </div>
          {running && <AiProgress testId="pptx-ai-progress" seconds={elapsed} />}
          {running && progress && <p className="text-xs text-neutral-600 dark:text-neutral-300">{progress}</p>}
        </>
      )}

      {error && (
        <p role="alert" data-testid="pptx-ai-error" className="rounded-lg bg-red-50 px-3 py-2 text-red-800 dark:bg-red-950 dark:text-red-200">
          {error}
        </p>
      )}

      {drafts && candidates && (
        <div data-testid="pptx-ai-results" className="flex flex-col gap-3 border-t border-violet-200 pt-4 dark:border-violet-800">
          <StepLabel n={4} hint="AIは読み間違えることがあります。画像と見比べて、チェックと修正をしてください">
            読み取り結果
          </StepLabel>
          {rejected > 0 && <p className="text-xs text-amber-800 dark:text-amber-300">形式が正しくなかった{rejected}行は、使わずに捨てました。</p>}
          {Array.from(drafts.values()).every((l) => l.length === 0) && <p data-testid="pptx-ai-empty" className="text-sm">文字を読み取れませんでした。</p>}
          <ul className="flex flex-col gap-4">
            {candidates
              .filter((c) => (drafts.get(c.path) ?? []).length > 0)
              .map((c) => {
                const list = drafts.get(c.path) ?? [];
                return (
                  <li key={c.path} data-testid="pptx-ai-image" className="flex flex-col gap-2 rounded-xl border border-violet-200 bg-white p-3 dark:border-violet-800 dark:bg-neutral-950">
                    <p className="text-xs font-semibold text-neutral-800 dark:text-neutral-100">{c.label}</p>
                    <div className="relative w-full max-w-xl overflow-hidden rounded-lg border border-neutral-200 bg-white dark:border-neutral-700">
                      {/* eslint-disable-next-line @next/next/no-img-element -- 送った画像そのもの(data URL)の確認用の表示 */}
                      <img src={`data:${c.prepared.mediaType};base64,${c.prepared.base64}`} alt={`読み取った画像：${c.label}`} className="block w-full" />
                      {list.map((l) => (
                        <span
                          key={l.id}
                          aria-hidden="true"
                          className={`pointer-events-none absolute border-2 ${l.adopt && l.kind === "text" ? "border-violet-600 bg-violet-500/15" : "border-neutral-400 border-dashed"}`}
                          style={{ left: `${l.x * 100}%`, top: `${l.y * 100}%`, width: `${l.w * 100}%`, height: `${l.h * 100}%` }}
                        />
                      ))}
                    </div>
                    <ul className="flex flex-col gap-1.5">
                      {list.map((l) => {
                        const replaceable = l.kind === "text";
                        return (
                          <li key={l.id} data-testid="pptx-ai-line" data-kind={l.kind} className="flex flex-wrap items-center gap-2 text-xs">
                            <label className="flex items-center gap-1.5">
                              <input
                                type="checkbox"
                                data-testid="pptx-ai-line-adopt"
                                checked={l.adopt && replaceable}
                                disabled={!replaceable}
                                onChange={(e) => update(c.path, l.id, { adopt: e.target.checked })}
                                className="h-4 w-4 accent-violet-700"
                              />
                              <span className="font-mono text-neutral-500">{l.id}</span>
                            </label>
                            <input
                              type="text"
                              data-testid="pptx-ai-line-text"
                              value={l.text}
                              maxLength={200}
                              disabled={!replaceable}
                              onChange={(e) => update(c.path, l.id, { text: e.target.value })}
                              className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
                            />
                            {!replaceable && <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">{KIND_LABEL[l.kind]}</span>}
                            {replaceable && l.confidence !== "high" && (
                              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-900 dark:bg-amber-900 dark:text-amber-100">{l.confidence === "medium" ? "確度: 中" : "確度: 低"}</span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                );
              })}
          </ul>
          <div className="flex flex-col gap-1.5">
            <button
              type="button"
              data-testid="pptx-ai-apply"
              disabled={chosenCount === 0 || applying}
              aria-busy={applying || undefined}
              onClick={() => void apply()}
              className="w-full rounded-xl bg-violet-700 px-5 py-3 text-base font-bold text-white shadow-sm transition-colors hover:bg-violet-800 disabled:cursor-not-allowed disabled:opacity-40 sm:w-fit"
            >
              {applying ? "作成中…" : `チェックした${chosenCount}行を、本物の文字にする`}
            </button>
            <p className="text-xs text-neutral-600 dark:text-neutral-300">チェックした行は、画像から消して、テキストボックスとして重ねます。チェックしなかった行は、画像のままです。</p>
          </div>
        </div>
      )}

      {drafts && candidates && zoneLineCount > 0 && (
        <div data-testid="pptx-ai-zone" className="flex flex-col gap-2 rounded-xl border border-violet-200 bg-white p-3 text-xs text-neutral-700 dark:border-violet-800 dark:bg-neutral-950 dark:text-neutral-200">
          <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">もう一つの方法（試作）：画像のまま、AIの判断で反転し直す</p>
          <p>
            文字を消したり、入れ直したりしません。AIが見つけた文字の範囲（{zoneLineCount}行）の中だけ、文字のふちの色のにじみや、文字に重なった細い色を、白黒にそろえて反転します。
            位置やフォントは、元の画像のままです。
          </p>
          <button
            type="button"
            data-testid="pptx-ai-zone-apply"
            disabled={zoning}
            aria-busy={zoning || undefined}
            onClick={() => void applyZones()}
            className="w-full rounded-xl border border-violet-700 bg-white px-5 py-3 text-base font-bold text-violet-800 shadow-sm transition-colors hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-neutral-900 dark:text-violet-200 sm:w-fit"
          >
            {zoning ? "作成中…" : "画像のまま、AIの判断で反転し直す"}
          </button>
          <p className="text-neutral-500 dark:text-neutral-400">追加の料金はかかりません（すでに読み取った結果を使います）。</p>
        </div>
      )}

      {zoneOutput && (
        <div data-testid="pptx-ai-zone-output" className="flex flex-col gap-2 rounded-lg bg-white p-3 text-xs text-neutral-700 dark:bg-neutral-900 dark:text-neutral-200">
          <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            {zoneOutput.zoned > 0 ? `${zoneOutput.zoned}枚の画像で、AIの判断を使って反転し直しました` : "AIの判断を使える画像がありませんでした（通常の反転と同じ結果です）"}
          </p>
          {zoneOutput.notes.length > 0 && (
            <ul className="list-disc pl-5">
              {zoneOutput.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          <p className="text-neutral-500 dark:text-neutral-400">
            {zoneOutput.name}（{formatBytes(zoneOutput.blob.size)}）
          </p>
          <RewardedDownloadGate onDownload={() => downloadBlob(zoneOutput.blob, zoneOutput.name)} label="AIの判断で反転し直したPowerPointをダウンロード" />
        </div>
      )}

      {output && (
        <div data-testid="pptx-ai-output" className="flex flex-col gap-2 rounded-lg bg-white p-3 text-xs text-neutral-700 dark:bg-neutral-900 dark:text-neutral-200">
          <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            {output.report.lines}行を本物の文字にしました（{output.report.images}枚の画像から文字を消しました）
          </p>
          <ul className="list-disc pl-5">
            {output.report.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          <p className="text-neutral-500 dark:text-neutral-400">
            {output.name}（{formatBytes(output.blob.size)}）
          </p>
          <RewardedDownloadGate onDownload={() => downloadBlob(output.blob, output.name)} label="文字を置き換えたPowerPointをダウンロード" />
        </div>
      )}
    </div>
  );
}
