import type { HandoffFileKind, ToolHandoffSpec } from "./types";
// 一括処理に対応したツールは、一括処理の上限まで受け取る（無料・旧スタンダードでは、受け取った先頭の1つだけを使う）
import { BATCH_LIMITS } from "@/lib/batch/batch-config";


/**
 * ツール間のファイル受け渡し（工程16）の、ツールごとの設定。全ツール分の唯一の定義箇所。
 *
 * ここに書いたツールだけが、受け取り（receive）・送り出し（send）を行う。書いていないツールは、
 * どちらもしない（ツールページ・検索・関連ツールのリンク・ダウンロードはこれまでどおり使える）。
 *
 * 決めごと：
 * - 実装（ファイル選択欄の形式・上限・複数選択、結果のダウンロード）を確認できたツールだけを書く。推測では書かない。
 * - receive の上限（maxFileSizeMB）と複数可否は、そのツールのファイル選択欄と同じにする（tests/handoff で照合）。
 * - 生成ツール（role: "generate"）は受け取らない（他のツールのファイルを入れる用途がないため）。送り出しはできる。
 * - 調べるツール（role: "inspect"）の結果は元のファイルではないため、送り出さない。
 * - 総合ツール（PDF修正・Excel/CSV変換など）は、そのページを開いたときに最初に出る機能の入力に合わせる。
 * - 個別URLを残している統合済みのツール（mergedInto）は、受け渡し先の候補には出さない（総合ツールが代わりに出る）。
 *   送り出しは、総合ツールの設定を使う（同じ画面のため）。
 * - ZIPは展開せず、ZIPのまま扱う（展開して渡すと、パスや容量の確認が受け取り側ごとに必要になるため）。
 *
 * 設定しなかった主なツールと理由は、docs/reports/stage16-tool-handoff.md にまとめている。
 */

const IMAGES: readonly HandoffFileKind[] = ["png", "jpeg", "webp"];

// 音声・動画のファイル選択欄の上限（MB）。重い処理のモジュールを読み込まないよう、値をここに書く
// （src/lib/audio/shared.ts の AUDIO_DROPZONE_MAX_MB・src/lib/video/shared.ts の VIDEO_DROPZONE_MAX_MB と同じ。tests/handoff で照合）
const AUDIO_DROPZONE_MAX_MB = 100000;
const VIDEO_DROPZONE_MAX_MB = Number.POSITIVE_INFINITY;

/** 音声のツールが受け取れる種類（音声ファイルと、音声付きの動画。動画は音声だけを使う） */
const AUDIO_IN: readonly HandoffFileKind[] = ["mp3", "wav", "m4a", "ogg", "flac", "webm", "mp4", "mov"];
/** 音声のツールが書き出す種類 */
const AUDIO_OUT: readonly HandoffFileKind[] = ["mp3", "wav", "m4a", "ogg", "flac"];
/** 動画のツールが受け取れる種類（実際に読み込みを確かめた3形式） */
const VIDEO_IN: readonly HandoffFileKind[] = ["mp4", "mov", "webm"];
/** 動画のツールが書き出す種類 */
const VIDEO_OUT: readonly HandoffFileKind[] = ["mp4", "webm"];

/** 複数のファイルを受け取るツールで、1回の受け渡しで渡せる数（受け渡し用の上限。手で選ぶ場合の上限ではない） */
const MULTI = 20;

