import type { GuidePart, GuidePreviewKind, GuideStep, ToolGuide } from "@/lib/guides/types";

/**
 * 各ツールの「使い方」の図のデータ（ツールID → 手順）。
 *
 * 部品の表示名（ボタン名・設定名・選択肢）は、実際の画面に出ている文字と同じにしている
 * （実装後の画面を自動で読み取った一覧と、src/components/tools/implementations/*.tsx を照らし合わせて作成）。
 * 画面の文字を変えたときは、ここも合わせて直すこと（tests/ui/tool-guide.spec.ts が、図の文字が画面にあるかを確かめる）。
 *
 * 1つの画面で操作（モード）を切り替えるツール（PDF編集の結合・分割など）は、モードごとに図を用意する
 * （キーは「まとめ先のID@モード」。例：pdf-edit@split）。どのモードの図を出すかは guideModes・pageGuides で決める。
 * 統合済みの旧ツール（pdf-split など。個別のアドレスは残し、まとめ先のツールを該当モードで開くもの）は、
 * そのアドレスで開くモードの図を出す（pageGuides）。
 */

// ---- 部品を作る小さな関数（データを読みやすくするため） ----
const drop = (label: string): GuidePart => ({ k: "drop", label });
const file = (name: string, add = false): GuidePart => ({ k: "file", name, add });
const seg = (label: string | undefined, options: string[], on = 0): GuidePart => ({ k: "seg", label, options, on });
const chips = (label: string | undefined, options: string[], on: number[]): GuidePart => ({ k: "chips", label, options, on });
const btns = (options: string[], on = 0): GuidePart => ({ k: "btns", options, on });
const input = (label: string, value: string): GuidePart => ({ k: "input", label, value });
const input2 = (a: string, av: string, b: string, bv: string): GuidePart => ({ k: "input2", labels: [a, b], values: [av, bv] });
const slider = (label: string, value = 0.5, text?: string): GuidePart => ({ k: "slider", label, value, text });
const check = (label: string, on = true): GuidePart => ({ k: "check", label, on });
const select = (label: string, value: string): GuidePart => ({ k: "select", label, value });
const text = (label: string | undefined, lines: string[]): GuidePart => ({ k: "text", label, lines });
const table = (cols = 4, rows = 3): GuidePart => ({ k: "table", cols, rows });
const head = (t: string, n?: number): GuidePart => ({ k: "head", text: t, n });
const adv = (title: string, summary?: string): GuidePart => ({ k: "adv", title, summary });
const run = (label: string): GuidePart => ({ k: "run", label });
const btn = (label: string): GuidePart => ({ k: "btn", label });
const preview = (kind: GuidePreviewKind, caption?: string): GuidePart => ({ k: "preview", kind, caption });

/** 1ステップ（focus は parts の番号） */
const step = (title: string, parts: GuidePart[], focus: number): GuideStep => ({ title, parts, focus });

/** ファイルを選ぶステップ（ドロップ枠） */
const pick = (title: string, label: string, before: GuidePart[] = []): GuideStep => step(title, [...before, drop(label)], before.length);

/** 実行して、完成の画面からダウンロードする（2ステップ） */
const finish = (runTitle: string, runLabel: string, context: GuidePart[], dl = "ダウンロード"): GuideStep[] => [
  step(runTitle, [...context, run(runLabel)], context.length),
  { title: "ダウンロードする", parts: [...context, run(runLabel)], focus: "popup", popup: { label: dl } },
];

/** PDF編集のモードのボタン（画面の並び順） */
const PDF_MODES = ["結合", "分割", "ページ削除", "ページ抽出", "並び替え", "回転"];

// よく使う見本のファイル名
const IMG = "photo.jpg";
const PDF = "document.pdf";
const XLSX = "data.xlsx";
const CSV = "data.csv";
const DOCX = "report.docx";
const MP4 = "movie.mp4";
const MP3 = "voice.mp3";

/** 音声ツール共通の「保存する形式」 */
const AUDIO_FORMATS = ["元の形式のまま", "MP3", "WAV", "OGG（Opus）"];

/** 動画の編集ツール（圧縮・形式変換・解像度・フレームレート）共通：主の設定・詳細設定・実行 */
const videoEdit = (mainLabel: string, options: string[], on: number, runLabel: string): ToolGuide => ({
  split: false,
  steps: [
    pick("動画を選ぶ", "動画ファイルをドラッグ&ドロップ"),
    step("設定を選ぶ", [file(MP4), seg(mainLabel, options, on), preview("video")], 1),
    ...finish("書き出す", runLabel, [file(MP4), seg(mainLabel, options, on)]),
  ],
});

/** 帳票（見積書・請求書・注文書）共通 */
const documentGuide = (dateLabel: string, runLabel: string): ToolGuide => ({
  split: true,
  steps: [
    step("基本情報・宛先を入れる", [head("基本情報", 1), input("書類タイトル", runLabel.replace("を作成する", "")), input("発行日", "2026-11-11"), head("宛先", 2), input("会社名・屋号", "株式会社サンプル"), preview("invoice")], 4),
    step("明細を入れる", [head("明細", 4), input2("明細1 品名", "作業費", "明細1 単価", "50,000"), btn("＋ 明細を追加"), preview("invoice")], 1),
    step("税・金額を選ぶ", [head("税・金額", 5), seg("消費税率", ["10%", "8%", "0%"], 0), seg("端数処理", ["切り捨て", "四捨五入", "切り上げ"], 0), preview("invoice")], 1),
    { title: "PDFを作る", parts: [head("PDF出力"), run(runLabel), input(dateLabel, ""), preview("invoice", "プレビュー")], focus: 1 },
  ],
});

