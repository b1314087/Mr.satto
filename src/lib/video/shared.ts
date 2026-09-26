/**
 * 動画ツール共通ユーティリティ（Phase 10）。
 *
 * Mr.Sattoの動画ツール（6機能）は、既存のBrowserProcessorアーキテクチャに
 * 従いつつ、実際の動画デコード・エンコードそのものはブラウザ標準の
 * WebCodecs API（VideoDecoder/VideoEncoder/AudioDecoder/AudioEncoder）に
 * 委ねる。ffmpeg系のWASMは採用しない。
 *
 * 採用ライブラリ：mediabunny（依存ゼロ・純TypeScript・WebCodecsのラッパー、
 * MPL-2.0）。理由（開発指示書 44章 事前調査に対応）：
 *
 *   1. WASMを一切使わず、実体はWebCodecsの薄いオーケストレーション層のみ
 *      （コンテナのdemux/mux処理をTypeScriptで実装し、実際のデコード/
 *      エンコードはブラウザ native の WebCodecs に委譲する設計）。
 *      ffmpeg.wasm等（フルビルドで数十MB、シングルコーデックの
 *      軽量ビルドでも数MB規模のWASMバイナリを都度ロードする必要がある）
 *      と比較して、初期ロードコストが桁違いに小さい。
 *   2. tree-shakable設計（package.json: "sideEffects": false）で、
 *      実際に使うクラス・関数だけが本番バンドルに含まれる
 *      （公式ドキュメント記載の理論値：最小構成で5KB gzip程度）。
 *   3. 依存ライブラリ0件（package.jsonのdependenciesは型定義のみ）。
 *      メンテナンス・セキュリティ面でのリスク源が少ない。
 *   4. MP4/WebM/MOVのdemux・mux、リサイズ・トリム・ビットレート制御・
 *      コーデック変換を含む高水準な Conversion API を最初から持っており、
 *      自前でVideoDecoder/VideoEncoder/muxerを組み合わせて実装するより
 *      実装量・不具合リスクを大きく減らせる。
 *   5. 実際に動作する候補（webm-muxer/mp4-muxer単体、mp4box.js等）も
 *      調査したが、それらは「muxerのみ」または「demuxerのみ」であり、
 *      6機能すべてに必要な「demux→デコード→変換→エンコード→mux」の
 *      パイプライン全体を自前で組む必要があった。mediabunnyは同じ作者
 *      （mp4-muxer/webm-muxerの後継として公開）による統合ライブラリで、
 *      上記すべてを1つの一貫したAPIでカバーしている。
 *
 * ページ分割（開発指示書 5章・31章）：mediabunnyおよびこのモジュールは
 * 動画ツールの実装ファイル内でのみ import され、next/dynamic() 経由で
 * 遅延ロードされるツールUIコンポーネントの内部からのみ参照される。
 * トップ・料金・About・画像/PDFツール等のバンドルには含まれない
 * （本番ビルドでの検証結果は最終報告を参照）。
 */

import {
  BlobSource,
  BufferTarget,
  CanvasSink,
  Conversion,
  Input,
  Mp4OutputFormat,
  MP4,
  Output,
  QTFF,
  Quality,
  WEBM,
  WebMOutputFormat,
  canEncodeVideo,
  type ConversionAudioOptions,
  type ConversionVideoOptions,
  type InputVideoTrack,
} from "mediabunny";

/** このアプリが「対応形式」として明示的にサポートする入力コンテナ */
export const SUPPORTED_INPUT_FORMATS = [MP4, QTFF, WEBM];

/** ファイル選択ダイアログ／ドロップゾーンのaccept属性（実際にdemuxを検証済みの拡張子のみ） */
export const VIDEO_INPUT_ACCEPT =
  "video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm";

/** 出力コンテナ。実際に生成・再生確認が取れた2種類に限定する（開発指示書 17-18章） */
export type OutputContainer = "mp4" | "webm";

export const OUTPUT_CONTAINER_OPTIONS: { value: OutputContainer; label: string; ext: string }[] = [
  { value: "mp4", label: "MP4", ext: "mp4" },
  { value: "webm", label: "WebM", ext: "webm" },
];

