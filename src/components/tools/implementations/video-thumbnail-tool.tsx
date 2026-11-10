"use client";

import { useEffect, useRef, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { VideoSizeWarning } from "@/components/tools/implementations/shared/video-size-warning";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import {
  VideoThumbnailBatchProcessor,
  VideoThumbnailProcessor,
  type ThumbnailImageFormat,
  type VideoThumbnailBatchOutput,
  type VideoThumbnailOutput,
} from "@/lib/processors/browser/video-thumbnail";
import {
  EVEN_COUNT_CHOICES,
  INTERVAL_CHOICES,
  THUMBNAIL_MAX_COUNT,
  planEven,
  planFromInterval,
  planFromTimes,
  thumbnailFileNames,
  type ThumbnailMode,
} from "@/lib/video/thumbnail-plan";
import { formatTimeInput } from "@/lib/video/edit-settings";
import { createZip } from "@/lib/utils/zip";
import {
  VIDEO_INPUT_ACCEPT,
  VIDEO_DROPZONE_MAX_MB,
  VideoCanceledByUserError,
  thumbnailCanvasOptionsFor,
} from "@/lib/video/shared";
import { useRevokeObjectUrlOnChange, useVideoPreview } from "@/lib/video/use-video-preview";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";
import { PreviewFullscreenFrame } from "@/components/common/preview-fullscreen";
import { RunBar } from "@/components/ui/run-bar";

const FORMAT_OPTIONS: { value: ThumbnailImageFormat; label: string }[] = [
  { value: "png", label: "PNG" },
  { value: "jpeg", label: "JPEG" },
];

const MODE_OPTIONS: { value: ThumbnailMode; label: string; hint: string }[] = [
  { value: "single", label: "1枚（この時点）", hint: "動画の好きな時点を1枚取り出します。" },
  { value: "times", label: "指定した時刻", hint: "取り出したい時刻を並べて入れます。" },
  { value: "interval", label: "一定の間隔", hint: "0秒から、決まった秒数ごとに取り出します。" },
  { value: "even", label: "均等に", hint: "決めた枚数を、動画の最初から最後まで等しい間隔で取り出します。" },
];

/** 複数抽出の結果（画面に出すため、画像ごとの表示用URLとファイル名を付けたもの） */
interface BatchView {
  output: VideoThumbnailBatchOutput;
  urls: string[];
  names: string[];
  zipName: string;
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * 動画サムネイル・静止画抽出（Phase 10 / 動画ツール 6）。
 *
 * 6機能の中で最も軽量な実装：動画全体をデコード・再エンコードせず、
 * 指定した1時点のフレームだけを取り出す。
 *
 * スライダーの操作そのものでは毎回デコードを行わず（巨大動画を無駄に
 * 何度もdecodeしないため。開発指示書 26章）、「この時点を抽出」ボタンを
 * 押したタイミングでのみ実際のフレーム取得を行う。
 */
export function VideoThumbnailTool() {
  const [file, setFile] = useState<File | null>(null);
  const [timestamp, setTimestamp] = useState(0);
  const [format, setFormat] = useState<ThumbnailImageFormat>("png");
  const [jpegQuality, setJpegQuality] = useState(0.9);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VideoThumbnailOutput | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [wasCanceled, setWasCanceled] = useState(false);
  const cancelControllerRef = useRef<AbortController | null>(null);
  // 実行ごとの番号。動画を消した・選び直したあとに、前の処理の結果が遅れて届いても表示しないために使う
  const runIdRef = useRef(0);

  // 工程4：複数抽出
  const [mode, setMode] = useState<ThumbnailMode>("single");
  const [timesText, setTimesText] = useState("");
  const [intervalSec, setIntervalSec] = useState<number>(10);
  const [evenCount, setEvenCount] = useState<number>(5);
  const [batch, setBatch] = useState<BatchView | null>(null);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);
  const [zipping, setZipping] = useState(false);

  const { previewUrl, meta, handleLoadedMetadata } = useVideoPreview(file);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // 出力画像の解像度（長辺が上限を超える場合は縮小される。抽出処理と同じ規則）
  const outputSize = (() => {
    if (!meta || meta.width <= 0) return { width: 0, height: 0 };
    const opt = thumbnailCanvasOptionsFor(meta.width, meta.height);
    if (opt.width !== undefined) {
      return { width: opt.width, height: Math.round((meta.height * opt.width) / meta.width) };
    }
    if (opt.height !== undefined) {
      return { width: Math.round((meta.width * opt.height) / meta.height), height: opt.height };
    }
    return { width: meta.width, height: meta.height };
  })();
  const outputWidth = outputSize.width;
  const outputHeight = outputSize.height;

  // スライダーを動かすと、その時点のフレームを<video>に表示する（抽出する時点と一致）
  function seekTo(t: number) {
    setTimestamp(t);
    const v = videoRef.current;
    if (v) {
      v.pause();
      v.currentTime = t;
    }
  }

  // 動画側の操作（再生・シークバー）でも抽出する時点を同期する
  function syncTimestampFromVideo(e: React.SyntheticEvent<HTMLVideoElement>) {
    setTimestamp(e.currentTarget.currentTime);
  }
  useRevokeObjectUrlOnChange(result?.url);
  // 複数抽出の表示用URLは、結果が変わったとき・画面を離れるときに手放す
  useEffect(() => {
    return () => {
      batch?.urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [batch]);

  // タブ遷移やアンマウント時にも、実行中の処理を実際に中断する。
  useEffect(() => {
    return () => {
      cancelControllerRef.current?.abort();
    };
  }, []);

  function handleSelect(files: File[]) {
    // 前の動画の処理が残っていれば止め、その結果を新しい動画に表示しない
    runIdRef.current++;
    cancelControllerRef.current?.abort();
    cancelControllerRef.current = null;
    setFile(files[0]);
    setResult(null);
    setBatch(null);
    setBatchProgress(null);
    setStatus("idle");
    setError(null);
    setTimestamp(0);
    setWasCanceled(false);
  }

  async function handleExtract() {
    if (!file) return;
    const controller = new AbortController();
    cancelControllerRef.current = controller;
    const runId = ++runIdRef.current;
    setStatus("processing");
    setError(null);
    setResult(null);
    setWasCanceled(false);
    setCanceling(false);

    try {
      const output = await new VideoThumbnailProcessor().process({
        file,
        timestampSec: timestamp,
        format,
        jpegQuality,
        cancelSignal: controller.signal,
      });
      if (runIdRef.current !== runId) return;
      setResult(output);
      setStatus("success");
    } catch (e) {
      if (runIdRef.current !== runId) return;
      if (e instanceof VideoCanceledByUserError) {
        setWasCanceled(true);
        setStatus("idle");
      } else {
        setError(e instanceof Error ? e.message : "処理に失敗しました");
        setStatus("error");
      }
    } finally {
      if (runIdRef.current === runId) {
        setCanceling(false);
        cancelControllerRef.current = null;
      }
    }
  }

  // 選んだ動画を消したときは、前の動画の結果・進み具合・エラー・案内をすべて消し、処理中なら止める
  function handleRemove() {
    runIdRef.current++;
    cancelControllerRef.current?.abort();
    cancelControllerRef.current = null;
    setFile(null);
    setResult(null);
    setBatch(null);
    setBatchProgress(null);
    setStatus("idle");
    setError(null);
    setWasCanceled(false);
    setCanceling(false);
  }

  const durationSec = meta?.durationSec ?? 0;
  const plan =
    mode === "times"
      ? planFromTimes(timesText, durationSec)
      : mode === "interval"
        ? planFromInterval(intervalSec, durationSec)
        : mode === "even"
          ? planEven(evenCount, durationSec)
          : null;

  function changeMode(next: ThumbnailMode) {
    setMode(next);
    setResult(null);
    setBatch(null);
    setError(null);
    setWasCanceled(false);
    if (status !== "processing") setStatus("idle");
  }

  /** 動画の今の位置を、指定した時刻の一覧に足す */
  function addCurrentTime() {
    const t = formatTimeInput(timestamp);
    setTimesText((cur) => (cur.trim() === "" ? t : `${cur.replace(/[\s,、]+$/, "")}\n${t}`));
  }

  async function handleBatchExtract() {
    if (!file || !plan || plan.error || plan.times.length === 0) return;
    const controller = new AbortController();
    cancelControllerRef.current = controller;
    const runId = ++runIdRef.current;
    setStatus("processing");
    setError(null);
    setResult(null);
    setBatch(null);
    setWasCanceled(false);
    setCanceling(false);
    setBatchProgress({ done: 0, total: plan.times.length });
    try {
      const output = await new VideoThumbnailBatchProcessor().process({
        file,
        times: plan.times,
        format,
        jpegQuality,
        cancelSignal: controller.signal,
        onProgress: (done, total) => {
          if (runIdRef.current === runId) setBatchProgress({ done, total });
        },
      });
      if (runIdRef.current !== runId) return;
      const ext = output.format === "png" ? "png" : "jpg";
      const base = stripExtension(file.name);
      setBatch({
        output,
        urls: output.items.map((it) => URL.createObjectURL(it.blob)),
        names: thumbnailFileNames(base, output.items.map((it) => it.timestampSec), ext),
        zipName: `${base}-thumbnails.zip`,
      });
      if (output.failures.length > 0) {
        // 一部を取り出せなかったときは、成功と区別して知らせる
        setError(
          `${output.failures.length}枚を取り出せませんでした（${output.failures
            .slice(0, 5)
            .map((f) => formatTimeInput(f.timestampSec))
            .join("、")}）。取り出せた${output.items.length}枚だけを表示しています。`
        );
        setStatus("error");
      } else {
        setStatus("success");
      }
    } catch (e) {
      if (runIdRef.current !== runId) return;
      if (e instanceof VideoCanceledByUserError) {
        setWasCanceled(true);
        setStatus("idle");
      } else {
        setError(e instanceof Error ? e.message : "処理に失敗しました");
        setStatus("error");
      }
    } finally {
      if (runIdRef.current === runId) {
        setCanceling(false);
        setBatchProgress(null);
        cancelControllerRef.current = null;
      }
    }
  }

  async function handleZipDownload() {
    if (!batch) return;
    setZipping(true);
    try {
      const zip = await createZip(batch.output.items.map((it, i) => ({ name: batch.names[i], blob: it.blob })));
      downloadBlob(zip, batch.zipName);
    } catch (e) {
      setError(e instanceof Error ? e.message : "ZIPファイルを作成できませんでした");
    } finally {
      setZipping(false);
    }
  }

  function handleCancel() {
    if (!cancelControllerRef.current) return;
    setCanceling(true);
    cancelControllerRef.current.abort();
  }

  function handleDownload() {
    if (!file || !result) return;
    downloadBlob(result.blob, `${stripExtension(file.name)}-thumbnail.${result.format === "png" ? "png" : "jpg"}`);
  }

  return (
    <div className="flex flex-col gap-6">

      <FileDropzone
        compact={!!file}
        accept={VIDEO_INPUT_ACCEPT}
        maxSizeMB={VIDEO_DROPZONE_MAX_MB}
        label="動画ファイルをドラッグ&ドロップ"
        hint="またはタップして選択（MP4 / MOV / WebM）"
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={handleRemove} />}
      {file && <VideoSizeWarning sizeBytes={file.size} />}

      {file && (
        <fieldset className="flex flex-col gap-2" data-testid="thumb-mode">
          <legend className="text-sm font-medium text-neutral-700 dark:text-neutral-200">取り出し方</legend>
          <div className="flex flex-wrap gap-2">
            {MODE_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className={`cursor-pointer rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                  mode === opt.value
                    ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
                    : "border-neutral-300 text-neutral-600 hover:border-blue-400 dark:border-neutral-700 dark:text-neutral-300"
                }`}
              >
                <input
                  type="radio"
                  name="thumbnail-mode"
                  value={opt.value}
                  checked={mode === opt.value}
                  onChange={() => changeMode(opt.value)}
                  disabled={status === "processing"}
                  className="sr-only"
                />
                {opt.label}
              </label>
            ))}
          </div>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {MODE_OPTIONS.find((o) => o.value === mode)?.hint}
            {mode !== "single" && ` 一度に${THUMBNAIL_MAX_COUNT}枚まで。まとめてZIPで保存できます。`}
          </p>
        </fieldset>
      )}

      {file && previewUrl && (
        <PreviewFullscreenFrame>
        <section
          data-testid="tool-preview"
          aria-label="抽出するフレームのプレビュー"
          className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800"
        >
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">この時点のフレーム</p>
          <video
            ref={videoRef}
            src={previewUrl}
            onLoadedMetadata={handleLoadedMetadata}
            onSeeked={syncTimestampFromVideo}
            onTimeUpdate={syncTimestampFromVideo}
            controls
            playsInline
            preload="auto"
            className="block mx-auto h-auto w-auto max-w-full max-h-[min(60vh,30rem)] rounded-lg bg-black"
          />

          {meta && meta.durationSec > 0 && (
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
                抽出する時点: {formatTime(timestamp)} / {formatTime(meta.durationSec)}
              </label>
              <input
                type="range"
                min={0}
                max={meta.durationSec}
                step={0.1}
                value={timestamp}
                onChange={(e) => seekTo(Number(e.target.value))}
                aria-label="抽出する時点"
                className="w-full"
              />
            </div>
          )}

          {mode !== "single" && plan && (
            <div className="flex flex-col gap-2 border-t border-neutral-100 pt-3 dark:border-neutral-800" data-testid="thumb-plan">
              {mode === "times" && (
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="thumb-times" className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
                    取り出す時刻（1行に1つ。「,」で区切っても可）
                  </label>
                  <textarea
                    id="thumb-times"
                    value={timesText}
                    onChange={(e) => setTimesText(e.target.value)}
                    rows={4}
                    placeholder={"0:05\n0:15\n0:30\n1:00"}
                    className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
                    data-testid="thumb-times"
                  />
                  <button
                    type="button"
                    onClick={addCurrentTime}
                    className="w-fit rounded-md bg-neutral-100 px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-200"
                    data-testid="thumb-add-current"
                  >
                    今の位置（{formatTimeInput(timestamp)}）を足す
                  </button>
                </div>
              )}
              {mode === "interval" && (
                <ChoiceRow
                  legend="間隔"
                  name="thumb-interval"
                  options={INTERVAL_CHOICES.map((v) => ({ value: v, label: `${v}秒ごと` }))}
                  value={intervalSec}
                  onChange={setIntervalSec}
                />
              )}
              {mode === "even" && (
                <ChoiceRow
                  legend="枚数"
                  name="thumb-even"
                  options={EVEN_COUNT_CHOICES.map((v) => ({ value: v, label: `${v}枚` }))}
                  value={evenCount}
                  onChange={setEvenCount}
                />
              )}
              {plan.error ? (
                <p className="text-xs text-red-600 dark:text-red-400" data-testid="thumb-plan-error">
                  {plan.error}
                </p>
              ) : (
                <p className="text-xs text-neutral-600 dark:text-neutral-300" data-testid="thumb-plan-summary">
                  {plan.times.length}枚を取り出します：{plan.times.slice(0, 12).map((t) => formatTimeInput(t)).join("、")}
                  {plan.times.length > 12 ? " …" : ""}
                </p>
              )}
              {!plan.error && plan.note && <p className="text-xs text-neutral-500 dark:text-neutral-400">{plan.note}</p>}
            </div>
          )}

          {meta && meta.width > 0 && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              出力画像: {outputWidth}×{outputHeight}（{format === "png" ? "PNG" : `JPEG・品質${Math.round(jpegQuality * 100)}%`}）
            </p>
          )}
        </section>
        </PreviewFullscreenFrame>
      )}

      {file && (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-neutral-700 dark:text-neutral-200">画像形式</legend>
          <div className="flex flex-wrap gap-2">
            {FORMAT_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className={`cursor-pointer rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                  format === opt.value
                    ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
                    : "border-neutral-300 text-neutral-600 hover:border-blue-400 dark:border-neutral-700 dark:text-neutral-300"
                }`}
              >
                <input
                  type="radio"
                  name="thumbnail-format"
                  value={opt.value}
                  checked={format === opt.value}
                  onChange={() => setFormat(opt.value)}
                  className="sr-only"
                />
                {opt.label}
              </label>
            ))}
          </div>
          {format === "jpeg" && (
            <div className="flex items-center gap-2">
              <label className="text-xs text-neutral-500 dark:text-neutral-400">
                JPEG品質: {Math.round(jpegQuality * 100)}%
              </label>
              <input
                type="range"
                min={0.3}
                max={1}
                step={0.05}
                value={jpegQuality}
                onChange={(e) => setJpegQuality(Number(e.target.value))}
                className="flex-1"
              />
            </div>
          )}
        </fieldset>
      )}

      {file && (
        <RunBar>
          {mode === "single" ? (
            <button
              type="button"
              onClick={handleExtract}
              disabled={status === "processing"} aria-busy={status === "processing" || undefined}
              className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              この時点を抽出する
            </button>
          ) : (
            <button
              type="button"
              onClick={handleBatchExtract}
              disabled={status === "processing" || !plan || plan.error !== null || plan.times.length === 0}
              aria-busy={status === "processing" || undefined}
              className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
              data-testid="thumb-batch-run"
            >
              {plan && !plan.error && plan.times.length > 0 ? `${plan.times.length}枚をまとめて抽出する` : "まとめて抽出する"}
            </button>
          )}
        </RunBar>
      )}

      <ProcessingStatus
        state={status}
        processingLabel={batchProgress ? `${batchProgress.done} / ${batchProgress.total} 枚を抽出中...` : "抽出中..."}
        successLabel={batch ? `${batch.output.items.length}枚の画像を抽出しました` : "画像の抽出が完了しました"}
        onCancel={handleCancel}
        canceling={canceling}
      />
      {wasCanceled && (
        <div className="flex items-start gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">処理をキャンセルしました。</div>
      )}
      {error && <ErrorMessage message={error} />}

      {batch && (
        <section aria-label="抽出した画像" className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800" data-testid="thumb-results">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100" data-testid="thumb-results-summary">
              {batch.output.items.length}枚
              {batch.output.failures.length > 0 && `（${batch.output.failures.length}枚は失敗）`}
              {batch.output.sameFrameSkipped > 0 && `（同じコマになる${batch.output.sameFrameSkipped}枚は省きました）`}
            </p>
          </div>
          {batch.output.items.length > 1 ? (
            <RewardedDownloadGate
              onDownload={handleZipDownload}
              disabled={zipping}
              label={zipping ? "ZIPを作成中..." : batch.output.failures.length > 0 ? `取り出せた${batch.output.items.length}枚をZIPで保存` : `${batch.output.items.length}枚をZIPで保存`}
            />
          ) : (
            <RewardedDownloadGate onDownload={() => downloadBlob(batch.output.items[0].blob, batch.names[0])} label="画像をダウンロード" />
          )}
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {batch.output.items.map((it, i) => (
              <li key={batch.names[i]} className="flex min-w-0 flex-col gap-1" data-testid="thumb-item">
                {/* eslint-disable-next-line @next/next/no-img-element -- ブラウザ内で作った画像のプレビュー */}
                <img src={batch.urls[i]} alt={`${formatTimeInput(it.timestampSec)}の画像`} className="aspect-video w-full rounded-md border border-neutral-200 bg-black object-contain dark:border-neutral-800" />
                <span className="text-xs font-medium text-neutral-800 dark:text-neutral-100" data-testid="thumb-item-time">
                  {formatTimeInput(it.timestampSec)}
                </span>
                <span className="truncate text-[11px] text-neutral-500 dark:text-neutral-400" title={batch.names[i]} data-testid="thumb-item-name">
                  {batch.names[i]}（{formatBytes(it.blob.size)}）
                </span>
                <button
                  type="button"
                  onClick={() => downloadBlob(it.blob, batch.names[i])}
                  aria-label={`${batch.names[i]}を保存`}
                  className="w-fit rounded-md border border-neutral-300 px-2.5 py-1 text-xs text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-200"
                  data-testid="thumb-item-save"
                >
                  保存
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {result && (
        <ResultPopup>
          {/* eslint-disable-next-line @next/next/no-img-element -- ブラウザ内で生成したObject URLのプレビューのため next/image は不要 */}
          <img src={result.url} alt="抽出したサムネイル" className="max-h-64 max-w-full rounded-lg border border-neutral-200 dark:border-neutral-800" />
          <RewardedDownloadGate onDownload={handleDownload} label="画像をダウンロード" />
        </ResultPopup>
      )}
    </div>
  );
}

/** 数値の選択肢のボタン（間隔・枚数） */
function ChoiceRow({
  legend,
  name,
  options,
  value,
  onChange,
}: {
  legend: string;
  name: string;
  options: { value: number; label: string }[];
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-sm font-medium text-neutral-700 dark:text-neutral-200">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => (
          <label
            key={opt.value}
            className={`cursor-pointer rounded-lg border px-3 py-1.5 text-sm transition-colors ${
              value === opt.value
                ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
                : "border-neutral-300 text-neutral-600 hover:border-blue-400 dark:border-neutral-700 dark:text-neutral-300"
            }`}
          >
            <input type="radio" name={name} value={opt.value} checked={value === opt.value} onChange={() => onChange(opt.value)} className="sr-only" />
            {opt.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