export const toolGuides: Record<string, ToolGuide> = {
  // ------------------------------------------------------------------ 画像
  "image-compress": {
    split: true,
    steps: [
      step("やることを選ぶ", [chips("やること（どちらか1つ）", ["✓ サイズを変更", "容量を圧縮"], [0]), drop("画像をドラッグ&ドロップ")], 0),
      step("画像を選ぶ", [chips("やること（どちらか1つ）", ["✓ サイズを変更", "容量を圧縮"], [0]), drop("画像をドラッグ&ドロップ")], 1),
      step("サイズを入れる", [file(IMG), input2("幅 (px)", "1280", "高さ (px)", "720"), check("縦横比を固定"), preview("image")], 1),
      ...finish("リサイズする", "リサイズする", [file(IMG), input2("幅 (px)", "1280", "高さ (px)", "720"), check("縦横比を固定")]).slice(0, 1),
    ],
  },
  "image-format-convert": {
    split: true,
    steps: [
      pick("画像を選ぶ", "画像をドラッグ&ドロップ"),
      step("変換先の形式を選ぶ", [file("photo.png"), seg("変換先の形式", ["JPG", "PNG", "WebP"], 0), preview("image")], 1),
      ...finish("変換する", "1件をJPGに変換する", [file("photo.png"), seg("変換先の形式", ["JPG", "PNG", "WebP"], 0)]),
    ],
  },
  "image-format-convert@png": {
    split: true,
    steps: [
      pick("画像を選ぶ", "画像をドラッグ&ドロップ"),
      step("変換先の形式を選ぶ", [file(IMG), seg("変換先の形式", ["JPG", "PNG", "WebP"], 1), preview("image")], 1),
      ...finish("変換する", "1件をPNGに変換する", [file(IMG), seg("変換先の形式", ["JPG", "PNG", "WebP"], 1)]),
    ],
  },
  "image-format-convert@webp": {
    split: true,
    steps: [
      pick("画像を選ぶ", "画像をドラッグ&ドロップ"),
      step("変換先の形式を選ぶ", [file(IMG), seg("変換先の形式", ["JPG", "PNG", "WebP"], 2), preview("image")], 1),
      ...finish("変換する", "1件をWebPに変換する", [file(IMG), seg("変換先の形式", ["JPG", "PNG", "WebP"], 2)]),
    ],
  },
  "pdf-to-image": {
    steps: [
      pick("PDFを選ぶ", "PDFをドラッグ&ドロップ"),
      step("画像の形式を選ぶ", [file(PDF), btns(["PNG", "JPG"], 0)], 1),
      ...finish("画像にする", "画像化する", [file(PDF), btns(["PNG", "JPG"], 0)]),
    ],
  },
  "image-crop": {
    split: true,
    steps: [
      step("切り方を選ぶ", [btns(["SNSサイズ", "自由トリミング", "証明写真"], 1), drop("画像をドラッグ&ドロップ")], 0),
      pick("画像を選ぶ", "画像をドラッグ&ドロップ", [btns(["SNSサイズ", "自由トリミング", "証明写真"], 1)]),
      step("範囲を決める", [file(IMG), seg(undefined, ["自由", "1:1", "4:3", "3:4", "16:9", "9:16"], 1), preview("image", "枠をドラッグして範囲を決める")], 2),
      step("トリミングする", [file(IMG), seg(undefined, ["自由", "1:1", "4:3", "3:4", "16:9", "9:16"], 1), run("トリミングする"), preview("image")], 2),
    ],
  },
  "image-rotate-flip": {
    split: true,
    steps: [
      pick("画像を選ぶ", "画像をドラッグ&ドロップ", [btns(["回転", "反転"], 0)]),
      step("向きを選ぶ", [btns(["回転", "反転"], 0), file(IMG), btns(["90°", "180°", "270°"], 0), preview("image")], 2),
      ...finish("回転する", "回転する", [btns(["回転", "反転"], 0), file(IMG), btns(["90°", "180°", "270°"], 0)]),
    ],
  },
  "image-rotate-flip@flip": {
    split: true,
    steps: [
      pick("「反転」を選んで画像を選ぶ", "画像をドラッグ&ドロップ", [btns(["回転", "反転"], 1)]),
      step("反転の向きを選ぶ", [btns(["回転", "反転"], 1), file(IMG), btns(["左右反転", "上下反転"], 0), preview("image")], 2),
      ...finish("反転する", "反転する", [btns(["回転", "反転"], 1), file(IMG), btns(["左右反転", "上下反転"], 0)]),
    ],
  },
  "image-adjust": {
    steps: [
      pick("画像を選ぶ", "画像をドラッグ&ドロップ"),
      step("明るさなどを調整する", [file(IMG), check("グレースケール（白黒）にする", false), slider("明るさ", 0.62), slider("コントラスト", 0.5)], 2),
      ...finish("適用する", "適用する", [file(IMG), slider("明るさ", 0.62), slider("コントラスト", 0.5)]),
    ],
  },
  "image-metadata-remove": {
    steps: [pick("画像を選ぶ", "画像をドラッグ&ドロップ"), ...finish("削除する", "メタデータを削除する", [file(IMG), preview("image")])],
  },
  "image-watermark": {
    steps: [
      pick("画像を選ぶ", "画像をドラッグ&ドロップ"),
      step("文字と位置を決める", [file(IMG), input("透かしの文字", "CONFIDENTIAL"), seg("位置", ["左上", "右上", "中央", "左下", "右下"], 4), slider("不透明度", 0.5)], 1),
      ...finish("追加する", "透かしを追加する", [file(IMG), input("透かしの文字", "CONFIDENTIAL"), seg("位置", ["左上", "右上", "中央", "左下", "右下"], 4)]),
    ],
  },
  "image-layout": {
    steps: [
      pick("画像を選ぶ", "画像をドラッグ&ドロップ"),
      step("並べる", [file(IMG, true), btns(["比率維持（全体表示）", "枠いっぱいに配置"], 0), btn("文字を追加"), preview("image", "画像をドラッグして配置")], 3),
      step("出力の形式を選ぶ", [head("出力"), seg("出力", ["png", "jpeg", "pdf"], 0), seg("書き出しの解像度", ["自動", "2倍", "3倍", "4倍"], 0), run("書き出す")], 1),
      { title: "書き出す", parts: [head("出力"), seg("出力", ["png", "jpeg", "pdf"], 0), seg("書き出しの解像度", ["自動", "2倍", "3倍", "4倍"], 0), run("書き出す")], focus: 3 },
    ],
  },
  "image-merge": {
    split: true,
    steps: [
      pick("画像を2枚以上選ぶ", "画像をドラッグ&ドロップ（2枚以上）"),
      step("並べ方を選ぶ", [file(IMG, true), btns(["横結合", "縦結合", "グリッド"], 0), btns(["0px", "5px", "10px", "20px"], 2), preview("image")], 1),
      step("背景を選ぶ", [file(IMG, true), btns(["横結合", "縦結合", "グリッド"], 0), btns(["白", "黒", "透明"], 0), preview("image")], 2),
      { title: "結合して保存する", parts: [btns(["横結合", "縦結合", "グリッド"], 0), btns(["白", "黒", "透明"], 0), preview("image")], focus: "popup" },
    ],
  },
  "image-padding-text": {
    split: true,
    steps: [
      pick("画像を選ぶ", "画像をドラッグ&ドロップ"),
      step("余白を決める", [file(IMG, true), btns(["px", "mm"], 0), input2("上 px", "0", "下 px", "60"), btns(["白", "黒", "透明"], 0), preview("image")], 2),
      step("文字を入れる", [text(undefined, ["余白に表示する文字（複数行可）"]), slider("文字サイズ", 0.3), btns(["左揃え", "中央揃え", "右揃え"], 1), preview("image")], 0),
      { title: "保存する", parts: [btns(["PNG", "JPEG"], 0), run("この画像だけ保存"), run("1件を一括出力"), preview("image")], focus: 2 },
    ],
  },
  "image-tile-split": {
    split: true,
    steps: [
      pick("画像を選ぶ", "画像をドラッグ&ドロップ"),
      step("分け方を選ぶ", [file(IMG), btns(["2×2", "3×3", "4×4"], 1), input2("行", "3", "列", "3"), preview("image")], 1),
      ...finish("分割する", "9枚に分割する", [file(IMG), btns(["2×2", "3×3", "4×4"], 1), btns(["PNG", "JPEG"], 0)], "ZIPをダウンロード"),
    ],
  },
  "image-mosaic": {
    split: true,
    steps: [
      pick("画像を選ぶ", "画像をドラッグ&ドロップ"),
      step("範囲を追加する", [file(IMG), run("＋ 範囲を追加"), preview("image", "枠を動かして範囲を合わせる")], 1),
      step("保存する", [file(IMG), run("＋ 範囲を追加"), run("PNGで保存"), run("JPEGで保存"), preview("image")], 2),
    ],
  },
  "background-remover": {
    steps: [
      pick("画像を選ぶ", "画像をドラッグ&ドロップ"),
      step("消す色を選ぶ", [file(IMG), input("消す色", "#5d81bc"), btn("四隅の色から自動で選ぶ"), slider("許容する色の差", 0.2)], 2),
      ...finish("透明にする", "背景を透明にする", [file(IMG), seg("プレビューの背景", ["市松", "白", "黒", "緑"], 0), preview("image")]),
    ],
  },

  // ------------------------------------------------------------------ PDF
  // PDF編集：結合（まとめ先の最初のモード）。ほかのモードは「pdf-edit@モード」
  "pdf-edit": {
    split: true,
    steps: [
      step("やることを選ぶ", [btns(PDF_MODES, 0), drop("PDFをドラッグ&ドロップ（複数可）")], 0),
      pick("PDFを選ぶ", "PDFをドラッグ&ドロップ（複数可）", [btns(PDF_MODES, 0)]),
      step("順番を確かめる", [file(PDF, true), file("document2.pdf"), btn("↑"), preview("pdf", "結合のプレビュー（上から順に結合）")], 1),
      ...finish("結合する", "2件のPDFを結合する", [file(PDF, true), file("document2.pdf")]).slice(0, 1),
    ],
  },
  "pdf-edit@split": {
    split: true,
    steps: [
      pick("「分割」を選んでPDFを選ぶ", "PDFをドラッグ&ドロップ", [btns(PDF_MODES, 1)]),
      step("分け方を選ぶ", [file(PDF), seg(undefined, ["1ページごとに分割", "ページ範囲を指定"], 1), input("ページ範囲（カンマ区切りで複数指定可）", "1-3,5,8-10"), preview("pdf")], 1),
      ...finish("分割する", "分割する", [file(PDF), seg(undefined, ["1ページごとに分割", "ページ範囲を指定"], 1), input("ページ範囲（カンマ区切りで複数指定可）", "1-3,5,8-10")], "ZIPでダウンロード"),
    ],
  },
  "pdf-edit@delete": {
    split: true,
    steps: [
      pick("「ページ削除」を選んでPDFを選ぶ", "PDFをドラッグ&ドロップ", [btns(PDF_MODES, 2)]),
      step("削除するページを選ぶ", [file(PDF), btns(["1", "2", "3"], 1), preview("pdf")], 1),
      ...finish("削除する", "1ページを削除する", [file(PDF), btns(["1", "2", "3"], 1)]),
    ],
  },
  "pdf-edit@extract": {
    split: true,
    steps: [
      pick("「ページ抽出」を選んでPDFを選ぶ", "PDFをドラッグ&ドロップ", [btns(PDF_MODES, 3)]),
      step("抽出するページを入れる", [file(PDF), input("抽出するページ（全3ページ）", "1,3"), preview("pdf")], 1),
      ...finish("抽出する", "ページを抽出する", [file(PDF), input("抽出するページ（全3ページ）", "1,3")]),
    ],
  },
  "pdf-edit@reorder": {
    split: true,
    steps: [
      pick("「並び替え」を選んでPDFを選ぶ", "PDFをドラッグ&ドロップ", [btns(PDF_MODES, 4)]),
      step("順番を入れ替える", [file(PDF), btns(["↑", "↓"], 0), preview("pdf", "1番目・2番目・3番目")], 1),
      ...finish("並び替える", "並び替えを適用する", [file(PDF), btns(["↑", "↓"], 0)]),
    ],
  },
  "pdf-edit@rotate": {
    split: true,
    steps: [
      pick("「回転」を選んでPDFを選ぶ", "PDFをドラッグ&ドロップ", [btns(PDF_MODES, 5)]),
      step("回転の角度を選ぶ", [file(PDF), btns(["90°", "180°", "270°"], 0), preview("pdf")], 1),
      ...finish("回転する", "回転する", [file(PDF), btns(["90°", "180°", "270°"], 0)]),
    ],
  },
  "pdf-fix": {
    split: true,
    steps: [
      step("PDFを選ぶ", [head("PDFをアップロード", 1), drop("PDFをドラッグ&ドロップ")], 1),
      step("やりたい操作を選ぶ", [head("記入・注釈を配置", 2), btns(["Aa 文字", "✓ チェック", "□ 図形", "✎ 手書き", "▣ 画像", "㊞ 印影"], 0), preview("pdf", "PDFの上をクリックして置く")], 1),
      step("PDFの上に置く", [head("記入・注釈を配置", 2), slider("文字サイズ", 0.3), seg("色", ["黒", "赤", "青"], 0), preview("pdf", "置いたあとドラッグで動かせます")], 3),
      { title: "書き出す", parts: [head("PDFを書き出してダウンロード", 3), run("PDFを書き出す"), preview("pdf")], focus: 1 },
    ],
  },
  "pdf-compress": {
    split: true,
    steps: [
      pick("PDFを選ぶ", "PDFをドラッグ&ドロップ"),
      step("目標のサイズを入れる", [file(PDF), input("何MB以下にしますか", "2"), seg("よく使うサイズ", ["1MB", "2MB", "3MB", "5MB", "10MB"], 1), preview("pdf")], 1),
      ...finish("圧縮する", "圧縮する", [file(PDF), input("何MB以下にしますか", "2"), seg("よく使うサイズ", ["1MB", "2MB", "3MB", "5MB", "10MB"], 1)]),
    ],
  },
  "image-to-pdf": {
    split: true,
    steps: [
      pick("画像を選ぶ", "画像をドラッグ&ドロップ（複数可）"),
      step("ページの大きさを選ぶ", [file(IMG, true), btns(["画像サイズのまま", "A4に収める"], 0), preview("pdf")], 1),
      ...finish("PDFにする", "1件の画像をPDF化する", [file(IMG, true), btns(["画像サイズのまま", "A4に収める"], 0)]),
    ],
  },
  "pdf-to-text": {
    steps: [
      pick("PDFを選ぶ", "PDFまたは画像をドラッグ&ドロップ"),
      step("OCRの言語を選ぶ", [file(PDF), seg("OCRの言語（画像のページを読み取るとき）", ["日本語＋英語", "日本語のみ", "英語のみ"], 0)], 1),
      ...finish("抽出する", "テキストを抽出する", [file(PDF)], "テキストをダウンロード"),
    ],
  },
  "pdf-to-excel": {
    steps: [
      pick("PDFを選ぶ", "PDFをドラッグ&ドロップ"),
      step("表と設定を確かめる", [file(PDF), table(4, 3), check("複数行に割れた見出しを1行にまとめる"), check("ページごとに別のシートに分ける")], 1),
      ...finish("変換する", "Excelに変換する", [file(PDF), table(4, 2)], "Excelファイルをダウンロード"),
    ],
  },
  "pdf-to-word": {
    steps: [pick("PDFを選ぶ", "PDFをドラッグ&ドロップ"), ...finish("変換する", "Wordに変換する", [file(PDF), preview("pdf")], "Word文書をダウンロード")],
  },
  "word-to-pdf": {
    steps: [pick("Wordを選ぶ", "Word文書(.docx)をドラッグ&ドロップ"), ...finish("変換する", "PDFに変換する", [file(DOCX)], "PDFをダウンロード")],
  },
  "excel-to-pdf": {
    steps: [
      pick("Excelを選ぶ", "Excelファイル(.xlsx)をドラッグ&ドロップ"),
      step("向き・幅を選ぶ", [file(XLSX), btns(["自動（Excelの設定）", "縦", "横"], 0), btns(["自動（Excelの設定）", "横幅に合わせる"], 0), table(4, 2)], 1),
      ...finish("変換する", "PDFに変換する", [file(XLSX), btns(["自動（Excelの設定）", "縦", "横"], 0)], "PDFをダウンロード"),
    ],
  },
  "pdf-password-protect": {
    steps: [
      pick("PDFを選ぶ", "PDFをドラッグ&ドロップ"),
      step("パスワードを入れる", [file(PDF), input("開くためのパスワード", "••••••••"), input("パスワード(確認用)", "••••••••"), check("印刷")], 1),
      ...finish("設定する", "パスワードを設定する", [file(PDF), input("開くためのパスワード", "••••••••")]),
    ],
  },
  "pdf-resize-pages": {
    split: true,
    steps: [
      pick("PDFを選ぶ", "PDFをドラッグ&ドロップ"),
      step("サイズと向きを選ぶ", [file(PDF), seg("変更後のサイズ", ["A4", "A3", "Letter"], 0), seg("向き", ["縦向き", "横向き"], 0), preview("pdf")], 1),
      ...finish("変更する", "変更する", [file(PDF), seg("変更後のサイズ", ["A4", "A3", "Letter"], 0), seg("向き", ["縦向き", "横向き"], 0)]),
    ],
  },
  "pdf-metadata-remove": {
    steps: [pick("PDFを選ぶ", "PDFをドラッグ&ドロップ"), ...finish("削除する", "メタデータを削除する", [file(PDF), preview("pdf")])],
  },
  "pdf-crop-pages": {
    steps: [
      pick("PDFを選ぶ", "PDFをドラッグ&ドロップ"),
      step("余白を決める", [file(PDF), btns(["0mm", "10mm", "15mm", "20mm"], 1), input2("上の余白 (mm)", "10", "下の余白 (mm)", "10"), input2("左の余白 (mm)", "10", "右の余白 (mm)", "10")], 1),
      ...finish("調整する", "余白を調整する", [file(PDF), btns(["0mm", "10mm", "15mm", "20mm"], 1)]),
    ],
  },
  "form-to-individual-pdfs": {
    split: true,
    steps: [
      step("帳票のPDFを選ぶ", [head("帳票テンプレートPDFをアップロード", 1), drop("帳票のPDFをドラッグ&ドロップ")], 1),
      step("入れる場所を置く", [head("フィールドを配置", 2), btn("+ フィールドを追加"), preview("pdf", "帳票の上をドラッグして枠を置く")], 1),
      step("回答データを読み込む", [head("回答データ（CSV・Excel）をアップロード", 3), drop("CSV・Excelファイルをドラッグ&ドロップ")], 1),
      step("全員分をまとめて作る", [head("全員分を一括生成", 7), run("一括生成してZIPを作成する"), btn("ZIPをダウンロード")], 1),
    ],
  },
  "filled-pdf-to-excel": {
    steps: [
      pick("PDFを選ぶ", "PDFをドラッグ&ドロップ", [btn("自動抽出 PDFの内容を自動解析してExcel化")]),
      ...finish("変換する", "Excelに変換する", [file(PDF), preview("sheet")], "Excelファイルをダウンロード"),
    ],
  },

  // ------------------------------------------------------------------ Excel・CSV
  "csv-format": {
    steps: [
      step("CSVを貼り付ける", [text("CSVの内容を貼り付け", ["name, age,  city", "Alice ,30, Tokyo", "", "Bob, 25 ,Osaka"]), check("各セルの前後の空白を除去"), check("空行を削除")], 0),
      step("整形する", [text("CSVの内容を貼り付け", ["name, age,  city", "Alice ,30, Tokyo"]), check("各セルの前後の空白を除去"), check("空行を削除"), run("整形する")], 3),
      step("保存する", [run("整形する"), text(undefined, ["name,age,city", "Alice,30,Tokyo", "Bob,25,Osaka"]), btn("CSVとしてダウンロード")], 2),
    ],
  },
  "excel-csv-convert": {
    steps: [
      step("変換の向きを選ぶ", [btns(["Excel → CSV", "CSV → Excel"], 0), drop("Excelファイル（.xlsx）をドラッグ&ドロップ")], 0),
      pick("ファイルを選ぶ", "Excelファイル（.xlsx）をドラッグ&ドロップ", [btns(["Excel → CSV", "CSV → Excel"], 0)]),
      ...finish("変換する", "CSVに変換する", [btns(["Excel → CSV", "CSV → Excel"], 0), file(XLSX), table(4, 2)]),
    ],
  },
  "excel-csv-convert@csv-to-excel": {
    steps: [
      pick("「CSV → Excel」を選んでCSVを選ぶ", "CSVファイルをドラッグ&ドロップ", [btns(["Excel → CSV", "CSV → Excel"], 1)]),
      step("文字コードを選ぶ", [btns(["Excel → CSV", "CSV → Excel"], 1), file(CSV), select("文字コード", "自動判定"), table(4, 2)], 2),
      ...finish("変換する", "Excelに変換する", [btns(["Excel → CSV", "CSV → Excel"], 1), file(CSV), select("文字コード", "自動判定")]),
    ],
  },
  "excel-merge": {
    steps: [
      step("結合するものを選ぶ", [btns(["Excelファイルを結合", "CSVファイルを結合"], 0), drop("Excel（.xlsx）・CSVをドラッグ&ドロップ（2〜20件）")], 0),
      pick("ファイルを2つ以上選ぶ", "Excel（.xlsx）・CSVをドラッグ&ドロップ（2〜20件）", [btns(["Excelファイルを結合", "CSVファイルを結合"], 0)]),
      ...finish("結合する", "2件を結合する", [file(XLSX, true), file("data2.xlsx"), table(4, 2)]),
    ],
  },
  "csv-dedupe": {
    steps: [
      pick("CSVを選ぶ", "CSVファイルをドラッグ&ドロップ"),
      ...finish("重複を削除する", "重複を削除する", [file(CSV), select("文字コード", "自動判定"), table(4, 3)], "CSVでダウンロード"),
    ],
  },
  "csv-json-convert": {
    steps: [
      step("変換の向きを選ぶ", [btns(["CSV → JSON", "JSON → CSV"], 0), drop("CSVをドラッグ&ドロップ")], 0),
      pick("ファイルを選ぶ", "CSVをドラッグ&ドロップ", [btns(["CSV → JSON", "JSON → CSV"], 0)]),
      ...finish("変換する", "JSONに変換する", [btns(["CSV → JSON", "JSON → CSV"], 0), file(CSV), table(4, 2)]),
    ],
  },
  "csv-json-convert@json-to-csv": {
    steps: [
      step("「JSON → CSV」を選んでJSONを貼り付ける", [btns(["CSV → JSON", "JSON → CSV"], 1), text("入力 (JSON配列)", ['[{"name": "Alice", "age": 30},', ' {"name": "Bob", "age": 25}]'])], 1),
      step("CSVに変換する", [text("入力 (JSON配列)", ['[{"name": "Alice", "age": 30},', ' {"name": "Bob", "age": 25}]']), table(2, 2), run("CSVに変換する")], 2),
      step("コピー・保存する", [text("変換結果（2行 × 2列）", ["name,age", "Alice,30", "Bob,25"]), btn("コピー"), btn(".csvをダウンロード")], 2),
    ],
  },
  "csv-replace": {
    steps: [
      pick("CSVを選ぶ", "CSVファイルをドラッグ&ドロップ"),
      step("置き換える文字を入れる", [file(CSV), input("検索する文字列", "株式会社"), input("置換後の文字列", "㈱"), table(4, 2)], 1),
      ...finish("置換する", "置換を実行する", [file(CSV), input("検索する文字列", "株式会社"), input("置換後の文字列", "㈱")], "CSVでダウンロード"),
    ],
  },
  "csv-column-editor": {
    steps: [
      pick("ファイルを選ぶ", "CSV・Excel（.xlsx）ファイルをドラッグ&ドロップ"),
      step("残す列・順番を決める", [file(XLSX), seg("編集するもの", ["行を編集", "列を編集"], 1), check("nameを含める"), check("priceを含める", false), table(4, 2)], 2),
      ...finish("保存する", "この内容で保存する", [file(XLSX), seg("編集するもの", ["行を編集", "列を編集"], 1), adv("読み込みの設定", "1行目を見出し・全行")]),
    ],
  },
  "excel-transpose": {
    steps: [pick("Excelを選ぶ", "Excelファイル（.xlsx）をドラッグ&ドロップ"), ...finish("入れ替える", "行と列を入れ替える", [file(XLSX), table(4, 3)], "Excelファイルをダウンロード")],
  },
  "excel-blank-remove": {
    steps: [
      pick("Excelを選ぶ", "Excelファイル（.xlsx）をドラッグ&ドロップ"),
      step("消す空白を選ぶ", [file(XLSX), seg("空白の行・列を削除する", ["空白行のみ", "空白列のみ", "両方"], 2), table(4, 3)], 1),
      ...finish("削除する", "空白を削除する", [file(XLSX), seg("空白の行・列を削除する", ["空白行のみ", "空白列のみ", "両方"], 2)], "Excelファイルをダウンロード"),
    ],
  },
  "excel-extract": {
    split: true,
    steps: [
      pick("Excelを選ぶ", "Excelファイル（.xlsx）をドラッグ&ドロップ"),
      step("抽出の方法と文字を入れる", [file(XLSX), btns(["行を抽出", "列を抽出"], 0), input("検索する文字", "東京"), check("1行目（見出し）も残す"), preview("sheet")], 2),
      ...finish("抽出する", "行を抽出する", [file(XLSX), input("検索する文字", "東京"), preview("sheet", "抽出結果のプレビュー")], "Excelファイルをダウンロード"),
    ],
  },
  "excel-replace": {
    steps: [
      pick("Excelを選ぶ", "Excelファイル（.xlsx）をドラッグ&ドロップ"),
      step("置き換える文字を入れる", [file(XLSX), btns(["置換", "削除"], 0), input("検索する文字列", "株式会社"), input("置換後の文字列", "㈱"), seg("対象範囲", ["シート全体", "指定列", "指定範囲"], 0)], 2),
      ...finish("置換する", "置換を実行する", [file(XLSX), input("検索する文字列", "株式会社"), input("置換後の文字列", "㈱")], "Excelファイルをダウンロード"),
    ],
  },
  "excel-date-shift": {
    steps: [
      pick("Excelを選ぶ", "Excelファイル（.xlsx）をドラッグ&ドロップ"),
      step("変え方を選ぶ", [file(XLSX), seg(undefined, ["年を変更", "月を変更", "日を変更", "日数を加算", "日数を減算"], 3), input("加算する日数", "30"), table(4, 2)], 1),
      ...finish("変更する", "一括変更する", [file(XLSX), seg(undefined, ["年を変更", "月を変更", "日を変更", "日数を加算", "日数を減算"], 3), input("加算する日数", "30")], "Excelファイルをダウンロード"),
    ],
  },
  "receipt-accounting-csv": {
    steps: [
      step("初期値を決める", [head("初期値を決める", 1), input("借方勘定科目", "消耗品費"), input("貸方勘定科目", "現金"), select("課税区分の初期値", "課対仕入10%")], 1),
      step("領収書を読み込む", [head("領収書・レシートを読み込む", 2), drop("領収書・レシートの画像・PDFをドラッグ&ドロップ")], 1),
      step("明細を確かめる", [head("明細を確認・訂正する", 3), table(5, 3)], 1),
      step("CSVを保存する", [head("仕訳プレビュー（freee会計の取引インポート）", 4), select("CSVの文字コード", "UTF-8（BOM付き）"), run("freee用CSVをダウンロード"), run("Excelをダウンロード")], 2),
    ],
  },

  // ------------------------------------------------------------------ Word・PowerPoint
  "word-paragraph-cleanup": {
    steps: [
      pick("Wordを選ぶ", "Wordファイル（.docx）をドラッグ&ドロップ"),
      step("整理することを選ぶ", [file(DOCX), chips("整理すること（いくつでも選べます）", ["全角スペースを半角に変換", "連続するスペースを1つにまとめる", "連続する空白行を1行にまとめる", "空白行をすべて削除する"], [1, 2]), check("段組みを変更する（1段・2段・3段）", false)], 1),
      step("整理する", [file(DOCX), chips(undefined, ["連続するスペースを1つにまとめる", "連続する空白行を1行にまとめる"], [0, 1]), run("整理を実行する")], 2),
      step("保存する", [file(DOCX), run("整理を実行する"), btn("Wordファイルをダウンロード")], 2),
    ],
  },
  "excel-label": {
    split: true,
    steps: [
      step("用紙を選ぶ", [seg("出力するファイルの形式", ["Word（おすすめ）", "Excel"], 0), select("よくあるラベル用紙から選ぶ", "（選択して寸法を入力）"), input2("列数", "2", "行数", "6"), preview("label")], 1),
      step("内容を入れる", [seg("ラベルに入れる内容", ["全ラベル同じ内容", "ラベルごとに違う内容"], 1), drop("Excel・CSVのファイルをドラッグ&ドロップ"), seg("敬称", ["なし", "様", "御中"], 1), preview("label")], 1),
      step("文字を整える", [slider("文字の大きさ", 0.3), seg("書体", ["ゴシック体", "明朝体", "メイリオ"], 0), seg("横の位置", ["左", "中央", "右"], 1), preview("label")], 1),
      { title: "作成する", parts: [seg("書体", ["ゴシック体", "明朝体", "メイリオ"], 0), check("ラベルの枠線を印刷する（シールに直接印刷するときは外します）", false), run("Wordを作成"), preview("label")], focus: 2 },
    ],
  },
  "pptx-invert": {
    steps: [pick("PowerPointを選ぶ", "PowerPointファイル（.pptx）をドラッグ&ドロップ"), ...finish("反転する", "白黒を反転する", [file("slides.pptx")], "PowerPointファイルをダウンロード")],
  },

  // ------------------------------------------------------------------ 動画・音声
  "video-convert": videoEdit("出力形式", ["MP4", "MOV", "WebM", "MKV"], 0, "変換する"),
  "video-compress": videoEdit("画質・圧縮", ["元のまま", "高画質（弱め）", "標準", "高圧縮（強め）"], 2, "圧縮する"),
  "video-resize": videoEdit("解像度", ["元の解像度", "1080p", "720p", "480p"], 2, "解像度を変更する"),
  "video-frame-rate": videoEdit("フレームレート", ["元のフレームレート", "60fps", "30fps", "24fps"], 2, "フレームレートを変更する"),
  "video-h264": {
    steps: [
      pick("動画を選ぶ", "動画ファイルをドラッグ&ドロップ"),
      step("画質を選ぶ", [file(MP4), seg("再エンコードの画質", ["高画質", "標準", "サイズ優先"], 1), preview("video")], 1),
      ...finish("変換する", "H.264に変換する", [file(MP4), preview("video")]),
    ],
  },
  "video-thumbnail": {
    steps: [
      pick("動画を選ぶ", "動画ファイルをドラッグ&ドロップ"),
      step("再生して一時停止する", [file(MP4), head("再生して、抽出したい位置で一時停止する", 1), preview("video")], 2),
      ...finish("抽出する", "一時停止した位置を抽出する", [file(MP4), seg("画像形式", ["PNG", "JPEG"], 0)], "画像をダウンロード"),
    ],
  },
  // 動画カット・結合：不要部分を削除（最初のモード）。結合は「video-cut-merge@merge」
  "excel-space-remove": {
    steps: [
      pick("Excelファイルを選ぶ", "Excelファイル（.xlsx）をドラッグ&ドロップ"),
      step("消す空白を選ぶ", [file("名簿.xlsx"), head("消す空白の種類", 1), check("半角スペース"), check("全角スペース"), head("消す場所", 2), check("先頭の空白"), check("末尾の空白")], 1),
      ...finish("保存する", "空白を整えて保存する", [file("名簿.xlsx"), head("消す場所", 2)], "Excelファイルをダウンロード"),
    ],
  },
  "postal-search": {
    steps: [
      { title: "調べる向きを選ぶ", parts: [seg(undefined, ["郵便番号から住所", "住所から郵便番号"], 0)], focus: 0 },
      { title: "郵便番号か住所を入れる", parts: [seg(undefined, ["郵便番号から住所", "住所から郵便番号"], 0), input("郵便番号", "100-0001"), btn("住所を調べる")], focus: 1 },
      { title: "結果をコピーする", parts: [input("〒100-0001", "東京都千代田区千代田"), btn("コピー")], focus: 1 },
    ],
  },
  "postal-search@address": {
    steps: [
      { title: "「住所から郵便番号」を選ぶ", parts: [seg(undefined, ["郵便番号から住所", "住所から郵便番号"], 1)], focus: 0 },
      { title: "住所の一部を入れる", parts: [seg(undefined, ["郵便番号から住所", "住所から郵便番号"], 1), input("住所", "千代田区丸の内"), btn("郵便番号を調べる")], focus: 1 },
      { title: "郵便番号をコピーする", parts: [input("東京都千代田区丸の内", "〒100-0005"), btn("コピー")], focus: 1 },
    ],
  },
  "video-cut-merge": {
    steps: [
      pick("「不要部分を削除」を選んで動画を選ぶ", "動画をドラッグ&ドロップ", [seg(undefined, ["不要部分を削除", "複数の動画を結合"], 0)]),
      step("タイムラインで不要な範囲を削除する", [file(MP4), preview("video", "赤い行をドラッグして範囲を選ぶ"), btn("選んだ範囲を削除"), btn("▶ つないだ結果を再生")], 2),
      ...finish("書き出す", "不要部分を削除して書き出す", [file(MP4), preview("video"), btn("選んだ範囲を削除")]),
    ],
  },
  "video-cut-merge@merge": {
    steps: [
      pick("「複数の動画を結合」を選んで動画を選ぶ", "動画をドラッグ&ドロップ（複数可）", [seg(undefined, ["不要部分を削除", "複数の動画を結合"], 1)]),
      step("順番と残す範囲を決める", [file(MP4, true), file("movie2.mp4"), btn("⋮⋮ ドラッグで並べ替え"), preview("video", "バーの端をドラッグして切り取る")], 2),
      ...finish("結合する", "動画を結合する", [file(MP4, true), file("movie2.mp4")]),
    ],
  },
  "video-metadata-remove": {
    steps: [pick("動画を選ぶ", "動画ファイルをドラッグ&ドロップ"), ...finish("削除する", "メタデータを削除する", [file(MP4), preview("video")])],
  },
  "video-subtitle": {
    steps: [
      pick("動画を選ぶ", "動画ファイルをドラッグ&ドロップ"),
      step("字幕を追加して時間を決める", [file(MP4), preview("video", "タイムラインのバーをドラッグ"), head("字幕（1件）"), run("＋ 字幕を追加")], 3),
      step("字幕ごとの見た目を決める", [head("1番目の見た目"), seg("フォント", ["ゴシック", "太ゴシック", "明朝", "丸ゴシック"], 0), slider("文字の大きさ", 0.3), slider("横の位置（X）", 0.5), slider("縦の位置（Y）", 0.88)], 1),
      ...finish("書き出す", "字幕つきの動画を書き出す", [head("書き出し"), seg(undefined, ["映像に焼き付ける", "字幕トラック"], 0)]).slice(0, 1),
    ],
  },
  "video-mosaic": {
    steps: [
      pick("動画を選ぶ", "動画ファイルをドラッグ&ドロップ"),
      step("隠す所を囲む", [file(MP4), preview("video", "止めた画面で、隠したい所をドラッグ")], 1),
      step("かけ方を選ぶ", [preview("video"), seg(undefined, ["モザイク", "ぼかし", "黒塗り"], 0)], 1),
    ],
  },
  "audio-convert": {
    steps: [
      pick("音声を選ぶ", "音声ファイルをドラッグ&ドロップ"),
      step("形式と音質を選ぶ", [file(MP3), seg(undefined, ["MP3", "WAV", "OGG（Opus）"], 0), seg(undefined, ["320kbps", "256kbps", "192kbps", "128kbps"], 2), preview("audio")], 1),
      ...finish("変換する", "変換する", [file(MP3), seg(undefined, ["MP3", "WAV", "OGG（Opus）"], 0)]),
    ],
  },
  "audio-extract": {
    steps: [
      pick("動画を選ぶ", "動画ファイルをドラッグ&ドロップ"),
      step("保存する形式を選ぶ", [file(MP4), preview("video"), seg(undefined, AUDIO_FORMATS, 0)], 2),
      ...finish("取り出す", "音声を取り出す", [file(MP4), seg(undefined, AUDIO_FORMATS, 0)]),
    ],
  },
  "audio-trim": {
    steps: [
      pick("音声を選ぶ", "音声ファイルをドラッグ&ドロップ"),
      step("開始と終了を決める", [file(MP3), preview("audio"), input2("開始位置", "0:05.0", "終了位置", "0:30.0"), seg("保存する形式", AUDIO_FORMATS, 0)], 2),
      ...finish("切り出す", "切り出す", [file(MP3), input2("開始位置", "0:05.0", "終了位置", "0:30.0")]),
    ],
  },
  "audio-merge": {
    steps: [
      pick("音声を2つ以上選ぶ", "音声ファイルをドラッグ&ドロップ（複数選択できます）"),
      step("順番を確かめる", [file(MP3, true), file("voice2.mp3"), btn("↑")], 1),
      ...finish("結合する", "結合する", [file(MP3, true), file("voice2.mp3")]),
    ],
  },
  "audio-volume": {
    steps: [
      pick("音声を選ぶ", "音声ファイルをドラッグ&ドロップ"),
      step("音量を決める", [file(MP3), seg(undefined, ["音量を上げ下げする", "ノーマライズ（最大音量を揃える）"], 0), slider("音量の変更量（dB）", 0.62, "+3dB"), preview("audio")], 2),
      ...finish("調整する", "音量を調整する", [file(MP3), slider("音量の変更量（dB）", 0.62, "+3dB")]),
    ],
  },
  "audio-compress": {
    steps: [
      pick("音声を選ぶ", "音声ファイルをドラッグ&ドロップ"),
      step("形式と音質を選ぶ", [file(MP3), seg(undefined, ["元と同じ形式", "MP3", "OGG（Opus）"], 1), seg(undefined, ["192kbps", "128kbps", "96kbps", "64kbps"], 1), check("モノラルにする", false)], 2),
      ...finish("圧縮する", "圧縮する", [file(MP3), seg(undefined, ["192kbps", "128kbps", "96kbps", "64kbps"], 1)]),
    ],
  },

  // ------------------------------------------------------------------ ファイル
  "file-bulk-rename": {
    steps: [
      pick("ファイルを選ぶ", "ファイルをドラッグ&ドロップ（複数可）"),
      step("新しい名前を入れる", [file(IMG, true), input("共通の名前", "例: 写真"), btn("全ファイルへ適用"), input("photo.jpg", "旅行_01")], 3),
      ...finish("リネームする", "1件をリネームする", [file(IMG, true), input("photo.jpg", "旅行_01")]),
    ],
  },
  "file-sequential-rename": {
    steps: [
      pick("ファイルを選ぶ", "ファイルをドラッグ&ドロップ（複数可）"),
      step("名前の付け方を決める", [file(IMG, true), input2("接頭辞", "file", "開始番号", "1"), input2("桁数", "3", "接尾辞（任意）", "")], 1),
      ...finish("リネームする", "1件を連番リネームする", [file(IMG, true), input2("接頭辞", "file", "開始番号", "1")]),
    ],
  },
  "file-zip": {
    steps: [pick("ファイルを選ぶ", "ファイルをドラッグ&ドロップ（複数可）"), ...finish("ZIPにする", "1件をZIP化する", [file(DOCX, true)], "ZIPでダウンロード")],
  },
  "file-unzip": {
    steps: [pick("ZIPを選ぶ", "ZIPファイルをドラッグ&ドロップ"), ...finish("解凍する", "解凍する", [file("archive.zip")], "まとめてZIPでダウンロード")],
  },
  "file-hash": {
    steps: [
      pick("ファイルを選ぶ", "ファイルをドラッグ&ドロップ"),
      step("ハッシュ値をコピーする", [file(PDF), text("SHA-256", ["3a7bd3e2360a3d29eea436fcfb7e44c7…"]), btn("ハッシュ値をコピー")], 2),
    ],
  },

  // ------------------------------------------------------------------ 生成ツール
  "business-card-qr": {
    split: true,
    steps: [
      step("名刺の内容を入れる", [input("氏名", "山田 太郎"), input("会社名", "株式会社サンプル"), input("電話番号", "03-1234-5678"), input("メールアドレス", "taro@example.com"), preview("qr")], 0),
      step("生成する", [input("氏名", "山田 太郎"), input("メールアドレス", "taro@example.com"), run("名刺二次元コードを生成する"), preview("qr")], 2),
      step("保存する", [run("名刺二次元コードを生成する"), btn("画像としてダウンロード"), preview("qr")], 1),
    ],
  },
  // 総合改修 10：統合した「見積書・注文書・請求書作成」。書類ごとの図は guideModes で切り替える
  "document-suite": documentGuide("有効期限（任意）", "見積書を作成する"),
  "estimate-generator": documentGuide("有効期限（任意）", "見積書を作成する"),
  "invoice-generator": documentGuide("支払期限（任意）", "請求書を作成する"),
  "order-generator": documentGuide("納期（任意）", "注文書を作成する"),
  "quote-order-generator": {
    split: true,
    steps: [
      step("共通の情報を入れる", [head("基本情報（見積書・注文書に共通）", 1), input("書類タイトル", "見積書"), input("注文書に入れる納期（任意）", "受注後"), preview("invoice")], 1),
      step("宛先・明細を入れる", [head("宛先（お客様）", 2), input("会社名・屋号", "株式会社サンプル"), head("明細", 4), input2("明細1 品名", "作業費", "明細1 単価", "50,000"), preview("invoice")], 3),
      step("税・金額を選ぶ", [head("税・金額", 5), seg("消費税率", ["10%", "8%", "0%"], 0), seg("端数処理", ["切り捨て", "四捨五入", "切り上げ"], 0), preview("invoice")], 1),
      { title: "2つまとめて作る", parts: [head("PDF出力", 6), run("見積書・注文書を作成する"), preview("invoice", "プレビュー（上が見積書・下が注文書）")], focus: 1 },
    ],
  },
  postcard: {
    split: true,
    steps: [
      step("宛名面に宛先を入れる（郵便番号で住所が入る）", [seg("作る面", ["宛名面", "文字・画像の面"], 0), head("宛先", 2), input("郵便番号（7けた）", "100-0001"), text("住所", ["東京都千代田区千代田1-1"]), input("氏名", "山田 太郎"), preview("postcard")], 2),
      step("文字を置く", [seg("作る面", ["宛名面", "文字・画像の面"], 1), btn("＋ 文字を追加"), text("文字（改行できます）", ["あけまして", "おめでとうございます"]), slider("横の位置（X）", 0.5, "50%"), preview("postcard")], 1),
      step("画像を置く", [btn("＋ 画像を追加"), slider("画像の大きさ（はがきの幅に対する割合）", 0.3, "60%"), slider("縦の位置（Y）", 0.3, "30%"), preview("postcard")], 0),
      { title: "PDFにして印刷する", parts: [head("PDFにして印刷する", 3), run("PDFを作成する"), preview("postcard")], focus: 1 },
    ],
  },
  "envelope-address": {
    split: true,
    steps: [
      step("封筒を選ぶ", [head("封筒を選ぶ", 2), seg("封筒サイズ", ["長形3号（120×235mm）", "長形4号（90×205mm）", "角形2号（240×332mm）"], 0), seg("封筒の向き", ["縦向き", "横向き"], 0), preview("envelope")], 1),
      step("宛先を入れる", [head("宛先を入れる", 3), text("宛先1", ["〒100-0001", "東京都千代田区千代田1-1", "山田 太郎"]), seg("敬称（宛先の最後の行）", ["様", "御中", "なし"], 0), preview("envelope")], 1),
      step("レイアウトを整える", [head("レイアウトを整える", 4), seg("書字方向", ["縦書き", "横書き"], 0), slider("宛先の文字サイズ", 0.4), preview("envelope")], 1),
      { title: "PDFを作る", parts: [head("レイアウトを整える", 4), slider("宛先の文字サイズ", 0.4), run("PDFを作成"), preview("envelope")], focus: 2 },
    ],
  },
  "ticket-voucher": {
    split: true,
    steps: [
      step("券の内容を入れる", [select("用紙サイズ", "A4"), input("タイトル", "整理券"), input("金額", "1,000円"), input2("開始番号", "1", "終了番号", "10"), preview("ticket")], 1),
      step("大きさ・表示を決める", [input2("1枚の幅 (mm)", "90", "1枚の高さ (mm)", "50"), check("切り取り線を表示する"), check("連番を表示する"), preview("ticket")], 0),
      { title: "PDFを作る", parts: [check("切り取り線を表示する"), check("連番を表示する"), run("PDFを作成"), preview("ticket")], focus: 2 },
    ],
  },
  "roster-template": {
    split: true,
    steps: [
      pick("名簿のファイルを選ぶ", "CSV/Excelファイルをドラッグ&ドロップ", [btns(["CSV/Excelから作る", "スキャンしたPDFの枠を再現する"], 0)]),
      step("入れる列を選ぶ", [file(XLSX), check("name"), input("見出しラベル", "氏名"), input2("見出しの高さ (mm)", "10", "1行の高さ (mm)", "8"), preview("sheet")], 1),
      step("作成する", [file(XLSX), check("name"), run("Excelを作成"), run("PDFを作成"), preview("sheet")], 2),
    ],
  },
  "seating-chart": {
    steps: [
      step("用途を選ぶ", [head("用途を選ぶ", 1), btns(["会議（対面）", "会議（コの字）", "グループワーク", "授業", "懇親会（円卓）", "カスタム"], 2)], 1),
      step("名前を入れる", [head("名前を入れる"), text(undefined, ["山田 太郎", "佐藤 花子", "鈴木 一郎"]), preview("seats")], 1),
      step("席を入れ替える", [preview("seats", "2人を選んで「入れ替え」・ドラッグで動かす")], 0),
    ],
  },
  "shift-schedule": {
    steps: [
      step("年月を決める", [head("年月と確認の目安", 1), input("年", "2026"), select("月", "11月"), adv("確認の目安（任意）", "連続勤務 6日・勤務間 11時間")], 2),
      step("スタッフを入れる", [head("スタッフ", 3), input("1人目の名前", "山田"), input("2人目の名前", "佐藤"), btn("＋ 1人追加（2/60）")], 1),
      step("表に勤務を入れる", [head("勤務表（2026年11月）", 4), btns(["早 早番", "遅 遅番", "日 日勤", "休 休み"], 0), preview("shift", "勤務区分を選んで、マスを押す")], 1),
      step("書き出す", [btn("Excelでダウンロード"), btn("PDFでダウンロード"), btn("CSVでダウンロード")], 0),
    ],
  },
  "electronic-stamp-generator": {
    split: true,
    steps: [
      step("作り方を選んで文字を入れる", [btns(["文字から作る", "印鑑を取り込む", "固有ID付きで作る"], 0), head("文字", 1), input("文字", "山田"), preview("stamp")], 0),
      step("形・色・大きさを決める", [head("形・色・大きさ", 2), btns(["丸印", "角印"], 0), seg("色", ["朱色", "黒", "青"], 0), slider("印影サイズ", 0.4, "300px"), preview("stamp")], 2),
      step("出力形式を選んで生成する", [head("出力形式", 5), seg(undefined, ["PNG", "JPEG", "WebP"], 0), run("印影画像を生成する"), preview("stamp")], 1),
    ],
  },
  "qr-generator": {
    split: true,
    steps: [
      step("内容を入れる", [text("URLやテキストを入力", ["https://example.com"]), slider("サイズ", 0.4, "320"), preview("qr")], 0),
      step("見た目を決める", [seg("誤り訂正レベル", ["L 7%", "M 15%", "Q 25%", "H 30%"], 3), seg("マークの種類", ["Mr.Sattoのアイコン", "自分の画像", "マークなし"], 0), preview("qr")], 1),
      step("生成して保存する", [run("二次元コードを生成する"), btn("画像としてダウンロード"), preview("qr")], 0),
    ],
  },
  "password-generator": {
    split: true,
    steps: [
      step("文字数と文字の種類を決める", [slider("文字数", 0.3, "16"), btns(["英字のみ", "数字のみ", "英数字のみ", "すべて"], 3), check("記号 (!@#$ など)"), preview("text")], 0),
      step("生成してコピーする", [run("パスワードを生成する"), text(undefined, ["k7#Qm2!vXp9Lr4@w"]), run("コピー")], 2),
    ],
  },
  "gradient-generator": {
    steps: [
      step("色を選ぶ", [btns(["夕焼け", "海", "森", "ラベンダー", "レインボー"], 0), seg("種類", ["線形(直線)", "円形(放射)", "円錐(角度)"], 0), preview("gradient")], 0),
      step("角度・色を調整する", [slider("角度", 0.25, "90"), input("色1", "#6366f1"), input("色2", "#ec4899"), preview("gradient")], 0),
      step("コードをコピー・画像を保存する", [run("コードをコピー"), seg("画像のサイズ", ["1920×1080", "3840×2160", "1080×1080"], 0), btn("PNG画像として保存")], 0),
    ],
  },
  "fiscal-calendar": {
    split: true,
    steps: [
      step("年度と形式を選ぶ", [select("年度", "2026年度（令和8年度）"), seg("週の始まり", ["月曜日始まり", "日曜日始まり"], 0), seg("カレンダー形式", ["1か月 / 1シート", "2か月 / 1シート"], 0), preview("calendar")], 0),
      step("色を選ぶ", [btns(["ビジネス（ネイビー）", "ナチュラル（ベージュ・グリーン）", "シンプル（白黒）"], 0), seg("用紙（A4）の向き", ["横向き", "縦向き"], 0), preview("calendar")], 0),
      step("作成する", [run("Excelを作成（月別12シート）"), run("PDFを作成（月別12ページ）"), preview("calendar")], 0),
    ],
  },
  "sequence-generator": {
    split: true,
    steps: [
      step("項目と番号を入れる", [btns(["単一項目", "複数項目"], 0), input("項目名", "会議"), input2("開始番号", "1", "終了番号", "10"), preview("text")], 1),
      step("書き方を選ぶ", [input("1行の書き方（テンプレート）", "第{n}回　{item}"), btns(["{item}{n}", "第{n}回 {item}", "{n}回目 {item}"], 1), btns(["全角（１２３）", "半角（123）"], 0), preview("text")], 1),
      step("コピーする", [text(undefined, ["第１回　会議", "第２回　会議", "第３回　会議"]), run("すべてコピー")], 1),
    ],
  },

  // ------------------------------------------------------------------ テキスト・その他
  "pomodoro-timer": {
    steps: [
      step("モードを選ぶ", [seg(undefined, ["集中 (25分)", "小休憩 (5分)", "長休憩 (15分)"], 0), run("スタート"), btn("リセット")], 0),
      step("スタートする", [seg(undefined, ["集中 (25分)", "小休憩 (5分)", "長休憩 (15分)"], 0), run("スタート"), btn("リセット")], 1),
      step("時間を変える", [input("集中の時間（分）", "25"), input("小休憩の時間（分）", "5"), input("長休憩の時間（分）", "15")], 0),
    ],
  },
  "unit-converter": {
    steps: [
      step("単位の種類を選ぶ", [seg("単位の種類", ["長さ", "重さ", "温度", "面積", "体積", "速度"], 0), input("数値", "1")], 0),
      step("数値と単位を入れる", [input("数値", "1"), select("変換元の単位", "メートル（m）"), btn("⇄"), select("変換先の単位", "フィート（ft）")], 0),
      step("結果を見る", [head("すべての単位への換算（基準: メートル(m)）"), table(2, 4), btn("式をコピー")], 1),
    ],
  },
  "gaiji-checker": {
    steps: [
      step("文字を貼り付ける", [head("調べる文字を入れる"), text(undefined, ["山田 太郎", "髙橋 花子", "佐藤 次郎（㈱サンプル）"]), check("Shift_JIS（Windows系）で保存・取り込みする場合の問題も調べる", true)], 1),
      step("調べる", [text(undefined, ["山田 太郎", "髙橋 花子"]), run("貼り付けた文字を調べる"), btn("入力を消す")], 1),
    ],
  },
  "office-compare": {
    steps: [
      step("調べ方を選ぶ", [head("調べ方を選ぶ"), btns(["ファイルの差分を調べる", "文書間の不一致を調べる"], 0)], 1),
      step("2つのファイルを選ぶ", [head("比べる2つのファイルを選ぶ"), drop("ファイルAをドラッグ&ドロップ"), drop("ファイルBをドラッグ&ドロップ")], 1),
      step("比べる", [check("数式も比べる"), check("行の追加・削除を見つける"), run("比べる")], 2),
    ],
  },
  "char-count": {
    steps: [
      step("文章を貼り付ける", [text(undefined, ["ここに文章を入力または貼り付けてください"])], 0),
      step("数を見る", [text(undefined, ["Mr.Sattoで文字数を数えます。"]), btns(["文字数", "文字数（空白除く）", "単語数", "行数"], -1)], 1),
    ],
  },
  "json-formatter": {
    steps: [
      step("JSONを貼り付ける", [text("入力 (JSON)", ['{"name": "example", "value": 1}']), seg("インデント", ["2スペース", "4スペース"], 0)], 0),
      step("整形する", [seg("インデント", ["2スペース", "4スペース"], 0), run("整形する"), btn("圧縮(minify)する"), text("出力", ["{", '  "name": "example",', '  "value": 1', "}"])], 1),
    ],
  },
  "text-line-cleaner": {
    split: true,
    steps: [
      step("テキストを貼り付ける", [text("入力テキスト", ["りんご", "", "  みかん ", "りんご"]), preview("text")], 0),
      step("整理の仕方を選ぶ", [check("空行を削除する"), check("重複した行を削除する"), seg(undefined, ["並び替えない", "昇順ソート", "降順ソート"], 0), preview("text")], 1),
      step("整理する", [run("整理する"), text("整理後のプレビュー", ["りんご", "みかん"]), btn(".txtをダウンロード")], 0),
    ],
  },
  "text-case-converter": {
    split: true,
    steps: [
      step("テキストを貼り付ける", [text("入力テキスト", ["Hello World 123"]), preview("text")], 0),
      step("変換の仕方を選ぶ", [btns(["英字は変換しない", "すべて大文字", "すべて小文字"], 1), btns(["数字は変換しない", "数字を半角にする", "数字を全角にする"], 0), preview("text")], 0),
      step("コピーする", [text("変換結果", ["HELLO WORLD 123"]), btn("コピー"), btn(".txtをダウンロード")], 1),
    ],
  },
  "date-weekday-tool": {
    steps: [
      step("調べ方を選ぶ", [seg(undefined, ["曜日確認", "日付計算", "日付一覧", "曜日抽出", "営業日計算"], 0), input("日付", "2026-11-11")], 0),
      step("計算する", [seg(undefined, ["曜日確認", "日付計算", "日付一覧", "曜日抽出", "営業日計算"], 0), input("日付", "2026-11-11"), run("計算する")], 2),
    ],
  },
  "time-calculator": {
    steps: [
      step("計算の種類を選ぶ", [seg(undefined, ["時間差", "時刻に加算", "時刻から減算", "複数時間の合計", "実働時間（休憩差引）"], 0), input2("開始時刻", "09:00", "終了時刻", "17:30")], 0),
      step("計算する", [input2("開始時刻", "09:00", "終了時刻", "17:30"), run("計算する")], 1),
    ],
  },
  "number-format": {
    split: true,
    steps: [
      step("数字を貼り付ける", [text("入力（1行に1件、複数行可）", ["1234567", "0001234567"]), preview("text")], 0),
      step("変換の仕方を選ぶ", [btns(["郵便番号", "カスタム区切り", "カンマを追加", "カンマを削除", "数字のみ抽出"], 0), preview("text")], 0),
      step("コピーする", [text("変換結果", ["123-4567", "000-1234567"]), btn("コピー"), btn(".txtをダウンロード")], 1),
    ],
  },
};