/**
 * 動画は画像よりはるかに重いため、ツールごとに実測に基づいた上限を設ける
 * （開発指示書 28-29章）。
 *
 * 実測（Phase 10テスト。GPUアクセラレーションのないサンドボックス環境の
 * ヘッドレスChromium、1280x720/30fpsの高複雑度な合成テスト映像で計測）：
 * 約48MB（再生時間180秒）の変換・圧縮は約71秒で完走。一方、約238MB
 * （再生時間900秒）は10分以内に完走を確認できなかった（ハングしたのか、
 * 単に非常に時間がかかっているのかは切り分けられていない）。
 *
 * この結果は「ソフトウェアのみ・GPU不使用・かつ最も圧縮しにくい合成映像」
 * という悪条件下の実測であり、実際のユーザーのブラウザ（多くはハードウェア
 * アクセラレーションが効く）や、より圧縮しやすい実写コンテンツでは
 * これより大幅に高速になる可能性が高い。ただし本サンドボックスでは
 * 実機（ハードウェアアクセラレーション有効なブラウザ）での再測定ができない
 * ため、「実測で確実に速く完走する」と言い切れる範囲を上限の目安とし、
 * 実測できなかった250MB/500MB相当の値をそのまま採用することは避けた
 * （最終報告に詳細を記載。開発指示書「それ以上は環境依存が大きいので
 * 無理をしない」に対応）。
 *
 * - 変換系（形式変換・圧縮・解像度変更・フレームレート変更・H.264変換）は
 *   デコード→エンコードの全パイプラインを完走させる必要があり、出力も
 *   BufferTarget（メモリ上のArrayBuffer）に保持するため、重い方の上限とする。
 * - サムネイル抽出は指定した1時点のフレームをシークして取り出すだけで、
 *   動画全体をデコード・再エンコードしないため、より大きなファイルでも扱える
 *   （ただし際限なく大きくできるわけではないため、変換系よりは高いが
 *   無制限ではない値とする）。
 */
export const VIDEO_SIZE_LIMITS = {
  convert: 150,
  compress: 150,
  resize: 150,
  frameRate: 150,
  h264: 150,
  thumbnail: 300,
} as const satisfies Record<string, number>;

export function outputFormatFor(container: OutputContainer) {
  return container === "mp4" ? new Mp4OutputFormat() : new WebMOutputFormat();
}

export function mimeTypeFor(container: OutputContainer): string {
  return container === "mp4" ? "video/mp4" : "video/webm";
}

/**
 * File → mediabunny Input への変換。
 * 明示的にMP4/MOV/WebM(+内部的にMatroska)のデマルチプレクサのみを
 * 対象にすることで、対応外コンテナは早期に「読み取り不可」として扱う。
 * ここではBlobSourceを使い、File全体をサーバーへ送ることなく、
 * ブラウザ内のメモリ／ストリームとしてのみ参照する。
 */
export function createVideoInput(file: File): Input {
  return new Input({
    source: new BlobSource(file),
    formats: SUPPORTED_INPUT_FORMATS,
  });
}

export interface VideoInputInfo {
  input: Input;
  videoTrack: InputVideoTrack;
  displayWidth: number;
  displayHeight: number;
  durationSec: number;
  bestGuessFrameRate: number;
  hasAudio: boolean;
}

/**
 * 動画ファイルを検証し、共通で必要な情報（寸法・長さ・fps等）を取得する。
 * 「拡張子だけを信頼しない」（開発指示書 33章）ため、実際にmediabunnyで
 * コンテナを読み取り・映像トラックの有無を確認したうえで判定する。
 * 不正/非対応ファイルは分かりやすい日本語メッセージのErrorをthrowする
 * （internal stack traceは含めない。開発指示書 41章）。
 */
