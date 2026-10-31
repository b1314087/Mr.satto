import type { HandoffFileKind, ToolHandoffSpec } from "./types";

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

/** 複数のファイルを受け取るツールで、1回の受け渡しで渡せる数（受け渡し用の上限。手で選ぶ場合の上限ではない） */
const MULTI = 20;

export const TOOL_HANDOFF: Readonly<Record<string, ToolHandoffSpec>> = {
  // ---------------- 画像 ----------------
  "image-resize": { role: "edit", receive: { kinds: IMAGES, maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: IMAGES } },
  "image-compress": { role: "edit", receive: { kinds: IMAGES, maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: IMAGES } },
  "image-format-convert": {
    role: "convert",
    receive: { kinds: [...IMAGES, "gif"], maxFiles: MULTI, maxFileSizeMB: 50 },
    send: { kinds: [...IMAGES, "zip"] },
  },
  "image-crop": { role: "edit", receive: { kinds: IMAGES, maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: IMAGES } },
  "image-rotate-flip": { role: "edit", receive: { kinds: IMAGES, maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: IMAGES } },
  "image-grayscale": { role: "edit", receive: { kinds: IMAGES, maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: IMAGES } },
  "image-metadata-remove": { role: "edit", receive: { kinds: IMAGES, maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: IMAGES } },
  "image-watermark": { role: "edit", receive: { kinds: IMAGES, maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: IMAGES } },
  "image-mosaic": { role: "edit", receive: { kinds: IMAGES, maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: IMAGES } },
  "image-sns-size": { role: "edit", receive: { kinds: IMAGES, maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: IMAGES } },

  // ---------------- PDF ----------------
  // PDF編集は、開いた直後が「結合」（複数のPDFが前提）のため、受け取りは設定しない。結果の送り出しだけ行う
  "pdf-edit": { role: "edit", send: { kinds: ["pdf", "zip"] } },
  "pdf-fix": { role: "edit", receive: { kinds: ["pdf"], maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: ["pdf"] } },
  "pdf-redact": { role: "edit", receive: { kinds: ["pdf"], maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: ["pdf"] } },
  "pdf-compress": { role: "edit", receive: { kinds: ["pdf"], maxFiles: 1, maxFileSizeMB: 100 }, send: { kinds: ["pdf"] } },
  "pdf-metadata-remove": { role: "edit", receive: { kinds: ["pdf"], maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: ["pdf"] } },
  "pdf-resize-pages": { role: "edit", receive: { kinds: ["pdf"], maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: ["pdf"] } },
  "pdf-crop-pages": { role: "edit", receive: { kinds: ["pdf"], maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: ["pdf"] } },
  // パスワード付きにしたPDFは、他のツールで開けないため送り出さない
  "pdf-password-protect": { role: "edit", receive: { kinds: ["pdf"], maxFiles: 1, maxFileSizeMB: 100 } },
  "image-to-pdf": { role: "convert", receive: { kinds: IMAGES, maxFiles: MULTI, maxFileSizeMB: 50 }, send: { kinds: ["pdf"] } },
  "pdf-to-image": { role: "convert", receive: { kinds: ["pdf"], maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: ["png", "jpeg", "zip"] } },
  "pdf-to-text": { role: "convert", receive: { kinds: ["pdf"], maxFiles: 1, maxFileSizeMB: 100 }, send: { kinds: ["txt"] } },
  "pdf-to-word": { role: "convert", receive: { kinds: ["pdf"], maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: ["docx"] } },
  "pdf-to-excel": { role: "convert", receive: { kinds: ["pdf"], maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: ["xlsx"] } },
  ocr: { role: "convert", receive: { kinds: ["pdf", ...IMAGES], maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: ["txt"] } },
  "word-to-pdf": { role: "convert", receive: { kinds: ["docx"], maxFiles: 1, maxFileSizeMB: 30 }, send: { kinds: ["pdf"] } },
  "excel-to-pdf": { role: "convert", receive: { kinds: ["xlsx"], maxFiles: 1, maxFileSizeMB: 30 }, send: { kinds: ["pdf"] } },

  // ---------------- CSV・Excel・Word・PowerPoint ----------------
  // Excel/CSV変換は、開いた直後が「Excel→CSV」のため、Excelを受け取る
  "excel-csv-convert": { role: "convert", receive: { kinds: ["xlsx"], maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: ["csv", "xlsx"] } },
  "csv-dedupe": { role: "edit", receive: { kinds: ["csv"], maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: ["csv"] } },
  "csv-replace": { role: "edit", receive: { kinds: ["csv"], maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: ["csv"] } },
  "csv-column-editor": { role: "edit", receive: { kinds: ["csv"], maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: ["csv"] } },
  "csv-merge": { role: "edit", receive: { kinds: ["csv"], maxFiles: MULTI, maxFileSizeMB: 50 }, send: { kinds: ["csv"] } },
  "excel-transpose": { role: "edit", receive: { kinds: ["xlsx"], maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: ["xlsx"] } },
  "excel-blank-remove": { role: "edit", receive: { kinds: ["xlsx"], maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: ["xlsx"] } },
  "excel-replace": { role: "edit", receive: { kinds: ["xlsx"], maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: ["xlsx"] } },
  "excel-merge-center": { role: "edit", receive: { kinds: ["xlsx"], maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: ["xlsx"] } },
  "excel-date-shift": { role: "edit", receive: { kinds: ["xlsx"], maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: ["xlsx"] } },
  "word-paragraph-cleanup": { role: "edit", receive: { kinds: ["docx"], maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: ["docx"] } },
  "word-renumber": { role: "edit", receive: { kinds: ["docx"], maxFiles: 1, maxFileSizeMB: 50 }, send: { kinds: ["docx"] } },
  "pptx-invert": { role: "edit", receive: { kinds: ["pptx"], maxFiles: 1, maxFileSizeMB: 150 }, send: { kinds: ["pptx"] } },

  // ---------------- 調べる・まとめる ----------------
  "gaiji-checker": {
    role: "inspect",
    receive: { kinds: ["txt", "csv", "tsv", "md", "docx", "xlsx", "pdf"], maxFiles: 1, maxFileSizeMB: 20 },
  },
  "file-hash": { role: "inspect", receive: { kinds: "any", maxFiles: 1, maxFileSizeMB: 200 } },
  "file-zip": { role: "convert", receive: { kinds: "any", maxFiles: MULTI, maxFileSizeMB: 200 }, send: { kinds: ["zip"] } },
  "file-unzip": { role: "convert", receive: { kinds: ["zip"], maxFiles: 1, maxFileSizeMB: 200 } },

  // ---------------- 生成（受け取らない。作ったファイルは送り出せる） ----------------
  "qr-generator": { role: "generate", send: { kinds: ["png"] } },
  "quote-order-generator": { role: "generate", send: { kinds: ["pdf"] } },
  "fiscal-calendar": { role: "generate", send: { kinds: ["xlsx", "pdf"] } },
  "shift-schedule": { role: "generate", send: { kinds: ["pdf", "xlsx", "csv"] } },
};
