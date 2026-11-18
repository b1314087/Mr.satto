import type { Tool } from "./types";
import { categories } from "./categories";

/**
 * ツール一覧の表示順（カテゴリー内の並び順。2026-11-17）。
 *
 * - 各カテゴリーの中は、ツール名の読み（ひらがな）の50音順に並べる。
 * - 英字・数字から始まる名前（PDF・Word・Excel・CSV・ZIP・H.264 など）は、日本語での読み方（ぴーでぃーえふ・わーど…）で並べる。
 *   そのため「PDF○○」「Word○○」「Excel○○」のように頭が同じツールは、自然に1か所にまとまる。
 * - 名前の中の「→」「・」は、文字より前に来る区切りとして扱う（例：「Excel・CSV結合」「Excel・CSV変換」が Excel のツールの先頭にまとまる。
 *   「Word→画像変換」が「Word結合」などと同じ Word のまとまりに入る）。
 * - 50音の判定：カタカナはひらがなと同じに、濁音・半濁音は清音と同じに、小さい字（ゃ・ゅ・ょ・っ）は大きい字と同じに、
 *   長音「ー」は直前の字の母音として比べる。それでも同じときは、濁音などの違い → 表示名 → ID の順で決める（毎回同じ順になる）。
 *
 * 表示順だけを決める。ツールのデータ（src/lib/tools/data.ts の並び）は変えないため、
 * 検索結果の順（同じ点数のときの順を含む）・関連ツールの選び方などには影響しない。
 * 新しくツールを足したときは、TOOL_READINGS に読みを1行足す（足し忘れは tests/ui/tool-display-order.spec.ts で分かる）。
 * 読みがないツールは、表示名をそのまま読みとして使う（漢字の名前は、かなの名前より後ろになる）。
 */