export async function inspectVideoFile(file: File): Promise<VideoInputInfo> {
  const input = createVideoInput(file);

  let canRead: boolean;
  try {
    canRead = await input.canRead();
  } catch {
    input.dispose();
    throw new Error(
      "動画の読み込みに失敗しました。ファイルが破損しているか、対応していない形式の可能性があります。"
    );
  }

  if (!canRead) {
    input.dispose();
    throw new Error(
      "この動画形式には対応していません。対応形式（MP4 / MOV / WebM）のファイルを選択してください。"
    );
  }

  const videoTrack = await input.getPrimaryVideoTrack().catch(() => null);
  if (!videoTrack) {
    input.dispose();
    throw new Error("この動画ファイルには映像トラックが含まれていません。");
  }

  const canDecode = await videoTrack.canDecode().catch(() => false);
  if (!canDecode) {
    input.dispose();
    throw new Error(
      "この動画のコーデックはお使いのブラウザでデコードできません。別の形式のファイルをお試しください。"
    );
  }

  const [displayWidth, displayHeight, durationSec, audioTrack, frameRateMetrics] = await Promise.all([
    videoTrack.getDisplayWidth(),
    videoTrack.getDisplayHeight(),
    input.computeDuration(),
    input.getPrimaryAudioTrack().catch(() => null),
    videoTrack.computeFrameRateMetrics().catch(() => null),
  ]);

  return {
    input,
    videoTrack,
    displayWidth,
    displayHeight,
    durationSec,
    bestGuessFrameRate: frameRateMetrics?.bestGuessFrameRate ?? 30,
    hasAudio: audioTrack !== null,
  };
}

/**
 * 実際にこのブラウザでH.264(avc)エンコードが可能かどうかを実行時に確認する
 * （開発指示書 24章：「WebCodecsがあるから全部H.264変換できる」と考えない）。
 * widthを渡すことで、解像度によってはハードウェアエンコーダの制約に
 * 引っかかるケースも可能な範囲で検出する。
 */
export async function checkH264EncodeSupport(width: number, height: number): Promise<boolean> {
  try {
    return await canEncodeVideo("avc", { width, height });
  } catch {
    return false;
  }
}

/** 圧縮レベルのUI選択肢。ユーザーが「何が変わるか」わかるよう明示する（開発指示書 19章） */
export type CompressionLevel = "low" | "medium" | "high";

export const COMPRESSION_LEVEL_OPTIONS: {
  value: CompressionLevel;
  label: string;
  description: string;
  quality: "high" | "medium" | "low";
}[] = [
  {
    value: "low",
    label: "弱め",
    description: "画質を優先し、圧縮は控えめにします（ファイルサイズはあまり小さくなりません）",
    quality: "high",
  },
  {
    value: "medium",
    label: "標準",
    description: "画質とファイルサイズのバランスを取ります",
    quality: "medium",
  },
  {
    value: "high",
    label: "強め",
    description: "ファイルサイズを優先して小さくします（画質は下がります）",
    quality: "low",
  },
];

export function qualityFor(level: CompressionLevel): Quality {
  const opt = COMPRESSION_LEVEL_OPTIONS.find((o) => o.value === level);
  return new Quality(opt?.quality ?? "medium");
}

/** 解像度プリセット。入力より大きい場合はアップスケールしないため候補から除外する（開発指示書 20章） */
export const RESOLUTION_PRESETS = [1080, 720, 480] as const;

/**
 * 入力動画の短辺以下の解像度プリセットのみを候補として返す
 * （開発指示書 20章：アップスケールは行わず、ダウンスケールのみを基本とする）。
 */
export function getAvailableResolutionPresets(displayWidth: number, displayHeight: number): number[] {
  const shortSide = Math.min(displayWidth, displayHeight);
  return RESOLUTION_PRESETS.filter((p) => p <= shortSide);
}

/**
 * 解像度プリセット（短辺の目標値）から、mediabunnyへ渡すwidth/height
 * オプションを組み立てる。長辺は指定せずmediabunnyの自動アスペクト比計算に
 * 任せることで、縦動画・横動画どちらでも正しくアスペクト比を維持する
 * （開発指示書 20章）。
 */
export function resolutionOptionsFor(
  displayWidth: number,
  displayHeight: number,
  shortSideTarget: number
): { width?: number; height?: number } {
  if (displayWidth <= displayHeight) {
    // 縦動画（またはスクエア）: 幅が短辺
    return { width: shortSideTarget };
  }
  // 横動画: 高さが短辺
  return { height: shortSideTarget };
}

/** フレームレートプリセット。入力のfpsより高い値は候補から除外する（開発指示書 21章） */
export const FRAME_RATE_PRESETS = [60, 30, 24, 15] as const;