export const TOOL_HANDOFF: Readonly<Record<string, ToolHandoffSpec>> = {
  // ---------------- 画像 ----------------
  "image-compress": { role: "edit", receive: { kinds: IMAGES, maxFiles: BATCH_LIMITS["image-compress"], maxFileSizeMB: 50 }, send: { kinds: IMAGES } },
  "image-format-convert": {
    role: "convert",
    receive: { kinds: [...IMAGES, "gif"], maxFiles: MULTI, maxFileSizeMB: 50 },
    send: { kinds: [...IMAGES, "zip"] },
  },
  "image-crop": { role: "edit", receive: { kinds: IMAGES, maxFiles: BATCH_LIMITS["image-crop"], maxFileSizeMB: 50 }, send: { kinds: IMAGES } },
  "image-rotate-flip": { role: "edit", receive: { kinds: IMAGES, maxFiles: BATCH_LIMITS["image-rotate-flip"], maxFileSizeMB: 50 }, send: { kinds: IMAGES } },
  // 工程3：画像グレースケールは、色調補正（image-adjust）に統合した（受け取りも統合先で行う。複数枚の一括処理に対応）
  "image-adjust": { role: "edit", receive: { kinds: IMAGES, maxFiles: BATCH_LIMITS["image-adjust"], maxFileSizeMB: 50 }, send: { kinds: IMAGES } },
  "image-metadata-remove": { role: "edit", receive: { kinds: IMAGES, maxFiles: BATCH_LIMITS["image-metadata-remove"], maxFileSizeMB: 50 }, send: { kinds: IMAGES } },
  "image-watermark": { role: "edit", receive: { kinds: IMAGES, maxFiles: BATCH_LIMITS["image-watermark"], maxFileSizeMB: 50 }, send: { kinds: IMAGES } },
  "image-mosaic": { role: "edit", receive: { kinds: IMAGES, maxFiles: BATCH_LIMITS["image-mosaic"], maxFileSizeMB: 50 }, send: { kinds: IMAGES } },

  // ---------------- PDF ----------------
  // PDF編集は、開いた直後が「結合」（複数のPDFが前提）のため、受け取りは設定しない。結果の送り出しだけ行う
  "pdf-edit": { role: "edit", send: { kinds: ["pdf", "zip"] } },
  "pdf-fix": { role: "edit", receive: { kinds: ["pdf"], maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: ["pdf"] } },
  "pdf-compress": { role: "edit", receive: { kinds: ["pdf"], maxFiles: BATCH_LIMITS["pdf-compress"], maxFileSizeMB: 100 }, send: { kinds: ["pdf"] } },
  "pdf-metadata-remove": { role: "edit", receive: { kinds: ["pdf"], maxFiles: BATCH_LIMITS["pdf-metadata-remove"], maxFileSizeMB: 50 }, send: { kinds: ["pdf"] } },
  "pdf-resize-pages": { role: "edit", receive: { kinds: ["pdf"], maxFiles: BATCH_LIMITS["pdf-resize-pages"], maxFileSizeMB: 50 }, send: { kinds: ["pdf"] } },
  "pdf-crop-pages": { role: "edit", receive: { kinds: ["pdf"], maxFiles: BATCH_LIMITS["pdf-crop-pages"], maxFileSizeMB: 50 }, send: { kinds: ["pdf"] } },
  // パスワード付きにしたPDFは、他のツールで開けないため送り出さない
  "pdf-password-protect": { role: "edit", receive: { kinds: ["pdf"], maxFiles: BATCH_LIMITS["pdf-password-protect"], maxFileSizeMB: 100 } },
  "image-to-pdf": { role: "convert", receive: { kinds: IMAGES, maxFiles: MULTI, maxFileSizeMB: 50 }, send: { kinds: ["pdf"] } },
  "pdf-to-image": { role: "convert", receive: { kinds: ["pdf"], maxFiles: BATCH_LIMITS["pdf-to-image"], maxFileSizeMB: 50 }, send: { kinds: ["png", "jpeg", "zip"] } },
  // 工程4：OCRを統合し、画像も受け取る（旧 ocr の設定は削除）
  "pdf-to-text": { role: "convert", receive: { kinds: ["pdf", ...IMAGES], maxFiles: 1, maxFileSizeMB: 100 }, send: { kinds: ["txt"] } },
  "pdf-to-word": { role: "convert", receive: { kinds: ["pdf"], maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: ["docx"] } },
  "pdf-to-excel": { role: "convert", receive: { kinds: ["pdf"], maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: ["xlsx"] } },
  "word-to-pdf": { role: "convert", receive: { kinds: ["docx"], maxFiles: BATCH_LIMITS["word-to-pdf"], maxFileSizeMB: 30 }, send: { kinds: ["pdf"] } },
  "excel-to-word": { role: "convert", receive: { kinds: ["xlsx"], maxFiles: 1, maxFileSizeMB: 30 }, send: { kinds: ["docx"] } },
  "word-to-excel": { role: "convert", receive: { kinds: ["docx"], maxFiles: 1, maxFileSizeMB: 30 }, send: { kinds: ["xlsx"] } },
  "excel-to-pdf": { role: "convert", receive: { kinds: ["xlsx"], maxFiles: BATCH_LIMITS["excel-to-pdf"], maxFileSizeMB: 30 }, send: { kinds: ["pdf"] } },

  // ---------------- CSV・Excel・Word・PowerPoint ----------------
  // Excel/CSV変換は、開いた直後が「Excel→CSV」のため、Excelを受け取る
  "excel-csv-convert": { role: "convert", receive: { kinds: ["xlsx"], maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: ["csv", "xlsx"] } },
  "csv-dedupe": { role: "edit", receive: { kinds: ["csv"], maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: ["csv"] } },
  "csv-replace": { role: "edit", receive: { kinds: ["csv"], maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: ["csv"] } },
  // 工程3：Excel（.xlsx）にも対応した（受け取り・送り出しとも、CSVとExcel）
  "csv-column-editor": { role: "edit", receive: { kinds: ["csv", "xlsx"], maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: ["csv", "xlsx"] } },
  "excel-transpose": { role: "edit", receive: { kinds: ["xlsx"], maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: ["xlsx"] } },
  "excel-blank-remove": { role: "edit", receive: { kinds: ["xlsx"], maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: ["xlsx"] } },
  "excel-extract": { role: "edit", receive: { kinds: ["xlsx"], maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: ["xlsx"] } },
  "excel-space-remove": { role: "edit", receive: { kinds: ["xlsx"], maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: ["xlsx"] } },
  "excel-replace": { role: "edit", receive: { kinds: ["xlsx"], maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: ["xlsx"] } },
  "excel-date-shift": { role: "edit", receive: { kinds: ["xlsx"], maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: ["xlsx"] } },
  "word-paragraph-cleanup": { role: "edit", receive: { kinds: ["docx"], maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: ["docx"] } },
  "pptx-invert": { role: "edit", receive: { kinds: ["pptx"], maxFiles: 1, maxFileSizeMB: 150 }, send: { kinds: ["pptx"] } },

  // ---------------- 調べる・まとめる ----------------
  "file-hash": { role: "inspect", receive: { kinds: "any", maxFiles: 1, maxFileSizeMB: 200 } },
  "file-zip": { role: "convert", receive: { kinds: "any", maxFiles: MULTI, maxFileSizeMB: 200 }, send: { kinds: ["zip"] } },
  "file-unzip": { role: "convert", receive: { kinds: ["zip"], maxFiles: BATCH_LIMITS["file-unzip"], maxFileSizeMB: 200 } },

  // ---------------- 音声・動画（2026-11-18） ----------------
  // 音声・動画のファイルは大きいため、受け渡しの置き場の合計の上限（600MB）を超えるものは、ダウンロードして使ってもらう
  "audio-convert": { role: "convert", receive: { kinds: AUDIO_IN, maxFiles: 1, maxFileSizeMB: AUDIO_DROPZONE_MAX_MB }, send: { kinds: AUDIO_OUT } },
  "audio-extract": { role: "convert", receive: { kinds: VIDEO_IN, maxFiles: 1, maxFileSizeMB: AUDIO_DROPZONE_MAX_MB }, send: { kinds: AUDIO_OUT } },
  "audio-trim": { role: "edit", receive: { kinds: AUDIO_IN, maxFiles: 1, maxFileSizeMB: AUDIO_DROPZONE_MAX_MB }, send: { kinds: AUDIO_OUT } },
  "audio-merge": { role: "edit", receive: { kinds: AUDIO_IN, maxFiles: MULTI, maxFileSizeMB: AUDIO_DROPZONE_MAX_MB }, send: { kinds: AUDIO_OUT } },
  "audio-volume": { role: "edit", receive: { kinds: AUDIO_IN, maxFiles: 1, maxFileSizeMB: AUDIO_DROPZONE_MAX_MB }, send: { kinds: AUDIO_OUT } },
  "audio-compress": { role: "edit", receive: { kinds: AUDIO_IN, maxFiles: 1, maxFileSizeMB: AUDIO_DROPZONE_MAX_MB }, send: { kinds: AUDIO_OUT } },
  // 文字起こし（AI）：音声・動画を受け取り、文章（.txt）を送り出す
  "audio-transcribe": { role: "convert", receive: { kinds: AUDIO_IN, maxFiles: 1, maxFileSizeMB: AUDIO_DROPZONE_MAX_MB }, send: { kinds: ["txt"] } },
  "video-convert": { role: "convert", receive: { kinds: VIDEO_IN, maxFiles: 1, maxFileSizeMB: VIDEO_DROPZONE_MAX_MB }, send: { kinds: VIDEO_OUT } },
  "video-compress": { role: "edit", receive: { kinds: VIDEO_IN, maxFiles: 1, maxFileSizeMB: VIDEO_DROPZONE_MAX_MB }, send: { kinds: VIDEO_OUT } },
  "video-resize": { role: "edit", receive: { kinds: VIDEO_IN, maxFiles: 1, maxFileSizeMB: VIDEO_DROPZONE_MAX_MB }, send: { kinds: VIDEO_OUT } },
  "video-frame-rate": { role: "edit", receive: { kinds: VIDEO_IN, maxFiles: 1, maxFileSizeMB: VIDEO_DROPZONE_MAX_MB }, send: { kinds: VIDEO_OUT } },
  "video-h264": { role: "convert", receive: { kinds: VIDEO_IN, maxFiles: 1, maxFileSizeMB: VIDEO_DROPZONE_MAX_MB }, send: { kinds: ["mp4"] } },
  "video-cut-merge": { role: "edit", receive: { kinds: VIDEO_IN, maxFiles: 1, maxFileSizeMB: VIDEO_DROPZONE_MAX_MB }, send: { kinds: VIDEO_OUT } },
  "video-metadata-remove": { role: "edit", receive: { kinds: VIDEO_IN, maxFiles: 1, maxFileSizeMB: VIDEO_DROPZONE_MAX_MB }, send: { kinds: VIDEO_OUT } },
  "video-mosaic": { role: "edit", receive: { kinds: VIDEO_IN, maxFiles: 1, maxFileSizeMB: VIDEO_DROPZONE_MAX_MB }, send: { kinds: VIDEO_OUT } },
  // 動画字幕：字幕を焼き付けたMP4・WebMを送り出す
  "video-subtitle": { role: "edit", receive: { kinds: VIDEO_IN, maxFiles: 1, maxFileSizeMB: VIDEO_DROPZONE_MAX_MB }, send: { kinds: VIDEO_OUT } },
  "video-thumbnail": { role: "inspect", receive: { kinds: VIDEO_IN, maxFiles: 1, maxFileSizeMB: VIDEO_DROPZONE_MAX_MB } },

  // ---------------- 生成（受け取らない。作ったファイルは送り出せる） ----------------
  "qr-generator": { role: "generate", send: { kinds: ["png"] } },
  "quote-order-generator": { role: "generate", send: { kinds: ["pdf"] } },
  "fiscal-calendar": { role: "generate", send: { kinds: ["xlsx", "pdf"] } },
  "shift-schedule": { role: "generate", send: { kinds: ["pdf", "xlsx", "csv"] } },
  // 録音：保存の形式（MP3・WAV・M4A・OGG・FLAC）で送り出す。画面録画：WebM・MP4で送り出す
  "voice-recorder": { role: "generate", send: { kinds: AUDIO_OUT } },
  "screen-recorder": { role: "generate", send: { kinds: VIDEO_OUT } },
};