/** ツールID → 表示名の読み（ひらがな。「→」「・」は名前のとおりに残す） */
export const TOOL_READINGS: Record<string, string> = {
  // 画像
  "image-compress": "がぞうりさいず・あっしゅく",
  "image-format-convert": "がぞうけいしきへんかん",
  "pdf-to-image": "ぴーでぃーえふ→がぞう",
  "image-crop": "がぞうとりみんぐ",
  "image-rotate-flip": "がぞうかいてん・はんてん",
  "image-adjust": "がぞうしきちょうほせい",
  "image-metadata-remove": "がぞうめたでーたさくじょ",
  "image-watermark": "がぞううぉーたーまーく",
  "image-layout": "がぞうほわいとぼーど",
  "image-merge": "がぞうけつごう",
  "image-padding": "がぞうよはく",
  "image-padding-text": "がぞうもじいれ",
  "image-tile-split": "がぞうたいるぶんかつ",
  "image-mosaic": "がぞうもざいく",
  "background-remover": "はいけいとうか",
  // PDF
  "pdf-edit": "ぴーでぃーえふへんしゅう",
  "pdf-fix": "ぴーでぃーえふしゅうせい",
  "pdf-compress": "ぴーでぃーえふあっしゅく",
  "image-to-pdf": "がぞう→ぴーでぃーえふ",
  "pdf-to-text": "ぴーでぃーえふ→てきすと",
  "word-to-pdf": "わーど→ぴーでぃーえふ",
  "excel-to-pdf": "えくせる→ぴーでぃーえふ",
  "pdf-password-protect": "ぴーでぃーえふぱすわーどほご",
  "pdf-resize-pages": "ぴーでぃーえふぺーじさいずへんこう",
  "pdf-metadata-remove": "ぴーでぃーえふめたでーたさくじょ",
  "pdf-crop-pages": "ぴーでぃーえふよはくちょうせい",
  "form-to-individual-pdfs": "ぴーでぃーえふさしこみいんさつ",
  // Excel・CSV
  "pdf-to-excel": "ぴーでぃーえふ→えくせる",
  "word-to-excel": "わーど→えくせる",
  "xls-to-xlsx": "えくせるきゅうけいしき→しんけいしき",
  "excel-format-reset": "えくせるしょしき・いんさつせっていりせっと",
  "excel-sheet-split-merge": "えくせるしーとぶんかつ・けつごう",
  "csv-format": "しーえすぶいせいけい",
  "excel-csv-convert": "えくせる・しーえすぶいへんかん",
  "excel-merge": "えくせる・しーえすぶいけつごう",
  "csv-dedupe": "ちょうふくさくじょ",
  "csv-json-convert": "しーえすぶい・じぇいそんへんかん",
  "csv-replace": "もじれつちかん",
  "csv-column-editor": "しーえすぶい・えくせるぎょうれつへんしゅう",
  "excel-transpose": "えくせるぎょうれついれかえ",
  "excel-blank-remove": "くうはくさくじょ",
  "excel-extract": "えくせるぎょう・れつちゅうしゅつ",
  "excel-space-remove": "えくせるすぺーすさくじょ",
  "excel-replace": "えくせるもじさくじょ・ちかん",
  "excel-date-shift": "えくせるひづけいっかつへんこう",
  "receipt-accounting-csv": "りょうしゅうしょ・れしーとからかいけいしーえすぶいさくせい",
  "filled-pdf-to-excel": "きにゅうずみぴーでぃーえふ→えくせる",
  // Word
  "pdf-to-word": "ぴーでぃーえふ→わーど",
  "excel-to-word": "えくせる→わーど",
  "doc-to-docx": "わーどきゅうけいしき→しんけいしき",
  "word-format-reset": "わーどしょしき・ぺーじせっていりせっと",
  "word-merge": "わーどけつごう",
  "word-to-image": "わーど→がぞうへんかん",
  "word-paragraph-cleanup": "わーどだんらくせいり・だんぐみ",
  "excel-label": "らべるさくせい",
  // PowerPoint
  "pptx-invert": "ぱわーぽいんとしろくろはんてん",
  "pptx-format-reset": "ぱわーぽいんとしょしき・すらいどさいずりせっと",
  // 動画
  "video-convert": "どうがけいしきへんかん",
  "video-compress": "どうがあっしゅく",
  "video-resize": "どうがかいぞうどへんこう",
  "video-frame-rate": "どうがふれーむれーとへんこう",
  "video-h264": "えいちにーろくよんへんかん",
  "video-thumbnail": "どうがさむねいるちゅうしゅつ",
  "video-cut-merge": "どうがかっと・けつごう",
  "video-metadata-remove": "どうがめたでーたさくじょ",
  "video-mosaic": "どうがもざいく",
  "video-subtitle": "どうがじまくついか",
  // 音声
  "audio-convert": "おんせいけいしきへんかん",
  "audio-extract": "どうがからおんせいをちゅうしゅつ",
  "audio-trim": "おんせいかっと",
  "audio-merge": "おんせいけつごう",
  "audio-volume": "おんりょうちょうせい・のーまらいず",
  "audio-compress": "おんせいあっしゅく",
  // ファイル
  "file-bulk-rename": "いっかつふぁいるめいへんこう",
  "file-sequential-rename": "れんばんりねーむ",
  "file-zip": "じっぷさくせい",
  "file-unzip": "じっぷかいとう",
  "file-hash": "ふぁいるはっしゅ",
  // 生成ツール
  "business-card-qr": "めいしにじげんこーどさくせい",
  "document-suite": "みつもりしょ・ちゅうもんしょ・せいきゅうしょさくせい",
  "envelope-address": "ふうとうあてなさくせい",
  "ticket-voucher": "せいりけん・きんけん・ひきかえけんさくせい",
  "roster-template": "めいぼてんぷれーとさくせい",
  postcard: "はがきさくせい",
  "seating-chart": "ざせきひょうさくせい",
  "shift-schedule": "しふとひょうさくせい",
  "gradient-generator": "ぐらでーしょんせいせい",
  "electronic-stamp-generator": "でんしいんかんせいせい",
  "qr-generator": "にじげんこーどせいせい",
  "password-generator": "ぱすわーどせいせい",
  "fiscal-calendar": "ねんどかれんだーさくせい",
  "sequence-generator": "れんばん・こうもくいっかつせいせい",
  "survey-sheet": "あんけーとようしさくせい",
  "text-to-speech": "てきすとよみあげ",
  "voice-recorder": "ろくおん",
  "screen-recorder": "がめんろくが",
  "audio-transcribe": "もじおこし",
  "video-whiteboard": "どうがほわいとぼーど",
  // その他
  "wareki-convert": "われき・せいれきいっかつへんかん",
  "pomodoro-timer": "ぽもどーろたいまー",
  "unit-converter": "たんいへんかん",
  "postal-search": "ゆうびんばんごう・じゅうしょけんさく",
  "gaiji-checker": "がいじ・とくしゅもじちぇっく",
  "office-compare": "えくせる・わーどひかく",
  "char-count": "もじすうかうんと",
  "json-formatter": "じぇいそんせいけい",
  "text-line-cleaner": "てきすとぎょうせいり",
  "text-case-converter": "おおもじ・こもじ・すうじのぜんかくはんかくへんかん",
  "date-weekday-tool": "ひづけ・ようびつーる",
  "time-calculator": "じかんけいさん",
  "number-format": "すうじ・ばんごうふぉーまっと",
};

