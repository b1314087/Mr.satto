import { test, expect } from "@playwright/test";
import { scanSlidePictures } from "@/lib/pptx/slide-pictures";
import { buildPptx, encodePng, makeImage, picture, readParts } from "../helpers/pptx-builder";

/** スライドの上に貼られた画像の、位置・トリミングを調べる処理のテスト */

const img = () => makeImage(100, 80, (x, y) => (y >= 20 && y < 28 && x >= 20 && x < 70 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
const deck = (shapes: string) => buildPptx({ slides: [{ shapes, images: [{ name: "image1.png", bytes: encodePng(img()) }] }] });

test.describe("スライド上の画像の位置を調べる", () => {
  test("画像の位置・大きさ・トリミングを読み取る", () => {
    const { pictures, skipped } = scanSlidePictures(readParts(deck(picture(2, "rId2"))));
    expect(skipped).toBe(0);
    expect(pictures).toHaveLength(1);
    expect(pictures[0]).toMatchObject({ slidePath: "ppt/slides/slide1.xml", imagePath: "ppt/media/image1.png", offX: 914400, offY: 914400, cx: 1828800, cy: 1371600 });
    expect(pictures[0].cropL).toBeCloseTo(0.05);
    expect(pictures[0].cropT).toBeCloseTo(0.05);
    expect(pictures[0].cropR).toBe(0);
  });

  test("回転した画像・反転した画像・グループの中の画像は、位置が確実でないため対象外", () => {
    const rotated = picture(2, "rId2").replace("<a:xfrm>", '<a:xfrm rot="5400000">');
    const flipped = picture(2, "rId2").replace("<a:xfrm>", '<a:xfrm flipH="1">');
    const grouped = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="9" name="g"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${picture(2, "rId2")}</p:grpSp>`;
    for (const [name, shapes] of [["回転", rotated], ["反転", flipped], ["グループ", grouped]] as const) {
      const scan = scanSlidePictures(readParts(deck(shapes)));
      expect(scan.pictures, name).toHaveLength(0);
      expect(scan.skipped, name).toBe(1);
    }
    // グループの外の画像は、グループがあっても対象になる
    const mixed = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="9" name="g"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:grpSp>${picture(2, "rId2")}`;
    expect(scanSlidePictures(readParts(deck(mixed))).pictures).toHaveLength(1);
  });
});
