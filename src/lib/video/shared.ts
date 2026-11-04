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
import type { ConversionAudioOptions, ConversionCopyOptions, ConversionVideoOptions, InputVideoTrack, MetadataTags } from "mediabunny";
import { createBlobStreamTarget, moveMoovToFront } from "./stream-output";
import type * as MB from "mediabunny";
import { ensureMediabunny, mediabunny } from "@/lib/media/mediabunny-loader";

/**
 * このアプリが「対応形式」として明示的にサポートする入力コンテナ。
 * 動画の部品（mediabunny）を読み込んだあとに使うため、関数にしている（ロードマップC 工程4：ページを開いた時点では部品を読み込まない）
 */
export function supportedInputFormats() {
  return [mediabunny().MP4, mediabunny().QTFF, mediabunny().WEBM];
}

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
 * 動画の読み込みサイズに上限は設けない(読み込みを止めない)。
 *
 * 動画はブラウザのメモリ上で処理し、出力もメモリ上(BufferTarget)に保持するため、とても大きいファイルは
 * 時間がかかったり、メモリ不足で失敗したりすることがある。そのため上限で止める代わりに、
 * 一定サイズ以上のときは警告だけを表示し、ユーザーの判断で続行できるようにする。
 *
 * 目安の根拠(Phase 10の実測。GPUのないヘッドレスChromiumで、圧縮しにくい合成映像による悪条件):
 * 約48MBの変換・圧縮は約71秒で完走、約238MBは10分以内に完走を確認できなかった。
 * 実際のブラウザ(ハードウェア支援あり)ではこれより速いことが多いが、環境による差が大きい。
 */
export const VIDEO_SIZE_WARN_MB = 300;
/** この大きさを超えると、メモリ不足で失敗する可能性が特に高い(ブラウザが1ファイルに確保できるメモリの目安) */
export const VIDEO_SIZE_STRONG_WARN_MB = 1500;

/** FileDropzoneに渡す、読み込みサイズの上限(上限なし) */
export const VIDEO_DROPZONE_MAX_MB = Number.POSITIVE_INFINITY;

/** サイズが大きい動画に表示する警告文。警告が不要なサイズならnull */
export function videoSizeWarning(sizeBytes: number): string | null {
  const mb = sizeBytes / (1024 * 1024);
  if (mb >= VIDEO_SIZE_STRONG_WARN_MB) {
    return `ファイルがとても大きい（約${(mb / 1024).toFixed(1)}GB）ため、処理に非常に長い時間がかかったり、ブラウザのメモリ不足で失敗したりする可能性が高いです。このまま続行することもできます。うまくいかない場合は、動画を分割してからお試しください。`;
  }
  if (mb >= VIDEO_SIZE_WARN_MB) {
    return `ファイルが大きい（約${Math.round(mb)}MB）ため、処理に時間がかかったり、お使いの端末やブラウザによってはメモリ不足で失敗したりする場合があります。このまま続行できます。`;
  }
  return null;
}

/**
 * 利用者向けに日本語の案内へ置き換えた動画のエラー。
 * 原因の調査に必要な元のエラーは cause に残す（画面には出さない。ファイル名や動画の内容は含めない）。
 */
export class VideoUserFacingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VideoUserFacingError";
  }
}

const MEMORY_ERROR_MESSAGE =
  "動画の処理に必要なメモリが不足しました。他のタブやアプリを閉じてから再度お試しいただくか、動画のサイズや解像度を下げて（短く分割して）お試しください。";

/** 日本語の案内として、そのまま画面に出してよいメッセージか（このアプリが作ったメッセージ） */
function isJapaneseMessage(message: string): boolean {
  return /[\u3040-\u30ff\u4e00-\u9fff]/.test(message);
}

