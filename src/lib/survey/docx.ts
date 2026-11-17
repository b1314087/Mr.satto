import type { Question, Survey } from "./model";

/**
 * アンケート用紙の Word（.docx）（2026-11-17）。
 *
 * 画像を貼るのではなく、Word の文字・段落・表で組み立てる（出力したあとに、Word でそのまま書き直せる）。
 * - タイトル・説明・質問・選択肢・セクションの見出しは段落、記入欄・段階評価・氏名などの欄は表。
 * - 質問の途中でページが分かれないよう、質問文から記入欄までを「次の段落と分離しない」「行の途中で分けない」にする。
 * - 用紙（A4縦・横）・余白・ページ番号は、Word のページ設定・フッターにする。
 * Word の作成は、既存のツール（ラベル作成）と同じ docx ライブラリを使う。処理はすべてブラウザの中で行う。
 */

const TWIPS_PER_MM = 1440 / 25.4;
const FONT = "游ゴシック";

const tw = (mm: number) => Math.round(mm * TWIPS_PER_MM);
const hexColor = (c: string) => c.replace("#", "").toUpperCase();

export async function buildSurveyDocx(survey: Survey): Promise<Blob> {
  const {
    AlignmentType,
    BorderStyle,
    Document,
    Footer,
    HeightRule,
    LineRuleType,
    Packer,
    PageNumber,
    PageOrientation,
    Paragraph,
    ShadingType,
    Table,
    TableCell,
    TableLayoutType,
    TableRow,
    TextRun,
    VerticalAlign,
    WidthType,
  } = await import("docx");

  const d = survey.design;
  const portrait = d.orientation === "portrait";
  const pageW = portrait ? 210 : 297;
  const contentW = pageW - d.margin * 2;
  const half = (pt: number) => Math.round(pt * 2);
  const size = half(d.fontSize);
  const small = half(d.fontSize * 0.9);
  const accent = hexColor(d.accent);
  const font = { ascii: FONT, hAnsi: FONT, eastAsia: FONT, cs: FONT };
  const lineTw = Math.round(d.fontSize * 20 * 1.6);
  const run = (text: string, o: { bold?: boolean; color?: string; size?: number; underline?: boolean } = {}) =>
    new TextRun({ text, bold: o.bold, color: o.color, size: o.size ?? size, font, underline: o.underline ? {} : undefined });
  const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" } as const;
  const thin = (color = "55555F") => ({ style: BorderStyle.SINGLE, size: 4, color }) as const;
  const noBorders = { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none };
  const indentQ = tw(Math.max(6, d.fontSize * 0.3528 * 2.4));

  const children: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = [];
  const para = (runs: InstanceType<typeof TextRun>[], o: Record<string, unknown> = {}) =>
    new Paragraph({ children: runs, spacing: { before: 0, after: 0, line: lineTw, lineRule: LineRuleType.AUTO }, ...o });
  const spacer = (mm: number) => new Paragraph({ children: [], spacing: { before: 0, after: 0, line: Math.max(20, tw(mm)), lineRule: LineRuleType.EXACT } });

  // タイトル・説明
  if (survey.title.trim()) {
    children.push(
      para([run(survey.title, { bold: true, size: half(d.titleSize) })], {
        alignment: d.titleAlign === "center" ? AlignmentType.CENTER : AlignmentType.LEFT,
        border: d.headingStyle === "plain" ? undefined : { bottom: { style: BorderStyle.SINGLE, size: 8, color: accent, space: 4 } },
        spacing: { before: 0, after: tw(3), line: Math.round(d.titleSize * 20 * 1.4), lineRule: LineRuleType.AUTO },
        keepNext: true,
      }),
    );
  }
  if (survey.description.trim()) {
    for (const line of survey.description.split(/\r?\n/)) children.push(para([run(line)], { keepNext: true }));
  }

  // 氏名・所属などの記入欄（ラベルと、下線の付いた記入欄の表）
  const fields = survey.fields.filter((f) => f.enabled && f.label.trim());
  if (fields.length) {
    children.push(spacer(2));
    const perRow = portrait ? 2 : 3;
    const colW = tw(contentW / perRow);
    const rows: InstanceType<typeof TableRow>[] = [];
    for (let i = 0; i < fields.length; i += perRow) {
      const chunk = fields.slice(i, i + perRow);
      const cells: InstanceType<typeof TableCell>[] = [];
      for (let j = 0; j < perRow; j++) {
        const f = chunk[j];
        const labelW = Math.round(colW * 0.32);
        cells.push(
          new TableCell({
            width: { size: labelW, type: WidthType.DXA },
            borders: { top: none, left: none, right: none, bottom: none },
            verticalAlign: VerticalAlign.BOTTOM,
            children: [para(f ? [run(`${f.label}：`)] : [])],
          }),
          new TableCell({
            width: { size: colW - labelW, type: WidthType.DXA },
            borders: { top: none, left: none, right: none, bottom: f ? thin() : none },
            verticalAlign: VerticalAlign.BOTTOM,
            children: [para([])],
          }),
        );
      }
      rows.push(new TableRow({ height: { value: tw(9 * d.answerScale), rule: HeightRule.ATLEAST }, cantSplit: true, children: cells }));
    }
    children.push(new Table({ rows, width: { size: tw(contentW), type: WidthType.DXA }, layout: TableLayoutType.FIXED, borders: noBorders }));
  }

  // 回答者への案内・注意事項（薄い灰色の枠）
  if (survey.guide.trim() || survey.notes.trim()) {
    children.push(spacer(3));
    const ps = [
      ...(survey.guide.trim() ? survey.guide.split(/\r?\n/).map((l) => para([run(l, { size: small })])) : []),
      ...(survey.notes.trim() ? survey.notes.split(/\r?\n/).map((l, i) => para([run(`${i === 0 ? "※ " : ""}${l}`, { size: small, color: "5A5A64" })])) : []),
    ];
    children.push(
      new Table({
        width: { size: tw(contentW), type: WidthType.DXA },
        layout: TableLayoutType.FIXED,
        rows: [
          new TableRow({
            cantSplit: true,
            children: [
              new TableCell({
                width: { size: tw(contentW), type: WidthType.DXA },
                shading: { type: ShadingType.CLEAR, color: "auto", fill: "F4F4F6" },
                borders: { top: thin("D6D6DC"), bottom: thin("D6D6DC"), left: thin("D6D6DC"), right: thin("D6D6DC") },
                margins: { top: tw(1.5), bottom: tw(1.5), left: tw(2.5), right: tw(2.5) },
                children: ps,
              }),
            ],
          }),
        ],
      }),
    );
  }

  // 質問
  let no = 0;
  const answerIndent = { left: indentQ };
  for (const q of survey.questions) {
    children.push(spacer(d.spacing));
    if (q.type === "section") {
      children.push(...sectionParas(q));
      continue;
    }
    no++;
    const head: InstanceType<typeof TextRun>[] = [];
    if (d.numbering) head.push(run(`Q${no}　`, { bold: true, color: d.headingStyle === "plain" ? undefined : accent }));
    if (d.showRequired && q.required) head.push(run("［必須］", { color: "C62828", size: half(d.fontSize * 0.8) }), run(" "));
    head.push(run(q.title.trim() || "（質問文）", { bold: true }));
    children.push(para(head, { keepNext: true, keepLines: true, indent: { left: indentQ, hanging: d.numbering ? indentQ : 0 } }));
    if (q.description.trim()) {
      for (const l of q.description.split(/\r?\n/)) children.push(para([run(l, { size: small, color: "5A5A64" })], { keepNext: true, keepLines: true, indent: answerIndent }));
    }
    children.push(...answerParts(q));
  }

  function sectionParas(q: Question) {
    const title = q.title.trim() || "セクション";
    const hs = d.headingStyle;
    const textColor = hs === "bar" ? "FFFFFF" : hs === "plain" ? undefined : accent;
    const out: InstanceType<typeof Paragraph>[] = [
      para([run(title, { bold: true, size: half(d.fontSize * 1.2), color: textColor })], {
        keepNext: true,
        keepLines: true,
        shading: hs === "bar" ? { type: ShadingType.CLEAR, color: "auto", fill: accent } : undefined,
        border:
          hs === "box"
            ? { top: { style: BorderStyle.SINGLE, size: 6, color: accent, space: 2 }, bottom: { style: BorderStyle.SINGLE, size: 6, color: accent, space: 2 }, left: { style: BorderStyle.SINGLE, size: 6, color: accent, space: 4 }, right: { style: BorderStyle.SINGLE, size: 6, color: accent, space: 4 } }
            : hs === "underline"
              ? { bottom: { style: BorderStyle.SINGLE, size: 8, color: accent, space: 2 } }
              : undefined,
      }),
    ];
    if (q.description.trim()) for (const l of q.description.split(/\r?\n/)) out.push(para([run(l, { size: small, color: "5A5A64" })], { keepNext: true }));
    return out;
  }

  function choiceParas(q: Question, mark: string, options: string[], other: boolean) {
    const items = options.filter((o) => o.trim());
    const otherText = `${mark} その他（　　　　　　　　）`;
    if (q.direction === "horizontal") {
      const text = [...items.map((o) => `${mark} ${o}`), ...(other ? [otherText] : [])].join("　　");
      return [para([run(text)], { keepLines: true, indent: answerIndent })];
    }
    const all = [...items.map((o) => `${mark} ${o}`), ...(other ? [otherText] : [])];
    return all.map((t, i) => para([run(t)], { keepNext: i < all.length - 1, keepLines: true, indent: { left: indentQ + tw(5), hanging: tw(5) } }));
  }

  function answerParts(q: Question) {
    const availMm = contentW - indentQ / TWIPS_PER_MM;
    switch (q.type) {
      case "single":
        return choiceParas(q, "○", q.options, q.other);
      case "multiple":
        return choiceParas(q, "□", q.options, q.other);
      case "short": {
        const w = q.width === "short" ? 40 : q.width === "medium" ? availMm * 0.6 : availMm;
        return [
          para([], {
            indent: { left: indentQ, right: tw(Math.max(0, availMm - w)) },
            border: { bottom: thin() },
            spacing: { before: 0, after: 0, line: Math.round(lineTw * 1.5 * d.answerScale), lineRule: LineRuleType.EXACT },
          }),
        ];
      }
      case "long": {
        // 行ごとの表の行にして、行と行の間に点線を引く（行は Word で増やせる。段落の罫線だと1本にまとまってしまうため）
        const lineH = Math.round(lineTw * 1.35 * d.answerScale);
        const dotted = d.ruledLines ? ({ style: BorderStyle.DOTTED, size: 4, color: "B9B9C2" } as const) : none;
        const rows = Array.from({ length: q.lines }, (_, i) =>
          new TableRow({
            cantSplit: true,
            height: { value: lineH, rule: HeightRule.EXACT },
            children: [
              new TableCell({
                width: { size: tw(availMm), type: WidthType.DXA },
                borders: { top: i === 0 ? thin() : dotted, bottom: i === q.lines - 1 ? thin() : dotted, left: thin(), right: thin() },
                margins: { left: tw(2), right: tw(2) },
                // 記入欄の途中でページが分かれないよう、最後の行まで「次の段落と分離しない」にする
                children: [para([], { keepNext: i < q.lines - 1 })],
              }),
            ],
          }),
        );
        return [answerTable(availMm, rows)];
      }
      case "rating": {
        const marks = Array.from({ length: q.ratingMax }, (_, i) => (q.ratingStyle === "star" ? "☆" : String.fromCodePoint(0x2460 + i)));
        const runs = [
          ...(q.ratingLow.trim() ? [run(`${q.ratingLow}　`, { size: small, color: "5A5A64" })] : []),
          run(marks.join("　"), { size: half(d.fontSize * (q.ratingStyle === "star" ? 1.5 : 1.3)) }),
          ...(q.ratingHigh.trim() ? [run(`　${q.ratingHigh}`, { size: small, color: "5A5A64" })] : []),
        ];
        return [para(runs, { keepLines: true, indent: answerIndent })];
      }
      case "scale": {
        const steps = q.scale.filter((s) => s.trim());
        if (steps.length === 0) return [];
        const colMm = Math.min(30, availMm / steps.length);
        if (colMm < 15) return choiceParas({ ...q, direction: "vertical" }, "○", steps, false);
        const cell = (children: InstanceType<typeof Paragraph>[], center = false) =>
          new TableCell({ width: { size: tw(colMm), type: WidthType.DXA }, borders: { top: none, bottom: none, left: none, right: none }, verticalAlign: center ? VerticalAlign.CENTER : VerticalAlign.BOTTOM, children });
        return [
          answerTable(
            colMm * steps.length,
            [
              new TableRow({ cantSplit: true, children: steps.map((s) => cell([para([run(s, { size: small })], { alignment: AlignmentType.CENTER, keepNext: true })])) }),
              new TableRow({ cantSplit: true, children: steps.map(() => cell([para([run("○", { size: half(d.fontSize * 1.3) })], { alignment: AlignmentType.CENTER })], true)) }),
            ],
            true,
          ),
        ];
      }
      case "number": {
        const bw = q.width === "full" ? Math.min(availMm * 0.6, 90) : q.width === "medium" ? 55 : 32;
        const unitW = Math.max(10, Math.min(availMm - bw, 40));
        return [
          answerTable(bw + unitW, [
            new TableRow({
              cantSplit: true,
              height: { value: Math.round(lineTw * 1.5 * d.answerScale), rule: HeightRule.ATLEAST },
              children: [
                new TableCell({ width: { size: tw(bw), type: WidthType.DXA }, borders: { top: thin(), bottom: thin(), left: thin(), right: thin() }, children: [para([])] }),
                new TableCell({ width: { size: tw(unitW), type: WidthType.DXA }, borders: { top: none, bottom: none, left: none, right: none }, verticalAlign: VerticalAlign.CENTER, children: [para([run(` ${q.unit}`)])] }),
              ],
            }),
          ]),
        ];
      }
      case "date": {
        const blank = (n: number) => run("　".repeat(n), { underline: true });
        const runs =
          q.dateStyle === "wareki"
            ? [blank(3), run("年"), blank(2), run("月"), blank(2), run("日"), run("（元号："), blank(3), run("）")]
            : [blank(4), run("年"), blank(2), run("月"), blank(2), run("日")];
        return [para(runs, { indent: answerIndent, spacing: { before: tw(2), after: 0, line: lineTw, lineRule: LineRuleType.AUTO } })];
      }
      case "section":
        return [];
    }
  }

  function answerTable(widthMm: number, rows: InstanceType<typeof TableRow>[], noBorder = false) {
    return new Table({
      rows,
      width: { size: tw(widthMm), type: WidthType.DXA },
      indent: { size: indentQ, type: WidthType.DXA },
      layout: TableLayoutType.FIXED,
      borders: noBorder ? noBorders : undefined,
    });
  }

  const footers = d.pageNumbers
    ? {
        default: new Footer({
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun({ children: [PageNumber.CURRENT], size: small, color: "5A5A64", font }),
                new TextRun({ text: " / ", size: small, color: "5A5A64", font }),
                new TextRun({ children: [PageNumber.TOTAL_PAGES], size: small, color: "5A5A64", font }),
              ],
            }),
          ],
        }),
      }
    : undefined;

  const doc = new Document({
    creator: "Mr.Satto",
    title: survey.title.trim() || "アンケート",
    styles: { default: { document: { run: { font, size } } } },
    sections: [
      {
        properties: {
          page: {
            // docx には縦向きの寸法を渡し、横向きは向きの指定で入れ替える
            size: { width: tw(210), height: tw(297), orientation: portrait ? PageOrientation.PORTRAIT : PageOrientation.LANDSCAPE },
            margin: { top: tw(d.margin), bottom: tw(d.margin), left: tw(d.margin), right: tw(d.margin), header: tw(Math.max(4, d.margin / 2)), footer: tw(Math.max(4, d.margin / 2)), gutter: 0 },
          },
        },
        footers,
        children,
      },
    ],
  });
  return Packer.toBlob(doc);
}
