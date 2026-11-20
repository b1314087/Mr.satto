import { test, expect } from "@playwright/test";
import {
  cleanOcrText,
  cleanOcrWord,
  cropScaleForOcr,
  darkenText,
  enhanceTextForOcr,
  estimateStrokeWidth,
  filterCharacterWords,
  prepareFieldGray,
} from "@/lib/ocr/ocr-enhance";

/** OCRの前処理（字を濃くする・細い字を太くする・枠の線を消す）と、図形・線の記号を取り除く後始末のテスト */

function image(w: number, h: number, bg: number, draw: (x: number, y: number) => number | null) {
  const gray = new Uint8Array(w * h).fill(bg);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = draw(x, y);
      if (v !== null) gray[y * w + x] = v;
    }
  return { width: w, height: h, gray };
}

test.describe("字を濃くする", () => {
  test("灰色の紙に薄い字：紙は白、字は濃くなる", () => {
    // 紙 200（灰色がかった紙）、字 150（薄い字）。字は紙面の一部だけ
    const img = image(300, 100, 200, (x, y) => (x % 20 < 2 && y > 30 && y < 70 ? 150 : null));
    const { gray, changed } = darkenText(img);
    expect(changed).toBe(true);
    expect(gray[10 * 300 + 5]).toBe(255); // 紙
    expect(gray[50 * 300 + 0]).toBeLessThan(40); // 字
  });

  test("中間の濃さ（かすれた部分）は、濃い側へ寄る", () => {
    // 灰色の紙（210）に、やや薄い字（90）と、かすれた部分（150）
    const img = image(300, 100, 210, (x, y) => (y > 30 && y < 70 ? (x < 20 ? 90 : x < 40 ? 150 : null) : null));
    const { gray } = darkenText(img);
    expect(gray[50 * 300 + 10]).toBe(0);
    expect(gray[50 * 300 + 30]).toBeLessThan(100);
  });

  test("もともと黒い字・白い紙のくっきりした画像は、そのまま（字のすき間を埋めない）", () => {
    const img = image(300, 100, 250, (x, y) => (y > 30 && y < 70 ? (x < 20 ? 10 : x < 22 ? 180 : null) : null));
    const { gray, changed } = darkenText(img);
    expect(changed).toBe(false);
    expect(gray[50 * 300 + 21]).toBe(180);
  });

  test("白紙（ほぼ一色）は、ノイズを濃くしないよう、そのまま", () => {
    const img = image(100, 100, 250, (x, y) => (x === 5 && y === 5 ? 235 : null));
    const { gray, changed } = darkenText(img);
    expect(changed).toBe(false);
    expect(gray[5 * 100 + 5]).toBe(235);
  });
});

test.describe("細い字を太くする", () => {
  test("線の太さ1pxの字は太くなり、3pxの字はそのまま", () => {
    const thin = image(200, 100, 255, (x, y) => (x % 10 === 0 && y > 20 && y < 80 ? 0 : null));
    expect(estimateStrokeWidth(thin)).toBe(1);
    const thinOut = enhanceTextForOcr(thin);
    expect(estimateStrokeWidth({ width: 200, height: 100, gray: thinOut.gray })).toBe(2);

    const bold = image(200, 100, 255, (x, y) => (x % 10 < 3 && y > 20 && y < 80 ? 0 : null));
    const boldOut = enhanceTextForOcr(bold);
    expect(estimateStrokeWidth({ width: 200, height: 100, gray: boldOut.gray })).toBe(3);
  });
});

test.describe("指定した場所（枠）の前処理", () => {
  test("枠の線は消え、中の字は残る", () => {
    // 300×80 の枠。外周の線（太さ2px）と、中の字のかわりの短い縦棒（高さ30px・幅3px）
    const img = image(300, 80, 255, (x, y) => {
      const border = x < 2 || x >= 298 || y < 2 || y >= 78;
      const stroke = [60, 120, 180].some((sx) => x >= sx && x < sx + 3) && y >= 25 && y < 55;
      return border || stroke ? 0 : null;
    });
    const gray = prepareFieldGray(img);
    expect(gray[0 * 300 + 150]).toBe(255); // 上の線
    expect(gray[40 * 300 + 0]).toBe(255); // 左の線
    expect(gray[40 * 300 + 61]).toBeLessThan(60); // 字
  });

  test("小さい枠は、字の高さが十分になるまで拡大する（最大4倍）", () => {
    expect(cropScaleForOcr(400, 48)).toBe(2);
    expect(cropScaleForOcr(400, 10)).toBe(4);
    expect(cropScaleForOcr(100, 200)).toBe(2);
    expect(cropScaleForOcr(800, 200)).toBe(1);
  });
});

test.describe("図形・線は読まず、文字・数字だけを残す", () => {
  test("罫線・枠・図形だけの読み取りは捨てる", () => {
    for (const s of ["|", "｜", "□", "○", "■", "──", "___", "----", "==", "・・・", "一一一"]) expect(cleanOcrWord(s), s).toBe("");
  });

  test("文字・数字に付いた線の記号は取り除き、文字の中の「-」「/」などは残す", () => {
    expect(cleanOcrWord("|田中")).toBe("田中");
    expect(cleanOcrWord("太郎｜")).toBe("太郎");
    expect(cleanOcrWord("□済")).toBe("済");
    expect(cleanOcrWord("03-1234-5678")).toBe("03-1234-5678");
    expect(cleanOcrWord("2026/11/20")).toBe("2026/11/20");
    expect(cleanOcrWord("¥1,980")).toBe("¥1,980");
    expect(cleanOcrWord("〒650-0001")).toBe("〒650-0001");
    expect(cleanOcrWord("ABC")).toBe("ABC");
  });

  test("単語の一覧：図形だけの単語は除き、ほかの情報（位置など）はそのまま", () => {
    const words = [
      { text: "|", x0: 0, confidence: 30 },
      { text: "氏名", x0: 10, confidence: 90 },
      { text: "□", x0: 20, confidence: 20 },
      { text: "|山田", x0: 30, confidence: 70 },
    ];
    expect(filterCharacterWords(words)).toEqual([
      { text: "氏名", x0: 10, confidence: 90 },
      { text: "山田", x0: 30, confidence: 70 },
    ]);
  });

  test("枠の中の文字：線だけの行は消し、記号を取り除く", () => {
    expect(cleanOcrText("|山田 太郎|\n────\n  - \n神戸市中央区1-2-3")).toBe("山田 太郎\n神戸市中央区1-2-3");
    expect(cleanOcrText("○ □ |")).toBe("");
  });
});
