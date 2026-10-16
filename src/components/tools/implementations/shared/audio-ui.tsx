"use client";

import type { ReactNode } from "react";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import {
  AUDIO_BITRATE_OPTIONS_KBPS,
  AUDIO_OUTPUT_OPTIONS,
  audioCodecLabel,
  audioSizeWarning,
  formatAudioTime,
  resolveOriginalKind,
  type AudioOutputChoice,
  type AudioOutputKind,
  type AudioProbe,
} from "@/lib/audio/shared";
import { formatBytes } from "@/lib/utils/format";

/** 音声ツール共通の冒頭説明（ブラウザ内処理であることの明記） */
export function AudioIntro({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
      <p>{children}</p>
      <p>
        音声ファイルはブラウザ上で処理され、Mr.Sattoのサーバーへアップロードされることはありません。
        お使いのブラウザが対応していない形式の音声は、読み込めない場合があります。
      </p>
    </div>
  );
}

/** 大きいファイルを選んだときの注意（処理は止めない） */
export function AudioSizeWarning({ sizeBytes }: { sizeBytes: number }) {
  const message = audioSizeWarning(sizeBytes);
  if (!message) return null;
  return (
    <p
      role="status"
      data-testid="audio-size-warning"
      className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-300"
    >
      {message}
    </p>
  );
}

export interface AudioOutputRow {
  label: string;
  value: string;
}

/**
 * 音声ツール共通のプレビュー領域。元の音声を再生して確認でき、
 * 設定に応じた「出力の予定」を表示する。処理そのものはここでは行わない。
 */
export function AudioPreviewPanel({
  file,
  previewUrl,
  probe,
  probeDone,
  audioRef,
  outputTitle = "変換後の予定",
  outputRows,
  outputNote,
  isVideo = false,
}: {
  file: File;
  previewUrl: string | null;
  probe: AudioProbe | null;
  probeDone: boolean;
  audioRef?: React.Ref<HTMLMediaElement>;
  outputTitle?: string;
  outputRows?: AudioOutputRow[];
  outputNote?: string;
  /** 動画ファイルを入力にするツール（映像付きで再生して確認する） */
  isVideo?: boolean;
}) {
  const sourceParts: string[] = [];
  if (probe) {
    sourceParts.push(audioCodecLabel(probe.codec));
    sourceParts.push(formatAudioTime(probe.durationSec));
    sourceParts.push(`${Math.round(probe.sampleRate)}Hz`);
    sourceParts.push(probe.channels === 1 ? "モノラル" : probe.channels === 2 ? "ステレオ" : `${probe.channels}ch`);
  }
  sourceParts.push(formatBytes(file.size));

  return (
    <section
      data-testid="tool-preview"
      aria-label="音声のプレビュー"
      className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800"
    >
      <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
        {isVideo ? "元の動画" : "元の音声"}
      </p>
      {previewUrl &&
        (isVideo ? (
          <video
            ref={audioRef as React.Ref<HTMLVideoElement>}
            src={previewUrl}
            controls
            playsInline
            preload="metadata"
            className="max-h-56 w-full rounded-lg bg-black"
          />
        ) : (
          <audio
            ref={audioRef as React.Ref<HTMLAudioElement>}
            src={previewUrl}
            controls
            preload="metadata"
            className="w-full"
          />
        ))}
      <p className="break-all text-xs text-neutral-500 dark:text-neutral-400">
        {file.name}（{sourceParts.join(" ・ ")}）
      </p>
      {probeDone && !probe && (
        <p role="status" className="text-xs text-amber-700 dark:text-amber-400">
          このファイルの情報を読み取れませんでした。形式が対応していない可能性があります。
        </p>
      )}

      {outputRows && outputRows.length > 0 && (
        <div className="flex flex-col gap-1 rounded-lg bg-neutral-50 p-3 dark:bg-neutral-900">
          <p className="text-xs font-medium text-neutral-600 dark:text-neutral-300">{outputTitle}</p>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
            {outputRows.map((row) => (
              <div key={row.label} className="flex min-w-0 gap-2">
                <dt className="shrink-0 text-neutral-500 dark:text-neutral-400">{row.label}</dt>
                <dd className="min-w-0 break-words font-medium text-neutral-800 dark:text-neutral-100">
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
          {outputNote && <p className="text-[11px] text-neutral-400">{outputNote}</p>}
        </div>
      )}
    </section>
  );
}

/** 処理後の音声を再生して確認するプレーヤー */
export function AudioOutputPlayer({ url, label = "処理後の音声（再生して確認できます）" }: { url: string; label?: string }) {
  return (
    <div className="flex w-full flex-col gap-1">
      <p className="text-xs font-medium text-neutral-600 dark:text-neutral-300">{label}</p>
      <audio src={url} controls preload="metadata" data-testid="audio-output-preview" className="w-full" />
    </div>
  );
}

function chipClass(selected: boolean, disabled = false): string {
  return `cursor-pointer rounded-lg border px-3 py-1.5 text-sm transition-colors ${
    disabled
      ? "cursor-not-allowed border-neutral-200 text-neutral-300 dark:border-neutral-800 dark:text-neutral-600"
      : selected
        ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
        : "border-neutral-300 text-neutral-600 hover:border-blue-400 dark:border-neutral-700 dark:text-neutral-300"
  }`;
}

/** 出力形式の選択（このブラウザで書き出せる形式だけを表示する） */
export function AudioFormatPicker({
  name,
  legend = "変換後の形式",
  value,
  onChange,
  writableKinds,
  allowOriginal,
  originalLabel = "元の形式のまま",
  sourceCodec,
  onlyLossy = false,
}: {
  name: string;
  legend?: string;
  value: AudioOutputChoice;
  onChange: (v: AudioOutputChoice) => void;
  /** このブラウザで書き出せる形式。調査中はnull */
  writableKinds: AudioOutputKind[] | null;
  allowOriginal?: boolean;
  originalLabel?: string;
  /** 元の音声のコーデック（分かっている場合）。元の形式のまま出せるかの判定に使う */
  sourceCodec?: string | null;
  onlyLossy?: boolean;
}) {
  // 対応状況の調査が終わるまでは選択肢を出さない（書き出せない形式を選ばせないため）
  const options = AUDIO_OUTPUT_OPTIONS.filter(
    (o) => (!onlyLossy || o.lossy) && writableKinds !== null && writableKinds.includes(o.kind)
  );
  const originalInfo = sourceCodec ? resolveOriginalKind(sourceCodec) : null;
  const originalDisabled = sourceCodec !== undefined && sourceCodec !== null && !originalInfo;

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium text-neutral-700 dark:text-neutral-200">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {allowOriginal && (
          <label className={chipClass(value === "original", originalDisabled)}>
            <input
              type="radio"
              name={name}
              value="original"
              checked={value === "original"}
              disabled={originalDisabled}
              onChange={() => onChange("original")}
              className="sr-only"
            />
            {originalLabel}
            {originalInfo ? `（.${AUDIO_OUTPUT_OPTIONS.find((o) => o.kind === originalInfo.kind)?.ext}）` : ""}
          </label>
        )}
        {options.map((opt) => (
          <label key={opt.kind} className={chipClass(value === opt.kind)}>
            <input
              type="radio"
              name={name}
              value={opt.kind}
              checked={value === opt.kind}
              onChange={() => onChange(opt.kind)}
              className="sr-only"
            />
            {opt.label}
          </label>
        ))}
        {writableKinds === null && (
          <span className="self-center text-xs text-neutral-400">対応形式を確認中...</span>
        )}
      </div>
      {value !== "original" && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {AUDIO_OUTPUT_OPTIONS.find((o) => o.kind === value)?.description}
        </p>
      )}
      {value === "original" && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          元の音声を再エンコードせずそのまま取り出すため、音質は変わらず、処理も速く済みます。
        </p>
      )}
    </fieldset>
  );
}