/**
 * 入力動画の実測fpsより低いプリセットのみを候補として返す
 * （開発指示書 21章：フレーム複製によるアップサンプリングは行わない）。
 * 明らかな丸め誤差（29.97fps等）を考慮し、0.5fpsの余裕を持たせて比較する。
 */
export function getAvailableFrameRates(sourceFps: number): number[] {
  return FRAME_RATE_PRESETS.filter((fps) => fps <= sourceFps + 0.5);
}

/**
 * サムネイル抽出時、巨大な入力（4K/8K等）の場合に出力画像が無駄に大きく
 * ならないよう、長辺をこのサイズまでにキャップする（開発指示書 27章）。
 * 元動画がこれより小さい場合はそのままのサイズを使う（アップスケールしない）。
 */
export const MAX_THUMBNAIL_DIMENSION = 1920;

export function thumbnailCanvasOptionsFor(
  displayWidth: number,
  displayHeight: number
): { width?: number; height?: number } {
  const longSide = Math.max(displayWidth, displayHeight);
  if (longSide <= MAX_THUMBNAIL_DIMENSION) return {};
  return displayWidth >= displayHeight
    ? { width: MAX_THUMBNAIL_DIMENSION }
    : { height: MAX_THUMBNAIL_DIMENSION };
}

export function createThumbnailCanvasSink(
  videoTrack: InputVideoTrack,
  displayWidth: number,
  displayHeight: number
): CanvasSink {
  return new CanvasSink(videoTrack, thumbnailCanvasOptionsFor(displayWidth, displayHeight));
}

/**
 * 変換後のBlobを実際にmediabunnyで読み直し、本当の出力解像度を取得する。
 * 「生成できたはず」の値を計算で仮定するのではなく、実際に生成された
 * ファイルを検証する（Phase 8/9で確立した方針を踏襲）。
 */
export async function inspectOutputDimensions(
  blob: Blob,
  container: OutputContainer
): Promise<{ width: number; height: number }> {
  const input = new Input({
    source: new BlobSource(blob),
    formats: container === "mp4" ? [MP4] : [WEBM],
  });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) return { width: 0, height: 0 };
    const [width, height] = await Promise.all([track.getDisplayWidth(), track.getDisplayHeight()]);
    return { width, height };
  } finally {
    input.dispose();
  }
}

export interface RunConversionParams {
  input: Input;
  container: OutputContainer;
  video?: ConversionVideoOptions;
  audio?: ConversionAudioOptions;
  onProgress?: (progress: number) => void;
}

export interface RunConversionResult {
  blob: Blob;
  sizeBytes: number;
}

/**
 * mediabunnyのConversion APIを使った共通の変換実行処理。
 * 6ツールのうちサムネイル抽出以外の5ツールが、この関数の薄いラッパーとして
 * 実装される（形式変換・圧縮・解像度変更・フレームレート変更・H.264変換の
 * 違いは、渡す `video` / `audio` オプションの違いだけに集約される）。
 *
 * 出力はBufferTarget（メモリ上のArrayBuffer）。完了後はBlobだけを残し、
 * Input側は呼び出し元でdispose()する（このモジュールでは責務を分けるため
 * disposeしない）。
 */
export async function runConversion({
  input,
  container,
  video,
  audio,
  onProgress,
}: RunConversionParams): Promise<RunConversionResult> {
  const target = new BufferTarget();
  const output = new Output({
    format: outputFormatFor(container),
    target,
  });

  const conversion = await Conversion.init({
    input,
    output,
    video,
    audio,
  });

  if (!conversion.isValid) {
    const reasons = conversion.discardedTracks.map((t) => t.reason).join(" / ");
    throw new Error(
      reasons
        ? `この動画は変換できませんでした（${reasons}）。`
        : "この動画は指定した条件では変換できませんでした。"
    );
  }

  if (onProgress) {
    conversion.onProgress = (progress) => onProgress(progress);
  }

  await conversion.execute();

  if (!target.buffer) {
    throw new Error("動画の生成に失敗しました。");
  }

  const blob = new Blob([target.buffer], { type: mimeTypeFor(container) });
  return { blob, sizeBytes: blob.size };
}