/**
 * 動画処理で起きたエラーを、原因に合った日本語の案内にする。
 * - メモリ不足・読み込み（デコード）の失敗・書き出し（エンコード）の失敗を見分ける。
 * - 原因が分からないときは断定せず、試せることを案内する。
 * - すでに日本語の案内（このアプリが作ったもの）はそのまま使う。
 */
export function toFriendlyVideoError(e: unknown): Error {
  if (e instanceof VideoUserFacingError || e instanceof VideoCanceledByUserError || e instanceof VideoAudioWouldBeLostError) return e;
  const message = e instanceof Error ? e.message : String(e);
  const name = e instanceof Error ? e.name : "";
  if (
    (e instanceof RangeError && /allocation|array buffer|invalid (typed )?array length/i.test(message)) ||
    /out of memory|allocation failed|QuotaExceeded/i.test(message) ||
    name === "QuotaExceededError"
  ) {
    return new VideoUserFacingError(MEMORY_ERROR_MESSAGE, { cause: e });
  }
  if (e instanceof Error && isJapaneseMessage(message)) return e;
  // 開発者向けの手がかり（エラーの種類と英語のメッセージだけ。ファイル名・動画の内容は出さない）
  if (typeof console !== "undefined") console.warn("[video] 処理に失敗しました:", name || "Error", message);
  if (/decod/i.test(message) || name === "DataError") {
    return new VideoUserFacingError(
      "動画を読み込めませんでした。ファイルが壊れていないか、対応形式（MP4・MOV・WebM）の動画か確認してください。別のブラウザで開くと読み込める場合もあります。",
      { cause: e }
    );
  }
  if (/encod/i.test(message) || name === "EncodingError" || name === "OperationError") {
    return new VideoUserFacingError(
      "動画を書き出せませんでした。出力形式や設定を変えて、もう一度お試しください。",
      { cause: e }
    );
  }
  if (name === "NotSupportedError") {
    return new VideoUserFacingError(
      "お使いのブラウザでは、この動画をこの設定で処理できません。出力形式や設定を変えるか、別のブラウザでお試しください。",
      { cause: e }
    );
  }
  return new VideoUserFacingError(
    "動画の処理中に問題が発生しました。もう一度お試しいただくか、出力形式や設定を変えてお試しください。",
    { cause: e }
  );
}

/** 変換できずに外されたトラックの理由（mediabunny の DiscardedTrack.reason）を、日本語の案内にする */
export function discardReasonMessage(kind: "video" | "audio", reason: string, container: OutputContainer): string {
  const format = container === "mp4" ? "MP4" : "WebM";
  if (kind === "audio") {
    switch (reason) {
      case "no_encodable_target_codec":
        return `お使いのブラウザでは、この形式（${format}）で音声を書き出せません。`;
      case "undecodable_source_codec":
        return "お使いのブラウザでは、この動画の音声を読み込めません。";
      case "unknown_source_codec":
        return "この動画の音声の形式を判別できません。";
      default:
        return "この設定では、音声を残せません。";
    }
  }
  switch (reason) {
    case "no_encodable_target_codec":
      return `このブラウザでは、指定した形式（${format}）で動画を書き出せません。別の形式をお試しください。`;
    case "undecodable_source_codec":
      return "お使いのブラウザでは、この動画の映像を読み込めません。別のブラウザか、別の形式の動画でお試しください。";
    case "unknown_source_codec":
      return "この動画の映像の形式を判別できませんでした。対応形式（MP4・MOV・WebM）の動画か確認してください。";
    default:
      return "この動画は、指定した条件では書き出せませんでした。設定を変えてお試しください。";
  }
}

