import type { ConversionVideoOptions, Rotation } from "mediabunny";
import {
  getAvailableFrameRates,
  getAvailableResolutionPresets,
  qualityFor,
  resolutionOptionsFor,
  type CompressionLevel,
  type OutputContainer,
} from "./shared";
import { COMPRESSION_RATIO_RANGE, estimateFrameRateBytes, estimateResizedBytes, resizedDimensions } from "./estimate";

/**
 * 動画の変換・編集（動画編集 工程2：形式変換・圧縮・解像度・フレームレートの4ツール統合）の設定。
 *
 * 4つのページ（/tools/video-convert・video-compress・video-resize・video-frame-rate）は、URLもSEOの説明もそのまま、
 * 同じ1つの画面（VideoEditTool）を使う。ページごとに違うのは「最初に選ばれている設定」と「目立たせる設定」だけ。
 * 出力形式・画質・解像度・フレームレートは自由に組み合わせられ、最後に1回だけ動画を作り直す
 * （mediabunny の Conversion に、すべての指定をまとめて渡す。二重の変換をしない）。
 */

export type VideoEditToolId = "video-convert" | "video-compress" | "video-resize" | "video-frame-rate";

/** 画質の指定。"original" は「画質を指定しない」（作り直しが必要なときも、従来どおりの既定の画質） */
export type QualityChoice = "original" | CompressionLevel;
/** 解像度の指定（短い辺のピクセル数）。"original" は元のまま、null はまだ選んでいない */
export type ResolutionChoice = "original" | number | null;
/** フレームレートの指定。"original" は元のまま、null はまだ選んでいない */
export type FpsChoice = "original" | number | null;

/** 回転（時計回りの角度） */
export type RotateChoice = 0 | 90 | 180 | 270;

export interface VideoEditSettings {
  container: OutputContainer;
  quality: QualityChoice;
  resolution: ResolutionChoice;
  fps: FpsChoice;
  /** 切り取りの開始（秒）。0なら最初から（動画編集 工程3） */
  trimStart: number;
  /** 切り取りの終了（秒）。null なら最後まで */
  trimEnd: number | null;
  /**
   * 切り取りで速さを優先するか。true のときは作り直さずに切るため速いが、
   * 開始位置が直前のキーフレームまで（多くは数秒以内）前にずれることがある。false（既定）は正確に切る
   */
  fastTrim: boolean;
  /** 音声を消すか */
  muted: boolean;
  /** 回転（時計回り） */
  rotate: RotateChoice;
}

/** 工程3（切り取り・音声・回転）の初期値。どのページでも「何もしない」 */
export const EDIT_DEFAULTS = { trimStart: 0, trimEnd: null, fastTrim: false, muted: false, rotate: 0 } as const satisfies Partial<VideoEditSettings>;

export type VideoEditFocus = "container" | "quality" | "resolution" | "fps";

export interface VideoEditPreset {
  /** このページを開いたときに選ばれている設定 */
  initial: VideoEditSettings;
  /** このページで目立たせる（いちばん上に置く）設定 */
  focus: VideoEditFocus;
  /** 実行ボタンの文言（従来のツールと同じ） */
  actionLabel: string;
  /** 処理中の表示（「圧縮中... 40%」の「圧縮中」） */
  progressLabel: string;
  /** 完了したときの表示 */
  successLabel: string;
  /** 保存するファイル名の後ろに付ける文字（従来のツールと同じ。空なら付けない） */
  fileSuffix: string;
}

/**
 * ページごとの初期設定。従来のツールと同じ初期値にする。
 * - 形式変換：MP4。ほかは元のまま（作り直さずに済むときは、画質を変えずに形式だけ変える）
 * - 圧縮：画質「標準」。ほかは元のまま
 * - 解像度変更：解像度はまだ選ばない（従来どおり、選んでから実行する）。ほかは元のまま
 * - フレームレート変更：フレームレートはまだ選ばない。ほかは元のまま
 */
export const VIDEO_EDIT_PRESETS: Record<VideoEditToolId, VideoEditPreset> = {
  "video-convert": {
    initial: { container: "mp4", quality: "original", resolution: "original", fps: "original", ...EDIT_DEFAULTS },
    focus: "container",
    actionLabel: "変換する",
    progressLabel: "変換中",
    successLabel: "変換が完了しました",
    fileSuffix: "",
  },
  "video-compress": {
    initial: { container: "mp4", quality: "medium", resolution: "original", fps: "original", ...EDIT_DEFAULTS },
    focus: "quality",
    actionLabel: "圧縮する",
    progressLabel: "圧縮中",
    successLabel: "圧縮が完了しました",
    fileSuffix: "-compressed",
  },
  "video-resize": {
    initial: { container: "mp4", quality: "original", resolution: null, fps: "original", ...EDIT_DEFAULTS },
    focus: "resolution",
    actionLabel: "解像度を変更する",
    progressLabel: "変換中",
    successLabel: "解像度の変更が完了しました",
    fileSuffix: "-resized",
  },
  "video-frame-rate": {
    initial: { container: "mp4", quality: "original", resolution: "original", fps: null, ...EDIT_DEFAULTS },
    focus: "fps",
    actionLabel: "フレームレートを変更する",
    progressLabel: "変換中",
    successLabel: "フレームレートの変更が完了しました",
    fileSuffix: "-fps",
  },
};

