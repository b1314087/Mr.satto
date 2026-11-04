import type { ConversionVideoOptions } from "mediabunny";
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

export interface VideoEditSettings {
  container: OutputContainer;
  quality: QualityChoice;
  resolution: ResolutionChoice;
  fps: FpsChoice;
}

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
    initial: { container: "mp4", quality: "original", resolution: "original", fps: "original" },
    focus: "container",
    actionLabel: "変換する",
    progressLabel: "変換中",
    successLabel: "変換が完了しました",
    fileSuffix: "",
  },
  "video-compress": {
    initial: { container: "mp4", quality: "medium", resolution: "original", fps: "original" },
    focus: "quality",
    actionLabel: "圧縮する",
    progressLabel: "圧縮中",
    successLabel: "圧縮が完了しました",
    fileSuffix: "-compressed",
  },
  "video-resize": {
    initial: { container: "mp4", quality: "original", resolution: null, fps: "original" },
    focus: "resolution",
    actionLabel: "解像度を変更する",
    progressLabel: "変換中",
    successLabel: "解像度の変更が完了しました",
    fileSuffix: "-resized",
  },
  "video-frame-rate": {
    initial: { container: "mp4", quality: "original", resolution: "original", fps: null },
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

/** 出力の予定の解像度（元のままなら元の解像度） */
export function plannedDimensions(settings: VideoEditSettings, width: number, height: number): { width: number; height: number } {
  return typeof settings.resolution === "number" ? resizedDimensions(width, height, settings.resolution) : { width, height };
}

/**
 * 出力のファイルサイズのおおよその目安（範囲）。実際のサイズは動画の中身で大きく前後する。
 * 画質の割合（従来の圧縮の目安）に、解像度（画素数）とフレームレートの比を掛け合わせる。
 * 画質が「元のまま」のときは、上限を元のサイズとする。
 */
export function estimateOutputRange(
  settings: VideoEditSettings,
  source: { bytes: number; width: number; height: number; fps: number | null }
): [number, number] | null {
  if (settings.resolution === null || settings.fps === null) return null;
  let base = source.bytes;
  if (typeof settings.resolution === "number" && source.width > 0) {
    const out = resizedDimensions(source.width, source.height, settings.resolution);
    base = estimateResizedBytes(base, source.width, source.height, out.width, out.height);
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
