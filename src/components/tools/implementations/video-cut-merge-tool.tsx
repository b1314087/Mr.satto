"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { ResultPopup } from "@/components/common/result-popup";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { VideoSizeWarning } from "@/components/tools/implementations/shared/video-size-warning";
import { VideoOutputPlayer, VideoPreviewPanel } from "@/components/tools/implementations/shared/video-preview-panel";
import { RunBar } from "@/components/ui/run-bar";
import { Segmented } from "@/components/ui/segmented";
import { StepHeading } from "@/components/ui/step-heading";
import { VideoCutMergeProcessor, validateClips, MAX_CLIPS, type VideoCutMergeOutput } from "@/lib/processors/browser/video-cut-merge";
import { OUTPUT_CONTAINER_OPTIONS, VIDEO_DROPZONE_MAX_MB, VIDEO_INPUT_ACCEPT, VideoCanceledByUserError, inspectVideoFile, type OutputContainer } from "@/lib/video/shared";
import { formatTimeInput, parseTimeInput } from "@/lib/video/edit-settings";
import { formatDuration } from "@/lib/video/estimate";
import { useRevokeObjectUrlOnChange, useVideoPreview } from "@/lib/video/use-video-preview";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";
import { useAnnounceToolMode } from "@/lib/guides/tool-mode";

type Mode = "cut" | "merge";

interface Segment {
  id: number;
  start: string;
  end: string;
}

interface MergeItem {
  id: number;
  file: File;
  url: string;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean | null;
  error: string | null;
}

const MAX_MERGE_FILES = 20;

/** 入力欄の文字を秒にする（空・読めない値は null） */
function toSec(text: string): number | null {
  const v = parseTimeInput(text);
  return v === null || Number.isNaN(v) ? null : v;
}

/**
 * 動画カット・結合（次期機能追加 3）。
 * - 「不要部分を削除」：1本の動画の、残したい区間（開始・終了）をいくつでも入れ、上から順につなぐ。
 * - 「複数の動画を結合」：複数の動画を並べ、上から順に1本につなぐ（↑↓で順番を変えられる。それぞれ再生して確かめられる）。
 * 処理はすべてブラウザの中（src/lib/processors/browser/video-cut-merge.ts）。進み具合の表示・キャンセルができる。
 */