export function isVideoEditToolId(id: string): id is VideoEditToolId {
  return id in VIDEO_EDIT_PRESETS;
}

/** 画質の選択肢（従来の圧縮の「弱め・標準・強め」と同じ品質。何が変わるか分かる名前にする） */
export const QUALITY_CHOICES: { value: QualityChoice; label: string; description: string }[] = [
  {
    value: "original",
    label: "元のまま",
    description: "画質は指定しません。解像度・フレームレートを変えない場合は、できるだけ作り直さずに書き出します。",
  },
  { value: "low", label: "高画質（弱め）", description: "画質を優先し、圧縮は控えめにします（ファイルサイズはあまり小さくなりません）。" },
  { value: "medium", label: "標準", description: "画質とファイルサイズのバランスを取ります。" },
  { value: "high", label: "高圧縮（強め）", description: "ファイルサイズを優先して小さくします（画質は下がります）。" },
];

/** 選べる解像度（元の動画より大きいものは出さない＝拡大しない） */
export function resolutionChoicesFor(width: number, height: number): number[] {
  return getAvailableResolutionPresets(width, height);
}

/** 選べるフレームレート（元の動画より高いものは出さない） */
export function fpsChoicesFor(sourceFps: number): number[] {
  return getAvailableFrameRates(sourceFps);
}

/** まだ選んでいない設定があるか（解像度変更・フレームレート変更のページで、選ぶ前は実行できない） */
export function missingChoice(settings: VideoEditSettings): "resolution" | "fps" | null {
  if (settings.resolution === null) return "resolution";
  if (settings.fps === null) return "fps";
  return null;
}

/**
 * 設定を、mediabunny の Conversion に渡す映像のオプションにまとめる（1回の変換ですべてを反映する）。
 * - 画質を指定したときは、必ず作り直す（forceTranscode）。そのままコピーされてサイズが変わらないのを防ぐ（従来の圧縮と同じ）
 * - 解像度：短い辺を指定し、長い辺はアスペクト比から自動で決める（従来の解像度変更と同じ）
 * - フレームレート：指定した値に下げる（従来のフレームレート変更と同じ）
 * 何も指定しないときは undefined（従来の形式変換と同じ。使えるならコピーで済ませる）。
 */
export function buildVideoOptions(
  settings: VideoEditSettings,
  source: { width: number; height: number }
): ConversionVideoOptions | undefined {
  const options: ConversionVideoOptions = {};
  if (settings.rotate !== 0) {
    // 回転は解像度の変更より先にかかるため、解像度は回転後の縦横で決める
    options.rotate = settings.rotate as Rotation;
    source = rotatedSize(settings.rotate, source.width, source.height);
  }
  if (settings.quality !== "original") {
    options.quality = qualityFor(settings.quality);
    options.forceTranscode = true;
  }
  if (typeof settings.resolution === "number") {
    Object.assign(options, resolutionOptionsFor(source.width, source.height, settings.resolution));
  }
  if (typeof settings.fps === "number") {
    options.frameRate = settings.fps;
  }
  return Object.keys(options).length > 0 ? options : undefined;
}

/** 回転したあとの縦横（90°・270°なら入れ替わる） */
export function rotatedSize(rotate: RotateChoice, width: number, height: number): { width: number; height: number } {
  return rotate % 180 === 0 ? { width, height } : { width: height, height: width };
}

/** 出力の予定の解像度（元のままなら元の解像度。回転したときは回転後の向き） */
export function plannedDimensions(settings: VideoEditSettings, width: number, height: number): { width: number; height: number } {
  const r = rotatedSize(settings.rotate, width, height);
  return typeof settings.resolution === "number" ? resizedDimensions(r.width, r.height, settings.resolution) : r;
}

/** 切り取りを指定しているか */
export function hasTrim(settings: VideoEditSettings, durationSec: number): boolean {
  return settings.trimStart > 0 || (settings.trimEnd !== null && settings.trimEnd < durationSec);
}

