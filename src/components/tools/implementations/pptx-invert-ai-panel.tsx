"use client";

import { useEffect, useRef, useState } from "react";
import { unzipSync } from "fflate";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { prepareImageBytes, type PreparedImage } from "@/lib/calendar/event-image";
import { PPTX_TEXT_CONSENT_VERSION, PPTX_TEXT_MAX_IMAGES_PER_REQUEST, type PptxTextLine } from "@/lib/ai/pptx-text";
import type { AiModelTier } from "@/lib/ai/pricing";
import { sniffRasterKind } from "@/lib/pptx/image-invert";
import { invertPptx } from "@/lib/pptx/invert-pptx";
import { scanSlidePictures } from "@/lib/pptx/slide-pictures";
import { buildTextZoneMask, ZONE_KINDS, type ZoneLine } from "@/lib/pptx/text-zones";
import { PPTX_MIME, type PptxInvertOutput } from "@/lib/processors/browser/pptx-invert";
import { stripExtension, downloadBlob } from "@/lib/utils/format";
import {
  AI_PANEL_CLASS,
  AiPanelHeader,
  AiProgress,
  AiRunButton,
  AiUnavailableNotice,
  AiUsageMeter,
  ConsentBox,
  TierPicker,
  type AiUsage,
} from "./shared/ai-panel-parts";
import { ImageCompare } from "./shared/image-compare";

/**
 * 変換した .pptx の、白黒の反転を、AIの判断を使って、よりきれいにする（プレミアム）。
 *
 * - AIは「判断」だけをする。画像の中の、文字の行の位置を見つけてもらう。文字の書き換えや、画像の作り直しはしない。
 * - その位置（文字の範囲）の中だけ、文字のふちの色のにじみや、文字に重なった細い色を、白黒にそろえて反転する。画像は画像のまま。
 * - AIへ送るのは、変換前の（白地・黒文字の）画像を縮小したものだけ。元のファイルそのものは送らない。
 * - 毎回、送る画像を確認して同意してから実行する。送った画像も結果も、サービスには保存しない。
 */

interface Candidate {
  path: string;
  label: string;
  prepared: PreparedImage;
}

type UsageState =
  | { status: "loading" }
  | ({ status: "available" } & AiUsage)
  | { status: "unavailable"; reason: "login_required" | "not_premium" | "unavailable" };

const UNAVAILABLE_TEXT: Record<"login_required" | "not_premium" | "unavailable", string> = {
  login_required: "AIの判断で反転するには、ログインが必要です。",
  not_premium: "AIの判断で反転する機能は、プレミアムプランの機能です。",
  unavailable: "AIによる判断は、現在ご利用いただけません。通常の白黒反転は、そのままご利用いただけます。",
};

const MAX_CANDIDATES = 12;
/** 候補にする画像の、縦横の最小（これより小さい画像は、飾りや記号として扱う） */
const MIN_SIDE = 160;