/** ビットレート(kbps)の選択 */
export function AudioBitratePicker({
  name,
  value,
  onChange,
  options = AUDIO_BITRATE_OPTIONS_KBPS,
}: {
  name: string;
  value: number;
  onChange: (v: number) => void;
  options?: readonly number[];
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium text-neutral-700 dark:text-neutral-200">音質（ビットレート）</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((kbps) => (
          <label key={kbps} className={chipClass(value === kbps)}>
            <input
              type="radio"
              name={name}
              value={kbps}
              checked={value === kbps}
              onChange={() => onChange(kbps)}
              className="sr-only"
            />
            {kbps}kbps
          </label>
        ))}
      </div>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        数字が大きいほど高音質でファイルも大きくなります。音楽は192kbps以上、話し声は64〜96kbpsでも十分聞き取れます。
      </p>
    </fieldset>
  );
}

/** 実行ボタン・キャンセル・進捗・エラー表示をまとめた共通部品 */
export function AudioRunBar({
  runLabel,
  onRun,
  runDisabled,
  status,
  progress,
  canceling,
  wasCanceled,
  error,
  onCancel,
  processingLabel = "処理中",
  successLabel = "処理が完了しました",
}: {
  runLabel: string;
  onRun: () => void;
  runDisabled?: boolean;
  status: ProcessingState;
  progress: number;
  canceling: boolean;
  wasCanceled: boolean;
  error: string | null;
  onCancel: () => void;
  processingLabel?: string;
  successLabel?: string;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onRun}
          disabled={runDisabled || status === "processing"}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {runLabel}
        </button>
        {status === "processing" && !canceling && (
          <button
            type="button"
            onClick={onCancel}
            className="w-fit rounded-lg border border-neutral-300 px-4 py-2 text-sm text-neutral-600 transition-colors hover:border-red-400 hover:text-red-600 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-red-500 dark:hover:text-red-400"
          >
            キャンセル
          </button>
        )}
        {canceling && <span className="text-xs text-neutral-500 dark:text-neutral-400">キャンセル処理中...</span>}
      </div>
      <ProcessingStatus
        state={status}
        processingLabel={`${processingLabel}... ${Math.round(progress * 100)}%`}
        successLabel={successLabel}
      />
      {wasCanceled && (
        <div className="flex items-start gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
          処理をキャンセルしました。設定を確認して、もう一度実行できます。
        </div>
      )}
      {error && <ErrorMessage message={error} />}
    </>
  );
}

/** 結果カード（サイズ・長さ・プレーヤー・ダウンロード） */
export function AudioResultCard({
  summary,
  children,
}: {
  summary: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      data-testid="audio-result"
      className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900"
    >
      <div className="flex flex-wrap gap-4 text-xs text-neutral-500 dark:text-neutral-400">{summary}</div>
      {children}
    </div>
  );
}