/** 1つの画面で操作（モード）を切り替えるツールの、モードごとの図（ツールの画面のボタンと同じ並び） */
export type GuideModeOption = { mode: string; label: string; guideId: string };
export const guideModes: Record<string, GuideModeOption[]> = {
  "pdf-edit": [
    { mode: "merge", label: "結合", guideId: "pdf-edit" },
    { mode: "split", label: "分割", guideId: "pdf-edit@split" },
    { mode: "delete", label: "ページ削除", guideId: "pdf-edit@delete" },
    { mode: "extract", label: "ページ抽出", guideId: "pdf-edit@extract" },
    { mode: "reorder", label: "並び替え", guideId: "pdf-edit@reorder" },
    { mode: "rotate", label: "回転", guideId: "pdf-edit@rotate" },
  ],
  "image-rotate-flip": [
    { mode: "rotate", label: "回転", guideId: "image-rotate-flip" },
    { mode: "flip", label: "反転", guideId: "image-rotate-flip@flip" },
  ],
  "excel-csv-convert": [
    { mode: "excel-to-csv", label: "Excel → CSV", guideId: "excel-csv-convert" },
    { mode: "csv-to-excel", label: "CSV → Excel", guideId: "excel-csv-convert@csv-to-excel" },
  ],
  "postal-search": [
    { mode: "zip-to-address", label: "郵便番号から住所", guideId: "postal-search" },
    { mode: "address-to-zip", label: "住所から郵便番号", guideId: "postal-search@address" },
  ],
  "document-suite": [
    { mode: "estimate", label: "見積書", guideId: "estimate-generator" },
    { mode: "quote-order", label: "見積書・注文書の一体作成", guideId: "quote-order-generator" },
    { mode: "invoice", label: "請求書", guideId: "invoice-generator" },
    { mode: "order", label: "注文書", guideId: "order-generator" },
  ],
  "video-cut-merge": [
    { mode: "cut", label: "不要部分を削除", guideId: "video-cut-merge" },
    { mode: "merge", label: "複数の動画を結合", guideId: "video-cut-merge@merge" },
  ],
  "csv-json-convert": [
    { mode: "csv-to-json", label: "CSV → JSON", guideId: "csv-json-convert" },
    { mode: "json-to-csv", label: "JSON → CSV", guideId: "csv-json-convert@json-to-csv" },
  ],
};

