import { test, expect } from "@playwright/test";
import { deskewGray, estimateSkewDegrees, invertDarkBlocks, normalizeIllumination, removeRuledLines } from "@/lib/ocr/remove-ruled-lines";
import { normalizeExtractedText } from "@/lib/pdf/pdfjs-client";
import { fixOcrThousandsSeparator, ocrWordsToPositionedTextItems, type OcrWord } from "@/lib/ocr/tesseract-client";
import { computeColumnBreaksAcrossPages, groupIntoLines, reconstructTable, tryParseDateCell } from "@/lib/pdf/table-reconstruction";

/** スキャンした表のOCRの前処理（罫線の除去・行と単語の整え方）と、日付セルの値のテスト */

function image(w: number, h: number, draw: (x: number, y: number) => boolean) {
  const gray = new Uint8Array(w * h).fill(255);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (draw(x, y)) gray[y * w + x] = 30;
  return { width: w, height: h, gray };
}

test.describe("罫線の除去", () => {
  // 600×400。外枠と、横線3本(y=100,200,300)・縦線2本(x=200,400)。罫線の太さは2px。
  // 文字のかわりに、短い縦棒(高さ12px・幅3px)を各マスに置く。
  const draw = (x: number, y: number) => {
    const onH = [100, 200, 300].some((ly) => y >= ly && y < ly + 2) && x >= 20 && x < 580;
    const onV = [200, 400].some((lx) => x >= lx && x < lx + 2) && y >= 20 && y < 380;
    const stroke = [60, 260, 460].some((sx) => x >= sx && x < sx + 3) && [140, 240].some((sy) => y >= sy && y < sy + 12);
    return onH || onV || stroke;
  };

  test("長い横線・縦線は消え、文字の短い線は残る", () => {
    const img = image(600, 400, draw);
    const { gray, removedPixels } = removeRuledLines(img);
    expect(removedPixels).toBeGreaterThan(1000);
    // 罫線の上(線の中ほど)は白になる
    expect(gray[100 * 600 + 300]).toBe(255);
    expect(gray[250 * 600 + 200]).toBe(255);
    // 文字のかわりの短い棒は残る
    expect(gray[145 * 600 + 61]).toBeLessThan(100);
    expect(gray[245 * 600 + 461]).toBeLessThan(100);
  });

  test("大きな太い文字(見出しなど)の長い縦棒・横棒は、罫線とは違って細くないので残す", () => {
    // 1000×700 に「H」形の大きな文字: 縦棒(幅16px・高さ160px)2本と、横棒(幅120px・高さ16px)
    const img = image(1000, 700, (x, y) => {
      const v = ((x >= 300 && x < 316) || (x >= 404 && x < 420)) && y >= 200 && y < 360;
      const hbar = x >= 300 && x < 420 && y >= 272 && y < 288;
      return v || hbar;
    });
    const { gray } = removeRuledLines(img);
    expect(gray[250 * 1000 + 308]).toBeLessThan(100);
    expect(gray[280 * 1000 + 360]).toBeLessThan(100);
  });

  test("罫線がない画像は何も消さない", () => {
    const img = image(600, 400, (x, y) => [60, 260, 460].some((sx) => x >= sx && x < sx + 3) && y >= 140 && y < 152);
    expect(removeRuledLines(img).removedPixels).toBe(0);
  });

  test("少し傾いた罫線(1.0度)も消える", () => {
    const slope = Math.tan((1.0 * Math.PI) / 180);
    const img = image(600, 400, (x, y) => x >= 20 && x < 580 && Math.abs(y - (200 + (x - 300) * slope)) < 1.2);
    const { gray, removedPixels } = removeRuledLines(img);
    expect(removedPixels).toBeGreaterThan(500);
    expect(gray[200 * 600 + 300]).toBe(255);
  });
});

