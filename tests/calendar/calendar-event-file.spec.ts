import { test, expect } from "@playwright/test";
import { classifyEventFile, decodeCsvBytes, parseCsv } from "@/lib/calendar/event-file";
import { detectLayout, parseEventRows } from "@/lib/calendar/event-import";

test.describe("予定表ファイルの種類の判定", () => {
  const cases: [string, string, string][] = [
    ["予定表.xlsx", "", "excel"],
    ["予定表.XLSM", "", "excel"],
    ["予定表.xls", "application/vnd.ms-excel", "legacy-excel"],
    ["予定表.csv", "text/csv", "csv"],
    ["予定表.csv", "application/vnd.ms-excel", "csv"],
    ["行事.pdf", "application/pdf", "pdf"],
    ["行事.PDF", "", "pdf"],
    ["写真.png", "image/png", "image"],
    ["写真.JPG", "image/jpeg", "image"],
    ["写真.jpeg", "", "image"],
    ["写真", "image/jpeg", "image"],
    ["写真.heic", "image/heic", "unsupported"],
    ["写真.webp", "image/webp", "unsupported"],
    ["写真.gif", "image/gif", "unsupported"],
    ["メモ.txt", "text/plain", "unsupported"],
    ["資料.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "unsupported"],
    ["資料.pptx", "", "unsupported"],
    ["ファイル", "", "unsupported"],
  ];
  for (const [name, type, kind] of cases) {
    test(`${name} (${type || "MIMEなし"}) → ${kind}`, () => {
      expect(classifyEventFile({ name, type })).toBe(kind);
    });
  }
});

test.describe("CSVの読み取り", () => {
  test("カンマ区切り・引用符・引用符内のカンマ/改行/二重引用符・CRLF", () => {
    const rows = parseCsv('日付,予定,開始時刻\r\n2027/4/5,"入学式, 体育館",10:00\r\n2027/4/6,"""始業式""\n全員",\r\n');
    expect(rows).toEqual([
      ["日付", "予定", "開始時刻"],
      ["2027/4/5", "入学式, 体育館", "10:00"],
      ["2027/4/6", '"始業式"\n全員', ""],
    ]);
  });

  test("タブ区切りも読める。末尾に改行がなくてもよい", () => {
    expect(parseCsv("日付\t予定\n2027-04-05\t入学式")).toEqual([
      ["日付", "予定"],
      ["2027-04-05", "入学式"],
    ]);
  });

  test("UTF-8（BOMつき含む）とShift_JISの両方を読める", () => {
    const utf8 = new TextEncoder().encode("﻿日付,予定");
    expect(decodeCsvBytes(utf8.buffer.slice(utf8.byteOffset, utf8.byteOffset + utf8.byteLength) as ArrayBuffer)).toBe("日付,予定");
    // 「日付,予定」のShift_JIS
    const sjis = Uint8Array.from([0x93, 0xfa, 0x95, 0x74, 0x2c, 0x97, 0x5c, 0x92, 0xe8]);
    expect(decodeCsvBytes(sjis.buffer)).toBe("日付,予定");
  });

  test("Excelの「Unicodeテキスト」（BOMつきUTF-16・タブ区切り）も、文字化けせずに読める。UTF-16BEも同様", () => {
    const text = "日付\t予定\n2027/04/05\t入学式\n";
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    const decodedLe = decodeCsvBytes(le.buffer.slice(le.byteOffset, le.byteOffset + le.byteLength) as ArrayBuffer);
    expect(decodedLe).toBe(text);
    expect(parseCsv(decodedLe)).toEqual([["日付", "予定"], ["2027/04/05", "入学式"]]);
    const be = Buffer.from(Buffer.from(text, "utf16le")).swap16();
    const beWithBom = Buffer.concat([Buffer.from([0xfe, 0xff]), be]);
    expect(decodeCsvBytes(beWithBom.buffer.slice(beWithBom.byteOffset, beWithBom.byteOffset + beWithBom.byteLength) as ArrayBuffer)).toBe(text);
  });

  test("CSVの内容が、Excelと同じ取り込みで予定になる", () => {
    const rows = parseCsv("日付,予定,開始時刻,終了時刻\n2027/04/05,入学式,10:00,11:30\n2027/04/06,始業式,,\n四月十日,棚卸し,,\n");
    const layout = detectLayout(rows)!;
    const result = parseEventRows(rows, layout.mapping, layout.headerRow);
    expect(result.events.map((e) => [e.date, e.title, e.startTime, e.endTime])).toEqual([
      ["2027-04-05", "入学式", "10:00", "11:30"],
      ["2027-04-06", "始業式", null, null],
    ]);
    expect(result.issues.map((i) => i.kind)).toEqual(["bad-date"]);
  });
});