/**
 * 統合済みの旧アドレスで最初に出す図（そのアドレスで開くモード・形式の図）。
 * ここにないアドレスは、そのツール（統合済みならまとめ先）の図を出す。
 * src/components/tools/tool-registry.tsx の、旧アドレスごとの initialMode・initialFormat と合わせること。
 */
export const pageGuides: Record<string, string> = {
  "pdf-merge": "pdf-edit",
  "pdf-split": "pdf-edit@split",
  "pdf-delete-pages": "pdf-edit@delete",
  "pdf-extract-pages": "pdf-edit@extract",
  "pdf-reorder-pages": "pdf-edit@reorder",
  "pdf-rotate": "pdf-edit@rotate",
  "image-rotate": "image-rotate-flip",
  "image-flip": "image-rotate-flip@flip",
  "image-jpg-convert": "image-format-convert",
  "image-batch-convert": "image-format-convert",
  "image-png-convert": "image-format-convert@png",
  "image-webp-convert": "image-format-convert@webp",
  "csv-to-excel": "excel-csv-convert@csv-to-excel",
  "excel-to-csv": "excel-csv-convert",
  "csv-to-json": "csv-json-convert",
  "json-to-csv": "csv-json-convert@json-to-csv",
  // 帳票（document-suite）：旧4ツールのアドレスは、その書類を選んだ状態で開くため、その書類の図を出す
  "estimate-generator": "estimate-generator",
  "quote-order-generator": "quote-order-generator",
  "invoice-generator": "invoice-generator",
  "order-generator": "order-generator",
};