test.describe("OCRの単語から文字の項目への変換", () => {
  const w = (text: string, x0: number, y0: number, x1: number, y1: number, lineIndex?: number): OcrWord => ({
    text,
    confidence: 90,
    x0,
    y0,
    x1,
    y1,
    lineIndex,
  });

  test("同じ行の単語は、上端や高さがばらついても同じ縦位置にそろう(1行が2行に割れない)", () => {
    const items = ocrWordsToPositionedTextItems([
      w("山田", 273, 221, 334, 251, 1),
      w("090-1234-5678", 916, 232, 1135, 259, 1), // 数字は上端が低い
      w("新宿", 1280, 217, 1347, 270, 1), // 背が高く検出された単語
    ]);
    expect(new Set(items.map((i) => i.y)).size).toBe(1);
    expect(new Set(items.map((i) => i.fontHeight)).size).toBe(1);
  });

  test("行が違えば縦位置も違う", () => {
    const items = ocrWordsToPositionedTextItems([w("山田", 273, 221, 334, 251, 1), w("佐藤", 271, 287, 335, 318, 2)]);
    expect(items[0].y).not.toBe(items[1].y);
  });

  test("OCRが細い隙間で分けた日本語の単語はつなぐ。離れた別の列はつながない", () => {
    const items = ocrWordsToPositionedTextItems([
      w("ヤマ", 443, 224, 539, 254, 1),
      w("ダ", 529, 217, 557, 270, 1), // 重なっている
      w("タ", 551, 225, 576, 253, 1),
      w("ロウ", 584, 226, 641, 254, 1),
      w("2012/04/15", 711, 228, 880, 261, 1),
    ]);
    expect(items.map((i) => i.str)).toEqual(["ヤマダタロウ", "2012/04/15"]);
  });

  test("「令和8」と「年」のように、数字と日本語の間の細い隙間もつなぐ。数字同士はつながない", () => {
    const joined = ocrWordsToPositionedTextItems([w("令和8", 100, 10, 200, 40, 1), w("年10月30日", 208, 10, 380, 40, 1)]);
    expect(joined.map((i) => i.str)).toEqual(["令和8年10月30日"]);
    const separate = ocrWordsToPositionedTextItems([w("120", 100, 10, 160, 40, 1), w("580", 168, 10, 228, 40, 1)]);
    expect(separate.map((i) => i.str)).toEqual(["120", "580"]);
  });

  test("行の情報がない単語は従来どおり単語ごとの位置を使う", () => {
    const items = ocrWordsToPositionedTextItems([w("A", 10, 20, 30, 40)]);
    expect(items[0].y).toBe(-20);
  });
});

test.describe("OCRの表の列の検出", () => {
  const w = (text: string, x0: number, x1: number, line: number): OcrWord => ({
    text,
    confidence: 90,
    x0,
    x1,
    y0: line * 66,
    y1: line * 66 + 30,
    lineIndex: line,
  });

  test("1語の枠が隣の列にはみ出していても、列は分かれたまま", () => {
    // 氏名(x300〜410)とフリガナ(x440〜)の2列。4行目の「郎」の枠だけがフリガナの列に食い込んでいる
    const words: OcrWord[] = [
      w("氏名", 310, 370, 1), w("フリガナ", 499, 624, 1),
      w("山田", 273, 334, 2), w("太郎", 345, 408, 2), w("ヤマダ", 443, 538, 2),
      w("佐藤", 271, 335, 3), w("花子", 344, 407, 3), w("サトウ", 484, 555, 3),
      w("鈴木", 270, 334, 4), w("一", 344, 406, 4), w("郎", 407, 449, 4), w("スズキ", 476, 535, 4),
      w("高橋", 270, 333, 5), w("美咲", 343, 406, 5), w("タカハシ", 468, 567, 5),
      w("伊藤", 268, 370, 6), w("健", 371, 413, 6), w("イトウ", 441, 533, 6),
    ];
    const lines = groupIntoLines(ocrWordsToPositionedTextItems(words));
    const breaks = computeColumnBreaksAcrossPages([lines], { noisyBoxes: true });
    const table = reconstructTable(ocrWordsToPositionedTextItems(words), breaks);
    expect(table.columnCount).toBe(2);
    expect(table.rows[0]).toEqual(["氏名", "フリガナ"]);
    expect(table.rows[3][1]).toBe("スズキ");
  });
});

test.describe("日付セルの値", () => {
  test("日付はUTCの0時で作る(日本のブラウザでExcelの日付が1日前にずれない)", () => {
    for (const text of ["2012/04/15", "2012-04-15", "2012年4月15日"]) {
      const d = tryParseDateCell(text);
      expect(d?.toISOString()).toBe("2012-04-15T00:00:00.000Z");
    }
    expect(tryParseDateCell("2012/02/30")).toBeNull();
  });
});

test.describe("PDFの文字の正規化", () => {
  test("康熙部首など見た目が同じ別の文字は、普通の漢字に直す。それ以外の文字は変えない", () => {
    expect(normalizeExtractedText("⽇⽉⾦⽅")).toBe("日月金方");
    expect(normalizeExtractedText("会議‧資料")).toBe("会議・資料");
    // CJK部首補助(NFKCでは直らないもの): 「西新宿」の「西」
    expect(normalizeExtractedText("\u2ec4新宿")).toBe("西新宿");
    expect(normalizeExtractedText("ＡＢＣ１２３ ｱｲｳ")).toBe("ＡＢＣ１２３ ｱｲｳ");
  });
});