export function VideoCutMergeTool({ initialMode = "cut" }: { initialMode?: Mode }) {
  const [mode, setMode] = useState<Mode>(initialMode);
  useAnnounceToolMode(mode);
  const [container, setContainer] = useState<OutputContainer>("mp4");

  // 不要部分を削除
  const [file, setFile] = useState<File | null>(null);
  const [segments, setSegments] = useState<Segment[]>([{ id: 1, start: "", end: "" }]);
  const { previewUrl, meta, handleLoadedMetadata } = useVideoPreview(mode === "cut" ? file : null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const nextId = useRef(2);

  // 複数の動画を結合
  const [items, setItems] = useState<MergeItem[]>([]);
  const itemsRef = useRef<MergeItem[]>([]);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  useEffect(() => () => itemsRef.current.forEach((it) => URL.revokeObjectURL(it.url)), []);

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VideoCutMergeOutput | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [wasCanceled, setWasCanceled] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const runIdRef = useRef(0);
  useRevokeObjectUrlOnChange(result?.url);

  function resetResult() {
    runIdRef.current++;
    controllerRef.current?.abort();
    controllerRef.current = null;
    setResult(null);
    setStatus("idle");
    setError(null);
    setProgress(0);
    setWasCanceled(false);
    setCanceling(false);
  }

  // ---- 不要部分を削除 ----
  const duration = meta?.durationSec ?? 0;
  const clipsForCut = useMemo(
    () =>
      file
        ? segments.map((s) => ({ file, start: toSec(s.start) ?? 0, end: toSec(s.end) ?? duration, durationSec: duration }))
        : [],
    [file, segments, duration]
  );
  const keptSec = clipsForCut.reduce((sum, c) => sum + Math.max(0, c.end - c.start), 0);

  function updateSegment(id: number, patch: Partial<Segment>) {
    setSegments((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    resetResult();
  }
  function fromPlayer(id: number, which: "start" | "end") {
    const t = videoRef.current?.currentTime;
    if (t === undefined || !Number.isFinite(t)) return;
    updateSegment(id, { [which]: formatTimeInput(t) });
  }
  function moveSegment(index: number, dir: -1 | 1) {
    setSegments((prev) => {
      const next = [...prev];
      const to = index + dir;
      if (to < 0 || to >= next.length) return prev;
      [next[index], next[to]] = [next[to], next[index]];
      return next;
    });
    resetResult();
  }

  // ---- 複数の動画を結合 ----
  async function addMergeFiles(files: File[]) {
    const room = MAX_MERGE_FILES - items.length;
    const picked = files.slice(0, Math.max(0, room));
    if (files.length > picked.length) setError(`結合できる動画は${MAX_MERGE_FILES}本までです。`);
    const added: MergeItem[] = picked.map((f) => ({
      id: nextId.current++,
      file: f,
      url: URL.createObjectURL(f),
      durationSec: null,
      width: null,
      height: null,
      hasAudio: null,
      error: null,
    }));
    setItems((prev) => [...prev, ...added]);
    resetResult();
    for (const it of added) {
      try {
        const info = await inspectVideoFile(it.file);
        const patch = { durationSec: info.durationSec, width: info.displayWidth, height: info.displayHeight, hasAudio: info.hasAudio };
        info.input.dispose();
        setItems((prev) => prev.map((p) => (p.id === it.id ? { ...p, ...patch } : p)));
      } catch (e) {
        const message = e instanceof Error ? e.message : "動画を読み込めませんでした。";
        setItems((prev) => prev.map((p) => (p.id === it.id ? { ...p, error: message } : p)));
      }
    }
  }
  function moveItem(index: number, dir: -1 | 1) {
    setItems((prev) => {
      const next = [...prev];
      const to = index + dir;
      if (to < 0 || to >= next.length) return prev;
      [next[index], next[to]] = [next[to], next[index]];
      return next;
    });
    resetResult();
  }
  function removeItem(id: number) {
    setItems((prev) => {
      const target = prev.find((p) => p.id === id);
      if (target) URL.revokeObjectURL(target.url);
      return prev.filter((p) => p.id !== id);
    });
    resetResult();
  }
  const mergeReady = items.length >= 2 && items.every((it) => it.durationSec !== null && !it.error);
  const mergeTotal = items.reduce((sum, it) => sum + (it.durationSec ?? 0), 0);
  const mixedSizes =
    items.length >= 2 &&
    items.some((it) => it.width && it.height && items[0].width && items[0].height && Math.abs(it.width / it.height - items[0].width / items[0].height) > 0.01);

  // ---- 実行 ----
  const cutProblem = mode === "cut" && file && duration > 0 ? validateClips(clipsForCut) : null;
  const canRun =
    status !== "processing" && (mode === "cut" ? !!file && duration > 0 && !cutProblem : mergeReady);

  async function handleRun() {
    const clips =
      mode === "cut"
        ? clipsForCut.map(({ file: f, start, end }) => ({ file: f, start, end }))
        : items.map((it) => ({ file: it.file, start: 0, end: it.durationSec ?? 0 }));
    const controller = new AbortController();
    controllerRef.current = controller;
    const runId = ++runIdRef.current;
    setStatus("processing");
    setError(null);
    setResult(null);
    setProgress(0);
    setWasCanceled(false);
    setCanceling(false);
    try {
      const out = await new VideoCutMergeProcessor().process({ clips, container, onProgress: setProgress, cancelSignal: controller.signal });
      if (runIdRef.current !== runId) {
        URL.revokeObjectURL(out.url);
        return;
      }
      setResult(out);
      setStatus("success");
    } catch (e) {
      if (runIdRef.current !== runId) return;
      if (e instanceof VideoCanceledByUserError) {
        setWasCanceled(true);
        setStatus("idle");
      } else {
        setError(e instanceof Error ? e.message : "動画を作成できませんでした");
        setStatus("error");
      }
    } finally {
      if (runIdRef.current === runId) {
        setCanceling(false);
        controllerRef.current = null;
      }
    }
  }

  function handleCancel() {
    if (!controllerRef.current) return;
    setCanceling(true);
    controllerRef.current.abort();
  }

  const ext = OUTPUT_CONTAINER_OPTIONS.find((o) => o.value === container)?.ext ?? "mp4";
  const outName =
    mode === "cut" ? `${stripExtension(file?.name ?? "video")}_カット.${ext}` : `${stripExtension(items[0]?.file.name ?? "video")}_結合.${ext}`;

  return (
    <div className="flex flex-col gap-6">
      <Segmented
        ariaLabel="やること"
        testId="video-cut-merge-mode"
        value={mode}
        onChange={(v) => {
          setMode(v);
          resetResult();
        }}
        options={[
          { value: "cut", label: "不要部分を削除" },
          { value: "merge", label: "複数の動画を結合" },
        ]}
      />

      {mode === "cut" && (
        <>
          <section className="flex flex-col gap-3">
            <StepHeading n={1} as="h2">
              動画を選ぶ
            </StepHeading>
            <FileDropzone
              compact={!!file}
              accept={VIDEO_INPUT_ACCEPT}
              maxSizeMB={VIDEO_DROPZONE_MAX_MB}
              label="動画をドラッグ&ドロップ"
              hint="またはタップして選択（MP4・MOV・WebM）"
              onFilesSelected={(files) => {
                setFile(files[0]);
                setSegments([{ id: nextId.current++, start: "", end: "" }]);
                resetResult();
              }}
              onError={setError}
            />
            {file && (
              <FileList
                files={[file]}
                onRemove={() => {
                  setFile(null);
                  resetResult();
                }}
              />
            )}
            {file && <VideoSizeWarning sizeBytes={file.size} />}
          </section>

          {file && (
            <VideoPreviewPanel file={file} previewUrl={previewUrl} meta={meta} onLoadedMetadata={handleLoadedMetadata} videoRef={videoRef}>
              <p className="text-xs text-ms-muted">再生して止めると、「今の位置」で開始・終了を入れられます。</p>
            </VideoPreviewPanel>
          )}

          {file && (
            <section className="flex flex-col gap-3" data-testid="video-cut-segments">
              <StepHeading n={2} as="h2">
                残したい区間を指定
              </StepHeading>
              <p className="text-xs text-ms-muted">
                残したい部分の開始と終了を入れます（例: 1:05.5。空なら最初から・最後まで）。区間にしなかった部分は削除され、区間は上から順につながります。
              </p>
              <ol className="flex flex-col gap-2">
                {segments.map((s, i) => (
                  <li key={s.id} className="flex flex-wrap items-end gap-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800" data-testid="video-cut-segment">
                    <span className="self-center text-sm font-semibold text-ms-text">区間{i + 1}</span>
                    {(["start", "end"] as const).map((which) => (
                      <div key={which} className="flex flex-col gap-1">
                        <label className="text-xs text-neutral-600 dark:text-neutral-300" htmlFor={`cut-${s.id}-${which}`}>
                          {which === "start" ? "開始" : "終了"}
                        </label>
                        <div className="flex items-center gap-1.5">
                          <input
                            id={`cut-${s.id}-${which}`}
                            type="text"
                            inputMode="decimal"
                            value={s[which]}
                            placeholder={which === "start" ? "0:00.0" : duration > 0 ? formatTimeInput(duration) : ""}
                            onChange={(e) => updateSegment(s.id, { [which]: e.target.value })}
                            data-testid={`video-cut-${which}`}
                            className="w-24 rounded-md border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
                          />
                          <button
                            type="button"
                            onClick={() => fromPlayer(s.id, which)}
                            className="rounded-md bg-neutral-100 px-2 py-1.5 text-xs text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-200"
                          >
                            今の位置
                          </button>
                        </div>
                      </div>
                    ))}
                    <div className="ml-auto flex items-center gap-1">
                      <button type="button" onClick={() => moveSegment(i, -1)} disabled={i === 0} aria-label={`区間${i + 1}を上へ移動`} className="rounded-md border border-neutral-300 px-2 py-1 text-xs disabled:opacity-30 dark:border-neutral-700">
                        ↑
                      </button>
                      <button type="button" onClick={() => moveSegment(i, 1)} disabled={i === segments.length - 1} aria-label={`区間${i + 1}を下へ移動`} className="rounded-md border border-neutral-300 px-2 py-1 text-xs disabled:opacity-30 dark:border-neutral-700">
                        ↓
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSegments((prev) => prev.filter((x) => x.id !== s.id));
                          resetResult();
                        }}
                        disabled={segments.length === 1}
                        aria-label={`区間${i + 1}を削除`}
                        className="rounded-md px-2 py-1 text-xs text-red-600 disabled:opacity-30 dark:text-red-400"
                      >
                        削除
                      </button>
                    </div>
                  </li>
                ))}
              </ol>
              <button
                type="button"
                onClick={() => {
                  setSegments((prev) => [...prev, { id: nextId.current++, start: "", end: "" }]);
                  resetResult();
                }}
                disabled={segments.length >= MAX_CLIPS}
                data-testid="video-cut-add"
                className="w-fit rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-200 disabled:opacity-50 dark:bg-neutral-800 dark:text-neutral-200"
              >
                ＋ 区間を追加
              </button>
              {cutProblem ? (
                <p className="text-xs text-red-600 dark:text-red-400" data-testid="video-cut-error">
                  {cutProblem}
                </p>
              ) : (
                duration > 0 && (
                  <p className="text-xs text-ms-text" data-testid="video-cut-summary">
                    {segments.length}区間・合計{formatDuration(keptSec)}を残します（元の動画は{formatDuration(duration)}）
                  </p>
                )
              )}
            </section>
          )}
        </>
      )}

      {mode === "merge" && (
        <section className="flex flex-col gap-3">
          <StepHeading n={1} as="h2">
            結合する動画を選ぶ
          </StepHeading>
          <FileDropzone
            compact={items.length > 0}
            multiple
            accept={VIDEO_INPUT_ACCEPT}
            maxSizeMB={VIDEO_DROPZONE_MAX_MB}
            label="動画をドラッグ&ドロップ（複数可）"
            hint="またはタップして選択（MP4・MOV・WebM）"
            onFilesSelected={(files) => void addMergeFiles(files)}
            onError={setError}
          />
          {items.length > 0 && (
            <>
              <p className="text-xs text-ms-muted">上から順につながります。↑↓で順番を変えられます。それぞれ再生して確かめられます。</p>
              <ol className="flex flex-col gap-3" data-testid="video-merge-list" aria-label="結合する順番">
                {items.map((it, i) => (
                  <li key={it.id} className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-3 sm:flex-row sm:items-center dark:border-neutral-800" data-testid="video-merge-item">
                    <span className="text-sm font-semibold text-ms-text">{i + 1}.</span>
                    <video src={it.url} controls playsInline preload="metadata" className="block h-auto max-h-40 w-auto max-w-full rounded bg-black sm:w-48" />
                    <div className="min-w-0 flex-1 text-xs">
                      <p className="break-all font-medium text-ms-text">{it.file.name}</p>
                      <p className="text-ms-muted">
                        {it.error
                          ? it.error
                          : it.durationSec === null
                            ? "読み込み中…"
                            : `${it.width}×${it.height} ・ ${formatDuration(it.durationSec)} ・ ${it.hasAudio ? "音声あり" : "音声なし"} ・ ${formatBytes(it.file.size)}`}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <button type="button" onClick={() => moveItem(i, -1)} disabled={i === 0} aria-label={`${it.file.name} を上へ移動`} className="rounded-md border border-neutral-300 px-2 py-1 text-xs disabled:opacity-30 dark:border-neutral-700">
                        ↑
                      </button>
                      <button type="button" onClick={() => moveItem(i, 1)} disabled={i === items.length - 1} aria-label={`${it.file.name} を下へ移動`} className="rounded-md border border-neutral-300 px-2 py-1 text-xs disabled:opacity-30 dark:border-neutral-700">
                        ↓
                      </button>
                      <button type="button" onClick={() => removeItem(it.id)} aria-label={`${it.file.name} を削除`} className="rounded-md px-2 py-1 text-xs text-red-600 dark:text-red-400">
                        削除
                      </button>
                    </div>
                  </li>
                ))}
              </ol>
              {items.length === 1 && <p className="text-xs text-ms-muted">結合するには、動画を2本以上選んでください。</p>}
              {mergeReady && (
                <p className="text-xs text-ms-text" data-testid="video-merge-summary">
                  {items.length}本・合計{formatDuration(mergeTotal)}の動画を1本にします
                </p>
              )}
              {mixedSizes && (
                <p className="text-xs text-amber-700 dark:text-amber-300" data-testid="video-merge-size-note">
                  縦横比の違う動画があります。1本目の大きさ（{items[0].width}×{items[0].height}）に合わせ、ほかの動画は縦横比を保ったまま、余った部分を黒くします（引き伸ばし・切り抜きはしません）。
                </p>
              )}
              {items.reduce((s, it) => s + it.file.size, 0) > 0 && <VideoSizeWarning sizeBytes={items.reduce((s, it) => s + it.file.size, 0)} />}
            </>
          )}
        </section>
      )}

      {(file || items.length > 0) && (
        <section className="flex flex-col gap-2">
          <StepHeading n={mode === "cut" ? 3 : 2} as="h2">
            出力形式
          </StepHeading>
          <Segmented
            ariaLabel="出力形式"
            testId="video-cut-merge-container"
            value={container}
            onChange={(v) => {
              setContainer(v);
              resetResult();
            }}
            options={OUTPUT_CONTAINER_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          />
          <p className="text-xs text-ms-muted">
            つなぐために映像と音声を作り直すので、動画の長さに応じて時間がかかります（処理中はキャンセルできます）。
          </p>
        </section>
      )}

      {(file || items.length > 0) && (
        <RunBar>
          <button
            type="button"
            onClick={() => void handleRun()}
            disabled={!canRun}
            aria-busy={status === "processing" || undefined}
            data-testid="video-cut-merge-run"
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {mode === "cut" ? "不要部分を削除して書き出す" : "動画を結合する"}
          </button>
        </RunBar>
      )}

      <ProcessingStatus
        state={status}
        processingLabel={`${mode === "cut" ? "書き出し中" : "結合中"}... ${Math.round(progress * 100)}%`}
        successLabel={mode === "cut" ? "書き出しが完了しました" : "結合が完了しました"}
        onCancel={handleCancel}
        canceling={canceling}
      />
      {wasCanceled && (
        <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
          処理をキャンセルしました。
        </div>
      )}
      {error && <ErrorMessage message={error} />}

      {result && (
        <ResultPopup>
          <VideoOutputPlayer url={result.url} />
          <p className="text-xs text-neutral-500 dark:text-neutral-400" data-testid="video-cut-merge-result">
            {result.width}×{result.height} ・ {formatDuration(result.durationSec)} ・ {result.hasAudio ? "音声あり" : "音声なし"} ・ {formatBytes(result.sizeBytes)}
          </p>
          {result.letterboxed && <p className="text-xs text-neutral-500 dark:text-neutral-400">縦横比の違う動画は、黒い余白を付けて大きさをそろえました。</p>}
          <RewardedDownloadGate onDownload={() => downloadBlob(result.blob, outName)} label="ダウンロード" />
        </ResultPopup>
      )}
    </div>
  );
}