export function outputFormatFor(container: OutputContainer) {
  // MP4は、書き出しの途中でデータをメモリにためないよう、再生情報（moov）を最後に書く（fastStart: false）。
  // 書き出し後に moov を先頭へ移す（stream-output.ts の moveMoovToFront）ため、できあがるファイルは従来と同じ並び。
  return container === "mp4" ? new (mediabunny().Mp4OutputFormat)({ fastStart: false }) : new (mediabunny().WebMOutputFormat)();
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
export function createVideoInput(file: File): MB.Input {
  return new (mediabunny().Input)({
    source: new (mediabunny().BlobSource)(file),
    formats: supportedInputFormats(),
  });
}

/** 映像コーデックの表示名(ユーザー向け) */
export function videoCodecLabel(codec: string | null | undefined): string {
  switch (codec) {
    case "avc":
      return "H.264（AVC）";
    case "hevc":
      return "H.265（HEVC）";
    case "vp8":
      return "VP8";
    case "vp9":
      return "VP9";
    case "av1":
      return "AV1";
    default:
      return codec ? codec.toUpperCase() : "不明";
  }
}

/** H.265(HEVC)をこのブラウザで読み込めないときの案内 */
export const HEVC_UNSUPPORTED_MESSAGE =
  "この動画はH.265（HEVC）形式ですが、お使いのブラウザでは読み込めません。H.265の読み込みには、Safari、またはH.265に対応したパソコン・スマートフォンの最新のChrome・Edgeが必要です（Firefoxは非対応）。対応ブラウザでお試しください。";

export interface VideoInputInfo {
  input: MB.Input;
  videoTrack: InputVideoTrack;
  /** 映像コーデック("avc" / "hevc" / "vp9" など) */
  codec: string | null;
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
  await ensureMediabunny();
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

  const codec = await videoTrack.getCodec().catch(() => null);
  const canDecode = await videoTrack.canDecode().catch(() => false);
  if (!canDecode) {
    input.dispose();
    throw new Error(
      codec === "hevc"
        ? HEVC_UNSUPPORTED_MESSAGE
        : `この動画のコーデック（${videoCodecLabel(codec)}）はお使いのブラウザでデコードできません。別の形式のファイルをお試しください。`
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
    codec,
    displayWidth,
    displayHeight,
    durationSec,
    bestGuessFrameRate: frameRateMetrics?.bestGuessFrameRate ?? 30,
    hasAudio: audioTrack !== null,
  };
}

export interface VideoCodecProbe {
  codec: string | null;
  /** このブラウザで映像をデコード(読み込み)できるか */
  canDecode: boolean;
}

/**
 * ファイルを選んだ直後に、映像コーデックと、このブラウザで読み込めるかだけを軽く調べる(変換はしない)。
 * 読み取れないファイルは null。
 */
export async function probeVideoCodec(file: File): Promise<VideoCodecProbe | null> {
  await ensureMediabunny();
  const input = createVideoInput(file);
  try {
    if (!(await input.canRead())) return null;
    const track = await input.getPrimaryVideoTrack();
    if (!track) return null;
    const [codec, canDecode] = await Promise.all([
      track.getCodec().catch(() => null),
      track.canDecode().catch(() => false),
    ]);
    return { codec, canDecode };
  } catch {
    return null;
  } finally {
    input.dispose();
  }
}

/**
 * 実際にこのブラウザでH.264(avc)エンコードが可能かどうかを実行時に確認する
 * （開発指示書 24章：「WebCodecsがあるから全部H.264変換できる」と考えない）。
 * widthを渡すことで、解像度によってはハードウェアエンコーダの制約に
 * 引っかかるケースも可能な範囲で検出する。
 */
export async function checkH264EncodeSupport(width: number, height: number): Promise<boolean> {
  await ensureMediabunny();
  try {
    return await mediabunny().canEncodeVideo("avc", { width, height });
  } catch {
    return false;
  }
}

/**
 * この出力形式（MP4・WebM）で、このブラウザが映像を書き出せる（作り直せる）か（動画編集 工程2）。
 * 形式に入れられるコーデックのうち、どれか1つでも実際にエンコードできれば true。
 */
export async function canEncodeVideoInto(container: OutputContainer, width: number, height: number): Promise<boolean> {
  await ensureMediabunny();
  try {
    const codecs = outputFormatFor(container).getSupportedVideoCodecs();
    return (await mediabunny().getFirstEncodableVideoCodec(codecs, { width, height })) !== null;
  } catch {
    return false;
  }
}

/** 元の映像のコーデックを、作り直さずにそのままこの出力形式へ入れられるか */
export function canCopyVideoInto(container: OutputContainer, codec: string | null): boolean {
  if (!codec) return false;
  return (outputFormatFor(container).getSupportedVideoCodecs() as string[]).includes(codec);
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

/** 画質の指定("high"=高画質 / "medium"=標準 / "low"=ファイルサイズ優先) */
export type VideoQualityName = "high" | "medium" | "low";

export function qualityFromName(name: VideoQualityName): MB.Quality {
  return new (mediabunny().Quality)(name);
}

export function qualityFor(level: CompressionLevel): MB.Quality {
  const opt = COMPRESSION_LEVEL_OPTIONS.find((o) => o.value === level);
  return new (mediabunny().Quality)(opt?.quality ?? "medium");
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
): MB.CanvasSink {
  return new (mediabunny().CanvasSink)(videoTrack, thumbnailCanvasOptionsFor(displayWidth, displayHeight));
}

export interface VideoOutputSummary {
  width: number;
  height: number;
  /** 実際のフレームの間隔から推定したフレームレート（分からないときは null） */
  fps: number | null;
  durationSec: number;
  hasAudio: boolean;
}

/**
 * 書き出した動画を読み直して、実際の解像度・フレームレート・長さ・音声の有無を調べる（動画編集 工程2）。
 * 設定から「なったはず」の値を計算するのではなく、できあがったファイルそのものを確かめて結果に表示する。
 */
export async function inspectOutputSummary(blob: Blob, container: OutputContainer): Promise<VideoOutputSummary> {
  await ensureMediabunny();
  const input = new (mediabunny().Input)({
    source: new (mediabunny().BlobSource)(blob),
    formats: container === "mp4" ? [mediabunny().MP4] : [mediabunny().WEBM],
  });
  try {
    const track = await input.getPrimaryVideoTrack();
    const [width, height, metrics, durationSec, audio] = await Promise.all([
      track ? track.getDisplayWidth() : 0,
      track ? track.getDisplayHeight() : 0,
      track ? track.computeFrameRateMetrics().catch(() => null) : null,
      input.computeDuration().catch(() => 0),
      input.getPrimaryAudioTrack().catch(() => null),
    ]);
    return {
      width,
      height,
      fps: metrics?.bestGuessFrameRate ?? null,
      durationSec,
      hasAudio: audio !== null,
    };
  } finally {
    input.dispose();
  }
}

/**
 * ユーザーの明示的な操作（キャンセルボタン）によって処理が中断されたことを
 * 示すエラー。通常の変換失敗（Error）とは区別して扱うため専用のクラスにする
 * （UI側で instanceof 判定し、エラー表示ではなく「キャンセルしました」の
 * 中立な通知に振り分ける。Phase 27・第4段階）。
 */
export class VideoCanceledByUserError extends Error {
  constructor(message = "処理をキャンセルしました。") {
    super(message);
    this.name = "VideoCanceledByUserError";
  }
}

/**
 * 元の動画には音声があるのに、選んだ形式ではこのブラウザで音声を書き出せないことを示すエラー
 * （動画編集 工程1）。何も知らせずに無音の動画を作らないため、書き出しを始める前に止める。
 * 画面では理由を伝え、「音声なしで書き出す」を選べるようにする（選んだときは dropAudio: true で再実行）。
 */
export class VideoAudioWouldBeLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoAudioWouldBeLostError";
  }
}

export interface RunConversionParams {
  input: MB.Input;
  container: OutputContainer;
  video?: ConversionVideoOptions;
  audio?: ConversionAudioOptions;
  /**
   * 出力に付与するメタデータタグ。省略時はmediabunnyの既定動作
   * （入力のメタデータタグをそのまま出力にコピーする）となる。
   * メタデータ削除ツールのみ、空オブジェクト {} を明示的に渡すことで
   * タイトル・作成者・コメント等の記述系メタデータを除去する
   * （開発指示書「単なるリネームではなく実際に除去する」に対応）。
   */
  tags?: MetadataTags;
  /** 切り取る範囲（秒）。動画編集 工程3 */
  trim?: { start?: number; end?: number };
  /** そのまま写す（作り直さない）ときの決まり。正確に切り取るときに使う。動画編集 工程3 */
  copy?: ConversionCopyOptions | false;
  onProgress?: (progress: number) => void;
  /**
   * 音声を書き出さない（映像だけにする）。音声を書き出せない形式で、利用者が「音声なしで書き出す」を
   * 選んだときだけ true にする（動画編集 工程1）。
   */
  dropAudio?: boolean;
  /**
   * ユーザーによるキャンセル要求を伝えるシグナル（Phase 27・第4段階）。
   * abort された時点で、保持している Conversion を実際に cancel() し、
   * execute() の終了を待ってから VideoCanceledByUserError を投げる。
   * mediabunnyのpauseSignalは「一時停止（再開可能）」用のAPIであり、
   * 本機能が必要とする「完全に中断して結果を破棄する」用途には使わない。
   */
  cancelSignal?: AbortSignal;
}

export interface RunConversionResult {
  blob: Blob;
  sizeBytes: number;
}

/**
 * mediabunnyのConversion APIを使った共通の変換実行処理。
 * 動画ツールのうちサムネイル抽出以外が、この関数の薄いラッパーとして実装される
 * （形式変換・圧縮・解像度変更・フレームレート変更・H.264変換・メタデータ削除・モザイクの
 * 違いは、渡す `video` / `audio` / `tags` オプションの違いだけに集約される）。
 *
 * 動画編集 工程1での変更：
 * - 書き出し先を StreamTarget（少しずつBlobの小片にする）に変え、出力全体を1つの配列に持たない
 *   （stream-output.ts）。MP4は書き出し後に moov を先頭へ移す。
 * - 元の動画に音声があるのに、音声を書き出せない場合は、書き出す前に VideoAudioWouldBeLostError で止める
 *   （dropAudio: true のときだけ、音声なしで書き出す）。映像を書き出せない場合も止める。
 * - 書き出したファイルを読み直し、映像（と、残すはずの音声）のトラックがあることを確かめる。
 *   確かめられないファイルは、完成した結果として返さない。
 * - キャンセル・失敗のときは、受け取った途中のデータをすぐに手放す。
 *
 * Input側は呼び出し元でdispose()する（このモジュールでは責務を分けるためdisposeしない）。
 */
export async function runConversion({
  input,
  container,
  video,
  audio,
  tags,
  trim,
  copy,
  onProgress,
  dropAudio = false,
  cancelSignal,
}: RunConversionParams): Promise<RunConversionResult> {
  await ensureMediabunny();
  if (cancelSignal?.aborted) {
    throw new VideoCanceledByUserError();
  }

  const sourceAudio = await input.getPrimaryAudioTrack().catch(() => null);
  const { target, assembler } = createBlobStreamTarget();
  const output = new (mediabunny().Output)({
    format: outputFormatFor(container),
    target,
  });

  let succeeded = false;
  try {
    const conversion = await mediabunny().Conversion.init({
      input,
      output,
      video,
      audio: dropAudio ? { ...audio, discard: true } : audio,
      tags,
      ...(trim ? { trim } : {}),
      ...(copy !== undefined ? { copy } : {}),
      showWarnings: false,
    });

    // 映像を書き出せない（外された）場合は、音声だけのファイルにせず止める
    const droppedVideo = conversion.discardedTracks.find((t) => t.track.type === "video");
    if (droppedVideo || !conversion.isValid) {
      throw new VideoUserFacingError(discardReasonMessage("video", droppedVideo?.reason ?? "", container));
    }
    // 元の動画に音声があるのに書き出せない場合は、何も知らせずに無音の動画を作らない
    const droppedAudio = conversion.discardedTracks.find(
      (t) => t.track.type === "audio" && t.reason !== "discarded_by_user"
    );
    if (droppedAudio && !dropAudio) {
      throw new VideoAudioWouldBeLostError(discardReasonMessage("audio", droppedAudio.reason, container));
    }

    if (onProgress) {
      conversion.onProgress = (progress) => onProgress(progress);
    }

    // キャンセル要求が来たら実際に conversion.cancel() を呼ぶ。mediabunnyの
    // 実装（dist/modules/src/conversion.js）では、cancel() 呼び出し後は
    // 内部状態が 'canceled' になり、実行中の execute() は必ず
    // ConversionCanceledError を throw して終了することをソース確認済み
    // （古い結果が成功としてUIに届くレースは発生しない）。
    // ここでは「ユーザー操作によるキャンセルかどうか」をこのフラグで
    // 自前管理する（mediabunny内部が本当のエラーを検知して自動的に
    // cancel() するケースでは、投げ直されるのは元のエラーであって
    // ConversionCanceledError ではないため、instanceof 判定だけでは
    // 両者を正しく区別できない）。
    let canceledByUser = false;
    const onAbort = () => {
      canceledByUser = true;
      void conversion.cancel();
    };
    cancelSignal?.addEventListener("abort", onAbort);

    try {
      await conversion.execute();
    } catch (e) {
      if (canceledByUser) {
        throw new VideoCanceledByUserError();
      }
      throw toFriendlyVideoError(e);
    } finally {
      cancelSignal?.removeEventListener("abort", onAbort);
    }

    if (canceledByUser || cancelSignal?.aborted) {
      // execute() が例外を投げずに終わる経路は実装上ないはずだが、念のため
      // キャンセル済みの場合は結果を使わずキャンセル扱いにする。
      throw new VideoCanceledByUserError();
    }

    if (assembler.size === 0) {
      throw new VideoUserFacingError("動画の生成に失敗しました。設定を変えて、もう一度お試しください。");
    }

    let blob = assembler.toBlob(mimeTypeFor(container));
    if (container === "mp4") blob = await moveMoovToFront(blob);
    await verifyOutput(blob, container, sourceAudio !== null && !dropAudio);
    succeeded = true;
    return { blob, sizeBytes: blob.size };
  } finally {
    // 失敗・キャンセルのときは、途中まで受け取ったデータをすぐに手放す
    if (!succeeded) assembler.clear();
  }
}

/**
 * 書き出したファイルを読み直して、映像（と、残すはずの音声）のトラックがあることを確かめる。
 * トラックがあることは中身が正常であることの保証ではないが、壊れたファイル・音声が抜けたファイルを
 * 完成した結果として渡さないための最低限の確認。
 */
async function verifyOutput(blob: Blob, container: OutputContainer, expectAudio: boolean): Promise<void> {
  await ensureMediabunny();
  const check = new (mediabunny().Input)({ source: new (mediabunny().BlobSource)(blob), formats: container === "mp4" ? [mediabunny().MP4] : [mediabunny().WEBM] });
  try {
    const videoTrack = await check.getPrimaryVideoTrack().catch(() => null);
    if (!videoTrack) {
      throw new VideoUserFacingError("書き出した動画を確認できませんでした。もう一度お試しいただくか、設定を変えてお試しください。");
    }
    if (expectAudio) {
      const audioTrack = await check.getPrimaryAudioTrack().catch(() => null);
      if (!audioTrack) {
        throw new VideoAudioWouldBeLostError(`書き出した動画に音声が入りませんでした。${discardReasonMessage("audio", "no_encodable_target_codec", container)}`);
      }
    }
  } finally {
    check.dispose();
  }
}