/** そのページで最初に出す図のID（hubId は、統合済みならまとめ先のID、そうでなければ自分のID） */
export function initialGuideId(pageToolId: string, hubId: string): string {
  return pageGuides[pageToolId] ?? hubId;
}

/** ツールの画面で選ばれているモードの図のID（モードの図がなければ null） */
export function guideIdForMode(hubId: string, mode: string): string | null {
  return guideModes[hubId]?.find((m) => m.mode === mode)?.guideId ?? null;
}

/**
 * 部品だけでは伝わりにくいステップの説明文（ツールID → ステップ番号（1から）→ 説明文）。
 * ほかのステップは、いま操作する部品から自動で作る（src/lib/guides/describe.ts）。
 */
const descriptions: Record<string, Record<number, string>> = {
  "image-compress": { 1: "「サイズを変更」「容量を圧縮」から、やりたいことを1つ選びます。もう一方を押すと選択が切り替わります。" },
  "image-crop": { 3: "比率を選び、プレビューの枠をドラッグして、切り抜く範囲を決めます。" },
  "image-layout": { 2: "画像はドラッグで好きな位置に動かせます。「文字を追加」で文字も入れられます。" },
  "image-padding-text": { 3: "余白に表示する文字を入れ、文字の大きさと揃え方を選びます。" },
  "image-mosaic": { 2: "「＋ 範囲を追加」を押して、プレビューの枠を隠したい所に合わせます。" },
  "pdf-edit": { 3: "上から順に結合されます。「↑」などで順番を入れ替えられます。" },
  "pdf-edit@split": { 1: "上の「分割」を選び、分けたいPDFを選びます。" },
  "pdf-edit@delete": { 1: "上の「ページ削除」を選び、PDFを選びます。", 2: "プレビューで、削除するページを押して選びます。もう一度押すと選択が外れます。" },
  "pdf-edit@extract": { 1: "上の「ページ抽出」を選び、PDFを選びます。", 2: "取り出すページを「1,3,5-7」のように入れます。入れた順番で出力されます。" },
  "pdf-edit@reorder": { 1: "上の「並び替え」を選び、PDFを選びます。", 2: "「↑」「↓」で、ページの順番を入れ替えます。" },
  "pdf-edit@rotate": { 1: "上の「回転」を選び、PDFを選びます。" },
  "image-rotate-flip@flip": { 1: "上の「反転」を選び、画像を選びます。" },
  "excel-csv-convert@csv-to-excel": { 1: "上の「CSV → Excel」を選び、CSVファイルを選びます。" },
  "csv-json-convert@json-to-csv": { 1: "上の「JSON → CSV」を選び、JSONの配列を貼り付けます。", 3: "変換結果を「コピー」するか、「.csvをダウンロード」で保存します。" },
  "pdf-fix": { 3: "PDFの上を押すと、そこに置かれます。置いたあとはドラッグで動かせます。" },
  "pdf-to-excel": { 2: "読み取った表を確かめ、見出しのまとめ方やシートの分け方を選びます。" },
  "receipt-accounting-csv": { 3: "読み取った明細を表で確かめ、違うところは直します。" },
  "video-mosaic": { 2: "動画を止めて、隠したい所をプレビューの上でドラッグして囲みます。" },
  "audio-merge": { 2: "上から順に結合されます。「↑」などで順番を入れ替えられます。" },
  "excel-extract": { 2: "「行を抽出」か「列を抽出」を選び、検索する文字を入れます。セルの中にその文字が含まれていれば一致し、残る行・列がプレビューに出ます。" },
  "video-cut-merge": { 1: "上の「不要部分を削除」を選び、動画を選びます。", 2: "タイムラインの赤い行をドラッグして不要な範囲を選び、「選んだ範囲を削除」を押します。残す区間（緑のバー）は端をドラッグして調整でき、「つないだ結果を再生」で確かめられます。" },
  "video-cut-merge@merge": { 1: "上の「複数の動画を結合」を選び、動画を2本以上選びます。", 2: "つまみ（⋮⋮）のドラッグで順番を変え、各動画のバーの端をドラッグして不要な最初・最後を切り取ります。「つないだ結果を再生」で確かめられます。" },
  postcard: { 2: "「＋ 文字を追加」で文字を入れ、大きさ・色・位置（X・Y）を調整します。", 3: "「＋ 画像を追加」で写真やイラストを置き、大きさと位置を調整します。縦横比はそのままです。" },
  "seating-chart": { 3: "2人を選んで入れ替えたり、ドラッグで席を動かしたりできます。" },
  "shift-schedule": { 3: "勤務区分（早番・遅番など）を選んでから、表のマスを押して入れます。" },
  "unit-converter": { 3: "ほかの単位に換算した結果が一覧で表示されます。" },
  "char-count": { 2: "入力すると、文字数・単語数・行数などがすぐに表示されます。" },
  "office-compare": { 3: "比べる内容にチェックを入れて「比べる」を押すと、違いが一覧で表示されます。" },
  "pomodoro-timer": { 2: "「スタート」を押すと、タイマーが動き始めます。途中で止めることもできます。" },
};
for (const [id, map] of Object.entries(descriptions)) {
  for (const [n, desc] of Object.entries(map)) {
    const target = toolGuides[id]?.steps[Number(n) - 1];
    if (target) target.desc = desc;
  }
}