// ---------------------------------------------------------------------------
// 50音の比べ方
// ---------------------------------------------------------------------------

const SMALL_TO_LARGE: Record<string, string> = {
  ぁ: "あ", ぃ: "い", ぅ: "う", ぇ: "え", ぉ: "お", っ: "つ", ゃ: "や", ゅ: "ゆ", ょ: "よ", ゎ: "わ", ゕ: "か", ゖ: "け",
};

const VOWEL_ROWS: [string, string][] = [
  ["あかさたなはまやらわがざだばぱぁゃゎ", "あ"],
  ["いきしちにひみりゐぎじぢびぴぃ", "い"],
  ["うくすつぬふむゆるぐずづぶぷぅっゅゔ", "う"],
  ["えけせてねへめれゑげぜでべぺぇ", "え"],
  ["おこそとのほもよろをごぞどぼぽぉょ", "お"],
];

function vowelOf(ch: string): string | null {
  for (const [row, v] of VOWEL_ROWS) if (row.includes(ch)) return v;
  return null;
}

/** カタカナ → ひらがな、全角・半角のゆれをそろえる */
function toHiragana(text: string): string {
  return text.normalize("NFKC").replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/** 濁音・半濁音を外す（が → か、ぱ → は） */
function removeVoicing(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[゙゚]/g, "")
    .normalize("NFC");
}

/** 区切り（→・）は、どの字よりも前に来る印にする */
const SEPARATOR = "\u0001";

/** 50音の比べ方の第1の基準（清音・大きい字・長音は母音に直したもの） */
export function primaryKey(reading: string): string {
  const h = removeVoicing(toHiragana(reading));
  let out = "";
  for (const ch of h) {
    if (ch === "→" || ch === "・" || ch === " " || ch === "　") {
      out += SEPARATOR;
      continue;
    }
    if (ch === "ー" || ch === "-" || ch === "～" || ch === "〜") {
      const prev = out[out.length - 1];
      out += (prev && vowelOf(prev)) ?? "";
      continue;
    }
    out += SMALL_TO_LARGE[ch] ?? ch;
  }
  return out;
}

/** 第2の基準（濁音・小さい字の違いは残したもの。同じ読みのときの順を決める） */
function secondaryKey(reading: string): string {
  return toHiragana(reading).replace(/[→・]/g, SEPARATOR);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function readingOf(tool: Pick<Tool, "id" | "name">): string {
  return TOOL_READINGS[tool.id] ?? tool.name;
}

/** 同じカテゴリーの中での表示順の比べ方 */
export function compareToolsByReading(a: Pick<Tool, "id" | "name">, b: Pick<Tool, "id" | "name">): number {
  const ra = readingOf(a);
  const rb = readingOf(b);
  return (
    compareStrings(primaryKey(ra), primaryKey(rb)) ||
    compareStrings(secondaryKey(ra), secondaryKey(rb)) ||
    compareStrings(a.name, b.name) ||
    compareStrings(a.id, b.id)
  );
}

const categoryIndex = new Map<string, number>(categories.map((c, i) => [c.id, i]));

/**
 * 一覧に表示する順に並べた、新しい配列を返す（元の配列は変えない）。
 * カテゴリーの順（src/lib/tools/categories.ts の並び）→ カテゴリーの中は50音順。
 */
export function sortToolsForDisplay<T extends Pick<Tool, "id" | "name" | "category">>(list: readonly T[]): T[] {
  return [...list].sort(
    (a, b) =>
      (categoryIndex.get(a.category) ?? Number.MAX_SAFE_INTEGER) - (categoryIndex.get(b.category) ?? Number.MAX_SAFE_INTEGER) ||
      compareToolsByReading(a, b),
  );
}