/** AIの判断を使った結果（比べて見せるための、通常の変換との画像のペア） */
interface Judged {
  blob: Blob;
  name: string;
  /** AIが見つけた文字の行の数 */
  lineCount: number;
  rows: { path: string; label: string; normal?: Uint8Array; judged?: Uint8Array; mime?: string }[];
  notes: string[];
}

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
  const [judged, setJudged] = useState<Judged | null>(null);
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
        if (skipped > 0) notes.push(`回転した画像・グループの中の画像（${skipped}枚）は、対象外です。`);
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

  /** AIが見つけた文字の行の範囲を使って、画像のまま、反転し直す（文字を消したり入れ直したりしない） */
  async function invertWithZones(byPath: Map<string, ZoneLine[]>, lineCount: number, labels: Map<string, string>) {
    const original = new Uint8Array(await file.arrayBuffer());
    const done = await invertPptx(original, {
      ...result.options,
      textZoneFor: (path, image) => {
        const lines = byPath.get(path);
        return lines ? buildTextZoneMask(image, lines) : null;
      },
    });
    const blob = new Blob([done.bytes as BlobPart], { type: PPTX_MIME });
    const rows = done.report.images
      .filter((i) => i.zoned)
      .map((i) => ({
        path: i.path,
        label: labels.get(i.path) ?? (i.path.split("/").pop() ?? i.path),
        normal: result.report.images.find((n) => n.path === i.path)?.after,
        judged: i.after,
        mime: i.mime,
      }));
    setJudged({
      blob,
      name: `${stripExtension(result.suggestedName)}_AI判断.pptx`,
      lineCount,
      rows,
      notes: done.report.notes.filter((n) => n.startsWith("AIが見つけた文字の範囲")),
    });
  }

  async function run() {
    if (!canRun || runningRef.current || !candidates) return;
    runningRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    setElapsed(0);
    setRunning(true);
    setError(null);
    setJudged(null);
    const byPath = new Map<string, ZoneLine[]>();
    let lineCount = 0;
    let failed = false;
    let aborted = false;
    try {
      const batches: Candidate[][] = [];
      for (let i = 0; i < candidates.length; i += PPTX_TEXT_MAX_IMAGES_PER_REQUEST) batches.push(candidates.slice(i, i + PPTX_TEXT_MAX_IMAGES_PER_REQUEST));
      for (let b = 0; b < batches.length; b++) {
        const batch = batches[b];
        setProgress(batches.length > 1 ? `${b + 1}/${batches.length}回目を判断しています…` : "");
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
            (typeof data?.message === "string" ? data.message : res.status === 413 ? "送る画像が大きすぎます。" : "AIによる判断に失敗しました。") +
              (lineCount > 0 ? "（ここまでに判断できた分で、反転しています）" : ""),
          );
          if (data?.usage) setUsage((u) => (u.status === "available" ? { ...u, ...data.usage } : u));
          failed = true;
          break;
        }
        for (const line of data.lines as PptxTextLine[]) {
          const target = batch[line.image - 1];
          // 文字・数式の行だけを、範囲にする（確度が低い行は、使わない）
          if (!target || !ZONE_KINDS.has(line.kind) || line.confidence === "low") continue;
          const list = byPath.get(target.path) ?? [];
          list.push({ x: line.x, y: line.y, w: line.w, h: line.h });
          byPath.set(target.path, list);
          lineCount++;
        }
        if (data.usage) setUsage({ status: "available", ...data.usage });
      }
    } catch (e) {
      aborted = true;
      setError(
        e instanceof DOMException && e.name === "AbortError"
          ? "判断を中止しました（または、AIの応答を待つ時間を超えました）。利用枠が消費されている場合があります。"
          : "通信に失敗しました。",
      );
    }
    try {
      // 失敗しても、判断できた分があれば、それを使って反転する
      if (lineCount > 0) {
        setProgress("AIの判断を使って、反転しています…");
        await invertWithZones(byPath, lineCount, new Map(candidates.map((c) => [c.path, c.label])));
      } else if (!failed && !aborted) {
        setJudged({ blob: result.blob, name: result.suggestedName, lineCount: 0, rows: [], notes: [] });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "反転に失敗しました。");
    } finally {
      abortRef.current = null;
      runningRef.current = false;
      setRunning(false);
      setProgress("");
      // 同意は毎回確認する（実行のたびに外れる）
      setConsent(false);
    }
  }

  return (
    <div data-testid="pptx-ai" className={AI_PANEL_CLASS}>
      <AiPanelHeader title="AIできれいに反転する" />

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
        <p data-testid="pptx-ai-none" className="rounded-lg bg-white px-3 py-2 text-sm text-neutral-700 dark:bg-neutral-900 dark:text-neutral-200">
          AIで判断できる画像（白地に黒文字の画像）が見つかりませんでした。通常の変換のままで、お使いください。{prepareNote}
        </p>
      )}

      {candidates && candidates.length > 0 && (
        <>
          <div className="flex flex-col gap-2" data-testid="pptx-ai-send-preview">
            <ul className="flex flex-wrap gap-3">
              {candidates.map((c) => (
                <li key={c.path} className="flex w-36 flex-col gap-1">
                  {/* eslint-disable-next-line @next/next/no-img-element -- 送る画像そのもの(data URL)の確認用の表示 */}
                  <img src={`data:${c.prepared.mediaType};base64,${c.prepared.base64}`} alt={`AIに送る画像：${c.label}`} className="h-28 w-36 rounded-lg border border-violet-200 bg-white object-contain shadow-sm dark:border-violet-800" />
                  <span className="break-all text-xs text-neutral-700 dark:text-neutral-200">{c.label}</span>
                </li>
              ))}
            </ul>
            <p data-testid="pptx-ai-send-count" className="text-xs text-neutral-700 dark:text-neutral-200">
              送る画像：{candidates.length}枚
            </p>
            {prepareNote && <p className="text-xs text-neutral-600 dark:text-neutral-300">{prepareNote}</p>}
          </div>

          <div className="flex flex-col gap-2">
            <TierPicker name="pptx-ai-tier" value={tier} onChange={setTier} standardTestId="pptx-ai-tier-standard" advancedTestId="pptx-ai-tier-advanced" advancedHint="小さい文字・細かい表向け" />
          </div>

          <div className="flex flex-col gap-2">
            <ConsentBox testId="pptx-ai-consent" checked={consent} onChange={setConsent}>
              上の画像（{candidates.length}枚）を、AI（OpenAI）に送って、文字の位置を判断してもらうことに同意します
            </ConsentBox>
            <AiRunButton
              testId="pptx-ai-run"
              cancelTestId="pptx-ai-cancel"
              disabled={!canRun}
              running={running}
              label={judged ? "もう一度、AIで判断して反転する" : "AIで判断して反転する"}
              consentGiven={consent}
              onClick={() => void run()}
              onCancel={() => abortRef.current?.abort()}
            />
          </div>
          {running && <AiProgress testId="pptx-ai-progress" seconds={elapsed} />}
          {running && progress && <p className="text-sm text-neutral-700 dark:text-neutral-200">{progress}</p>}
        </>
      )}

      {error && (
        <p role="alert" data-testid="pptx-ai-error" className="rounded-lg bg-red-50 px-3 py-2 text-red-800 dark:bg-red-950 dark:text-red-200">
          {error}
        </p>
      )}

      {judged && (
        <div data-testid="pptx-ai-result" className="flex flex-col gap-3 border-t border-violet-200 pt-4 dark:border-violet-800">
          <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            {judged.rows.length > 0 ? "AIで反転しました" : "AIが文字を見つけられなかったため、通常の変換と同じ結果です"}
          </p>
          {judged.rows.length > 0 && (
            <ul className="flex flex-col gap-4" data-testid="pptx-ai-compare">
              {judged.rows.map((r) => (
                <li key={r.path} data-testid="pptx-ai-compare-row" className="flex flex-col gap-2 rounded-xl border border-violet-200 bg-white p-3 dark:border-violet-800 dark:bg-neutral-950">
                  <ImageCompare
                    items={[
                      { label: "通常の変換", bytes: r.normal, mime: r.mime, dark: true },
                      { label: "AIの判断あり", bytes: r.judged, mime: r.mime, dark: true },
                    ]}
                  />
                </li>
              ))}
            </ul>
          )}
          <RewardedDownloadGate onDownload={() => downloadBlob(judged.blob, judged.name)} label="AI版のPowerPointをダウンロード" />
        </div>
      )}
    </div>
  );
}
