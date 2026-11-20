import {
  COVER_LETTER_KIND_META,
  activeRecipients,
  clampLayout,
  coverLetterTitle,
  formatJapaneseDate,
  itemLines,
  recipientLines,
  senderLines,
  validateCoverLetter,
  type CoverLetterBlock,
  type CoverLetterForm,
} from "./cover-letter";

/**
 * 送付状の Word（.docx）（2026-11-20）。
 *
 * - 画像ではなく、Word の文字・段落で組み立てる（出力したあと、Word でそのまま書き直せる）。
 * - 宛先が複数のときは、宛先ごとに改ページして1つのファイルにまとめる（1宛先＝1ページ）。
 * - 位置のずらし量（mm）は、横＝段落の左右のインデント（左に足して右から引く＝そのまま横へずれる）、
 *   縦＝段落の前の空き、で表す。PDFとまったく同じ位置にはならないが、同じ向き・同じ量だけ動く。
 * - Word の作成は、ほかのツールと同じ docx ライブラリを使う。処理はすべてブラウザの中で行う。
 */

const TWIPS_PER_MM = 1440 / 25.4;
const tw = (mm: number) => Math.round(mm * TWIPS_PER_MM);
const PT = 20; // 1pt = 20twip
const FONT = "游明朝";
const MARGIN_MM = 20;

export async function buildCoverLetterDocx(form: CoverLetterForm): Promise<Blob> {
  const problem = validateCoverLetter(form);
  if (problem) throw new Error(problem);
  const { AlignmentType, BorderStyle, Document, LineRuleType, Packer, Paragraph, TextRun } = await import("docx");

  const layout = clampLayout(form.layout);
  const font = { ascii: FONT, hAnsi: FONT, eastAsia: FONT, cs: FONT };
  const run = (text: string, o: { size?: number; bold?: boolean } = {}) => new TextRun({ text, font, size: Math.round((o.size ?? 10.5) * 2), bold: o.bold });
  /** ずらし量を、段落のインデント（横）と前の空き（縦）にする。base は標準の前の空き（pt） */
  const place = (b: CoverLetterBlock, basePt: number, extraLeftMm = 0) => {
    const x = layout[b].x;
    return {
      indent: { left: tw(extraLeftMm + x), right: tw(-x) },
      spacing: { before: Math.max(0, Math.round(basePt * PT + tw(layout[b].y))), after: 0, line: Math.round(10.5 * PT * 1.7), lineRule: LineRuleType.AUTO },
    };
  };
  const inBlock = (b: CoverLetterBlock, extraLeftMm = 0) => ({
    indent: { left: tw(extraLeftMm + layout[b].x), right: tw(-layout[b].x) },
    spacing: { before: 0, after: 0, line: Math.round(10.5 * PT * 1.7), lineRule: LineRuleType.AUTO },
  });

  // 差出人は、ページの右半分（左の余白から約85mm）に置く
  const SENDER_LEFT_MM = 85;

  const sections = activeRecipients(form).map((recipient) => {
    const children: InstanceType<typeof Paragraph>[] = [];
    // 日付（右寄せ）
    children.push(new Paragraph({ children: [run(formatJapaneseDate(form.date))], alignment: AlignmentType.RIGHT, ...place("date", 0) }));
    // 宛先（最後の行は大きく、下線）
    const toLines = recipientLines(recipient);
    toLines.forEach((line, i) => {
      const last = i === toLines.length - 1;
      children.push(
        new Paragraph({
          children: [run(line, { size: last ? 14 : 12 })],
          ...(i === 0 ? place("recipient", 18) : inBlock("recipient")),
          // 最後の行（担当者名・御中）は、下線を約100mmの長さにする（段落の右を字下げして、線を短くする）
          ...(last
            ? {
                border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "8C8C94", space: 2 } },
                indent: { left: tw(layout.recipient.x), right: tw(70 - layout.recipient.x) },
              }
            : {}),
        }),
      );
    });
    if (form.kind === "fax") {
      const faxInfo = [recipient.fax.trim() && `FAX：${recipient.fax.trim()}`, recipient.tel.trim() && `TEL：${recipient.tel.trim()}`].filter(Boolean).join("　");
      if (faxInfo) children.push(new Paragraph({ children: [run(faxInfo, { size: 10 })], ...inBlock("recipient") }));
    }
    // 差出人（右半分）
    senderLines(form.sender).forEach((line, i) => {
      children.push(new Paragraph({ children: [run(line, { size: i === 0 ? 11 : 9.5 })], ...(i === 0 ? place("sender", 18, SENDER_LEFT_MM) : inBlock("sender", SENDER_LEFT_MM)) }));
    });
    // 見出し
    children.push(new Paragraph({ children: [run(coverLetterTitle(form), { size: 18, bold: true })], alignment: AlignmentType.CENTER, ...place("title", 28) }));
    // あいさつ文
    if (form.greeting.trim() !== "") {
      form.greeting
        .replace(/\s+$/, "")
        .split(/\r\n|\r|\n/)
        .forEach((line, i) => {
          const closing = /^\s*(敬具|敬白|草々|以上)\s*$/.test(line);
          children.push(
            new Paragraph({
              children: [run(closing ? line.trim() : line)],
              alignment: closing ? AlignmentType.RIGHT : AlignmentType.LEFT,
              ...(i === 0 ? place("body", 14) : inBlock("body")),
            }),
          );
        });
    }
    // 記
    const items = itemLines(form.items);
    const pagesLine = form.kind === "fax" && form.faxPages.trim() ? `送信枚数：${form.faxPages.trim()}枚（本紙を含む）` : "";
    if (items.length > 0 || pagesLine) {
      children.push(new Paragraph({ children: [run("記", { size: 12 })], alignment: AlignmentType.CENTER, ...place("items", 20) }));
      items.forEach((line, i) => children.push(new Paragraph({ children: [run(`${i + 1}．${line}`, { size: 11 })], ...inBlock("items", 14) })));
      if (pagesLine) children.push(new Paragraph({ children: [run(pagesLine, { size: 11 })], ...inBlock("items", 14) }));
    }
    // 連絡事項
    if (form.notes.trim() !== "") {
      children.push(new Paragraph({ children: [run("【連絡事項】")], ...place("notes", 16) }));
      for (const line of form.notes.trim().split(/\r\n|\r|\n/)) children.push(new Paragraph({ children: [run(line, { size: 10 })], ...inBlock("notes", 3.5) }));
    }
    // 以上
    children.push(new Paragraph({ children: [run("以上")], alignment: AlignmentType.RIGHT, spacing: { before: 16 * PT, after: 0 } }));

    return {
      properties: {
        page: {
          size: { width: tw(210), height: tw(297) },
          margin: { top: tw(MARGIN_MM), bottom: tw(MARGIN_MM), left: tw(MARGIN_MM), right: tw(MARGIN_MM) },
        },
      },
      children,
    };
  });

  const doc = new Document({
    creator: "Mr.Satto",
    title: COVER_LETTER_KIND_META[form.kind].label,
    styles: { default: { document: { run: { font, size: 21 } } } },
    sections,
  });
  return Packer.toBlob(doc);
}