test.describe("スキャンの影・傾きの補正", () => {
  /** 文字の行のかわりに、点線の横線(長さ6の短い棒を等間隔に並べたもの)を何本か置く。傾きは度 */
  const lines = (deg: number, w = 900, h = 700) => {
    const slope = Math.tan((deg * Math.PI) / 180);
    return image(w, h, (x, y) => {
      for (let row = 0; row < 12; row++) {
        const cy = 80 + row * 45 + (x - w / 2) * slope;
        if (Math.abs(y - cy) < 5 && x % 12 < 8 && x > 60 && x < w - 60) return true;
      }
      return false;
    });
  };

  test("右下がり・左下がりの傾きを、符号つきでおおよそ推定できる。傾きなしは0", () => {
    expect(estimateSkewDegrees(lines(1.5))).toBeGreaterThan(1.0);
    expect(estimateSkewDegrees(lines(1.5))).toBeLessThan(2.0);
    expect(estimateSkewDegrees(lines(-2))).toBeLessThan(-1.5);
    expect(estimateSkewDegrees(lines(0))).toBe(0);
  });

  test("傾きを直すと、行がそろって、もう一度推定すると傾きがほぼ無い", () => {
    const img = lines(2);
    const deg = estimateSkewDegrees(img);
    const fixed = deskewGray(img, deg);
    expect(Math.abs(estimateSkewDegrees({ width: img.width, height: img.height, gray: fixed }))).toBeLessThan(0.4);
  });

  test("片側が暗い影(右へ行くほど暗い)は、背景がそろって明るくなり、文字は暗いまま残る", () => {
    const w = 600;
    const h = 400;
    const gray = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) gray[y * w + x] = Math.round(240 - (x / w) * 110);
    // 文字のかわりの太い棒を、明るい側と暗い側に1つずつ
    for (let y = 100; y < 130; y++) {
      for (let x = 80; x < 90; x++) gray[y * w + x] = 20;
      for (let x = 500; x < 510; x++) gray[y * w + x] = 20;
    }
    const { gray: even, changed } = normalizeIllumination({ width: w, height: h, gray });
    expect(changed).toBe(true);
    expect(even[200 * w + 550]).toBeGreaterThan(220); // 暗かった背景が明るくなる
    expect(even[200 * w + 100]).toBeGreaterThan(220);
    expect(even[110 * w + 505]).toBeLessThan(80); // 暗い側の文字も暗いまま
    expect(even[110 * w + 85]).toBeLessThan(80);
  });

  test("ほぼ一様な白い背景は、そのまま(changed=false)", () => {
    const { changed } = normalizeIllumination(image(400, 300, () => false));
    expect(changed).toBe(false);
  });
});

test.describe("濃い帯の上の白抜き文字", () => {
  test("濃く塗った大きな帯の中だけを反転し、白抜きの文字が黒になる。帯の外の黒い文字は変えない", () => {
    const w = 400;
    const h = 200;
    const gray = new Uint8Array(w * h).fill(255);
    // 帯(x40〜359・y30〜69)を濃く塗り、白抜きの文字のかわりの短い棒(幅3・高さ16)を置く
    for (let y = 30; y < 70; y++) for (let x = 40; x < 360; x++) gray[y * w + x] = 60;
    for (const sx of [80, 160, 240]) for (let y = 42; y < 58; y++) for (let x = sx; x < sx + 3; x++) gray[y * w + x] = 255;
    // 帯の外の普通の文字(黒い短い棒)
    for (let y = 120; y < 136; y++) for (let x = 100; x < 103; x++) gray[y * w + x] = 20;
    const n = invertDarkBlocks({ width: w, height: h, gray }, gray);
    expect(n).toBe(1);
    expect(gray[50 * w + 81]).toBeLessThan(80); // 白抜きだった棒 → 黒
    expect(gray[35 * w + 200]).toBeGreaterThan(240); // 帯の塗り → 白に近い色
    expect(gray[125 * w + 101]).toBeLessThan(80); // 帯の外の文字はそのまま
    expect(gray[20 * w + 20]).toBe(255); // 何もない所はそのまま
  });

  test("小さな文字や細い線は、濃くても反転しない", () => {
    const w = 400;
    const h = 200;
    const gray = new Uint8Array(w * h).fill(255);
    for (let y = 100; y < 116; y++) for (let x = 100; x < 103; x++) gray[y * w + x] = 20; // 文字の一画
    for (let x = 20; x < 380; x++) for (let y = 150; y < 153; y++) gray[y * w + x] = 20; // 細い罫線
    expect(invertDarkBlocks({ width: w, height: h, gray }, gray)).toBe(0);
  });
});

test.describe("OCRの3桁区切りの読み違い", () => {
  test("「1.980」「1.234.567」「¥1.500」「1.000円」は、3桁区切りのカンマに直す", () => {
    expect(fixOcrThousandsSeparator("1.980")).toBe("1,980");
    expect(fixOcrThousandsSeparator("1.234.567")).toBe("1,234,567");
    expect(fixOcrThousandsSeparator("¥1.500")).toBe("¥1,500");
    expect(fixOcrThousandsSeparator("1.000円")).toBe("1,000円");
  });
  test("小数として確実なもの・数字でないものは直さない", () => {
    for (const t of ["0.500", "12.5", "1.98", "3.14159", "Ver.1.234", "2026.10.30", "12.345.6", "1,980"]) {
      expect(fixOcrThousandsSeparator(t)).toBe(t);
    }
  });
});