/** 切り取りの範囲を確かめる。問題があれば日本語の理由を返す（問題なければ null） */
export function trimError(settings: VideoEditSettings, durationSec: number): string | null {
  const end = settings.trimEnd ?? durationSec;
  if (!Number.isFinite(settings.trimStart) || settings.trimStart < 0) return "開始の時間が正しくありません。";
  if (settings.trimEnd !== null && !Number.isFinite(settings.trimEnd)) return "終了の時間が正しくありません。";
  if (durationSec > 0 && settings.trimStart >= durationSec) return `開始は、動画の長さ（${formatTimeInput(durationSec)}）より前にしてください。`;
  if (durationSec > 0 && end > durationSec + 0.05) return `終了は、動画の長さ（${formatTimeInput(durationSec)}）までにしてください。`;
  if (end - settings.trimStart < 0.1) return "終了は、開始より後にしてください（0.1秒以上）。";
  return null;
}

/** 書き出す長さ（秒） */
export function plannedDuration(settings: VideoEditSettings, durationSec: number): number {
  return Math.max(0, Math.min(settings.trimEnd ?? durationSec, durationSec) - settings.trimStart);
}

/**
 * 作り直し（再エンコード）が必要か。画質・解像度・フレームレートを変えるとき、
 * 正確な切り取りで途中から始めるとき、メタデータで回転を表せない形式（WebM）で回転するとき。
 * 作り直しが必要な設定では、ブラウザが書き出せない形式は選べない。
 */
export function needsReencode(settings: VideoEditSettings): boolean {
  return (
    settings.quality !== "original" ||
    typeof settings.resolution === "number" ||
    typeof settings.fps === "number" ||
    (settings.trimStart > 0 && !settings.fastTrim) ||
    (settings.rotate !== 0 && settings.container === "webm")
  );
}

/**
 * 時間の入力（「1:23.5」「83.5」「1:02:03」）を秒にする。読めないときは NaN。空なら null。
 * 全角の数字・コロンも受け付ける。
 */
export function parseTimeInput(text: string): number | null {
  const t = text.normalize("NFKC").trim();
  if (t === "") return null;
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(t)) return NaN;
  const parts = t.split(":");
  let sec = 0;
  for (const p of parts) sec = sec * 60 + Number(p);
  const last = parts.length > 1 ? Number(parts[parts.length - 1]) : 0;
  if (parts.length > 1 && last >= 60) return NaN;
  return Math.round(sec * 1000) / 1000;
}

/** 秒を「分:秒.小数1けた」（1時間以上は「時:分:秒.小数」）の文字にする */
export function formatTimeInput(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "";
  const tenths = Math.round(sec * 10);
  const h = Math.floor(tenths / 36000);
  const m = Math.floor((tenths % 36000) / 600);
  const s = (tenths % 600) / 10;
  const ss = s.toFixed(1).padStart(4, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/**
 * 出力のファイルサイズのおおよその目安（範囲）。実際のサイズは動画の中身で大きく前後する。
 * 画質の割合（従来の圧縮の目安）に、解像度（画素数）とフレームレートの比を掛け合わせる。
 * 画質が「元のまま」のときは、上限を元のサイズとする。
 */
export function estimateOutputRange(
  settings: VideoEditSettings,
  source: { bytes: number; width: number; height: number; fps: number | null; durationSec?: number }
): [number, number] | null {
  if (settings.resolution === null || settings.fps === null) return null;
  let base = source.bytes;
  // 切り取ったぶん、長さに比例して小さくなる
  if (source.durationSec && source.durationSec > 0 && hasTrim(settings, source.durationSec)) {
    base = Math.round((base * plannedDuration(settings, source.durationSec)) / source.durationSec);
  }
  if (typeof settings.resolution === "number" && source.width > 0) {
    const r = rotatedSize(settings.rotate, source.width, source.height);
    const out = resizedDimensions(r.width, r.height, settings.resolution);
    base = estimateResizedBytes(base, r.width, r.height, out.width, out.height);
  }
  if (typeof settings.fps === "number" && source.fps) {
    base = estimateFrameRateBytes(base, source.fps, settings.fps);
  }
  if (settings.quality === "original") {
    // 解像度・fpsを変えないなら、ほぼ元のまま（作り直さずに書き出す場合もある）
    if (base === source.bytes) return null;
    return [Math.round(base * 0.7), base];
  }
  const [lo, hi] = COMPRESSION_RATIO_RANGE[settings.quality];
  return [Math.round(base * lo), Math.round(base * hi)];
}

/** 変換前後のサイズの比べ方。増えたときは「削減率をマイナス」にせず、増えたことをそのまま伝える */
export function compareSizes(inputBytes: number, outputBytes: number):
  | { kind: "smaller"; savedBytes: number; percent: number }
  | { kind: "same" }
  | { kind: "larger"; increasedBytes: number } {
  if (outputBytes < inputBytes) {
    return { kind: "smaller", savedBytes: inputBytes - outputBytes, percent: ((inputBytes - outputBytes) / inputBytes) * 100 };
  }
  if (outputBytes === inputBytes) return { kind: "same" };
  return { kind: "larger", increasedBytes: outputBytes - inputBytes };
}
