import { zipSync, strToU8 } from "fflate";

/**
 * Phase 18.2 B節（excel-to-pdf）テスト用の、最小限の手組みXLSX(OOXML)生成ヘルパー。
 *
 * 既存の write-excel-file（Phase 1から使用）は、印刷範囲(Print Area)・
 * ページ設定(pageSetup: 用紙サイズ/Fit to Page/scale)・余白(pageMargins)・
 * 非表示行列・改ページ(rowBreaks/colBreaks)を書き出す機能を持たない
 * （セルスタイル・罫線・sheet orientationのみ対応）ため、これらのテストには
 * 使えない。そのため、アプリ本体が読み取る側（src/lib/excel/ooxml-page-settings.ts）
 * と対になる、最小限だが仕様に忠実なXLSXをテストコード側で直接組み立てる。
 *
 * 新しいXLSX生成ライブラリは追加せず、既存依存のfflate（ZIP化）だけを使う
 * （開発指示書J「新規npmパッケージは原則追加しない」。テストコードにも同じ方針を適用）。
 *
 * 実在の人物・企業データは一切使用しない、テスト専用の架空データのみ。
 */

export interface XlsxCellSpec {
  value: string | number;
  /** styles.xmlのcellXfsに登録するスタイル。省略時はスタイル無し(0番=デフォルト) */
  border?: { top?: boolean; bottom?: boolean; left?: boolean; right?: boolean };
  /**
   * 外出先PC修正指示書§29-31（excel-to-pdfのセル色反映）テスト用。
   * "#RRGGBB"形式。fill=背景色(塗りつぶし)、fontColor=文字色。
   */
  fill?: string;
  fontColor?: string;
  bold?: boolean;
}

export interface XlsxSheetSpec {
  name: string;
  /** 行ごとのセル配列(0始まりで行・列に対応。undefinedのセルは空欄) */
  rows: (XlsxCellSpec | null)[][];
  printArea?: string; // 例: "A1:D5"
  paperSize?: 1 | 5 | 8 | 9 | 11; // Letter/Legal/A3/A4/A5 (ECMA-376 ST_PaperSize)
  orientation?: "portrait" | "landscape";
  fitToPage?: boolean;
  fitToWidth?: number;
  fitToHeight?: number;
  scale?: number;
  margins?: { top?: number; bottom?: number; left?: number; right?: number; header?: number; footer?: number };
  hiddenRows?: number[]; // 0始まり
  hiddenCols?: number[]; // 0始まり
  columnWidths?: Record<number, number>; // 0始まり列番号 → Excel列幅(文字単位)
  rowHeights?: Record<number, number>; // 0始まり行番号 → pt
  rowBreaksAfter?: number[]; // 0始まり。この行の直後で改ページ
  colBreaksAfter?: number[];
  /** ヘッダー/フッター(Phase 22 B-9・B-10)。指定したセクションのみ&L/&C/&Rとして書き出す。
   *  &P(ページ番号)・&N(総ページ数)等のOOXMLフィールドコードはそのまま文字列に
   *  含めてよい(例: center: "&P/&N")。 */
  header?: { left?: string; center?: string; right?: string };
  footer?: { left?: string; center?: string; right?: string };
}

function colLetter(colIndex0: number): string {
  let n = colIndex0 + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function cellRef(row0: number, col0: number): string {
  return `${colLetter(col0)}${row0 + 1}`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

interface StyleCombo {
  border: { top: boolean; bottom: boolean; left: boolean; right: boolean };
  fill: string | null;
  fontColor: string | null;
  bold: boolean;
}

/**
 * 複数シート分のスタイル(罫線・背景色・文字色・太字)の組み合わせから、
 * 一意なborderId/fillId/fontId/cellXfsのインデックス(s)を作る。
 * 単純化のため「4辺すべて同じstyle設定・同じ背景色・同じ文字色・同じ太字」の
 * 組をまとめて1つのcellXfsエントリとして扱う（テスト用途では十分）。
 *
 * fills配列はOOXML仕様上、インデックス0="none"・1="gray125"が予約済みの
 * 組み込みエントリのため、実際に使う背景色はインデックス2以降に登録する。
 */
function buildStylesXml(combos: StyleCombo[]): string {
  // OOXMLの<border>要素は<left>/<right>/<top>/<bottom>それぞれ個別要素を持ち、
  // 罫線を設定する辺だけにstyle属性(thin等)とcolor子要素を付ける。
  function sideEl(tag: string, has: boolean): string {
    return has ? `<${tag} style="thin"><color indexed="64"/></${tag}>` : `<${tag}/>`;
  }
  const borderKeys = Array.from(new Set(combos.map((c) => borderKeyOf(c.border))));
  const borderIndexByKey = new Map(borderKeys.map((k, i) => [k, i]));
  const borderXmls = borderKeys
    .map((k) => {
      const b = { top: k[0] === "1", bottom: k[1] === "1", left: k[2] === "1", right: k[3] === "1" };
      return `<border>${sideEl("left", b.left)}${sideEl("right", b.right)}${sideEl("top", b.top)}${sideEl("bottom", b.bottom)}<diagonal/></border>`;
    })
    .join("");

  const fillColors = Array.from(new Set(combos.map((c) => c.fill).filter((f): f is string => Boolean(f))));
  const fillIndexByColor = new Map(fillColors.map((c, i) => [c, i + 2])); // 0,1は組み込み予約
  const customFillXmls = fillColors
    .map((c) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${c.replace("#", "").toUpperCase()}"/><bgColor indexed="64"/></patternFill></fill>`)
    .join("");

  const fontKeys = Array.from(new Set(combos.map((c) => `${c.fontColor ?? ""}|${c.bold ? 1 : 0}`)));
  const fontIndexByKey = new Map(fontKeys.map((k, i) => [k, i + 1])); // 0番はデフォルトフォント
  const customFontXmls = fontKeys
    .map((k) => {
      const [color, boldFlag] = k.split("|");
      return `<font><sz val="11"/><name val="Calibri"/>${boldFlag === "1" ? "<b/>" : ""}${
        color ? `<color rgb="FF${color.replace("#", "").toUpperCase()}"/>` : ""
      }</font>`;
    })
    .join("");

  const cellXfs = combos
    .map((c) => {
      const borderId = borderIndexByKey.get(borderKeyOf(c.border)) ?? 0;
      const fillId = c.fill ? fillIndexByColor.get(c.fill)! : 0;
      const fontId = fontIndexByKey.get(`${c.fontColor ?? ""}|${c.bold ? 1 : 0}`) ?? 0;
      return `<xf numFmtId="0" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0" applyBorder="1" applyFill="${c.fill ? 1 : 0}" applyFont="${fontId ? 1 : 0}"/>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="0"/>
<fonts count="${fontKeys.length + 1}"><font><sz val="11"/><name val="Calibri"/></font>${customFontXmls}</fonts>
<fills count="${fillColors.length + 2}"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${customFillXmls}</fills>
<borders count="${borderKeys.length}">${borderXmls}</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${combos.length}">${cellXfs}</cellXfs>
</styleSheet>`;
}

function borderKeyOf(b?: XlsxCellSpec["border"]): string {
  if (!b) return "0000";
  return `${b.top ? 1 : 0}${b.bottom ? 1 : 0}${b.left ? 1 : 0}${b.right ? 1 : 0}`;
}

function styleKeyOf(cell?: XlsxCellSpec | null): string {
  if (!cell) return "0000||0|0";
  return `${borderKeyOf(cell.border)}|${cell.fill ?? ""}|${cell.fontColor ?? ""}|${cell.bold ? 1 : 0}`;
}

/** 1つのシート仕様から sheetN.xml を生成する */
function buildSheetXml(sheet: XlsxSheetSpec, styleIndexByKey: Map<string, number>): string {
  const hiddenRowSet = new Set(sheet.hiddenRows ?? []);
  const hiddenColSet = new Set(sheet.hiddenCols ?? []);

  const colCount = Math.max(1, ...sheet.rows.map((r) => r.length));
  const colsXml =
    Object.keys(sheet.columnWidths ?? {}).length > 0 || hiddenColSet.size > 0
      ? `<cols>${Array.from({ length: colCount }, (_, c) => {
          const width = sheet.columnWidths?.[c];
          const hidden = hiddenColSet.has(c);
          if (width === undefined && !hidden) return "";
          return `<col min="${c + 1}" max="${c + 1}" width="${width ?? 10}" customWidth="1"${hidden ? ' hidden="1"' : ""}/>`;
        }).join("")}</cols>`
      : "";

  const rowsXml = sheet.rows
    .map((row, r) => {
      const ht = sheet.rowHeights?.[r];
      const hidden = hiddenRowSet.has(r);
      const cellsXml = row
        .map((cell, c) => {
          if (!cell) return "";
          const sIdx = styleIndexByKey.get(styleKeyOf(cell)) ?? 0;
          const ref = cellRef(r, c);
          if (typeof cell.value === "number") {
            return `<c r="${ref}" s="${sIdx}"><v>${cell.value}</v></c>`;
          }
          return `<c r="${ref}" s="${sIdx}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(cell.value))}</t></is></c>`;
        })
        .join("");
      return `<row r="${r + 1}"${ht !== undefined ? ` ht="${ht}" customHeight="1"` : ""}${hidden ? ' hidden="1"' : ""}>${cellsXml}</row>`;
    })
    .join("");

  const pageSetUpPr = sheet.fitToPage ? `<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>` : "";
  const dimensionRef = `A1:${colLetter(colCount - 1)}${sheet.rows.length}`;

  const margins = sheet.margins ?? {};
  const pageMarginsXml = `<pageMargins left="${margins.left ?? 0.7}" right="${margins.right ?? 0.7}" top="${
    margins.top ?? 0.75
  }" bottom="${margins.bottom ?? 0.75}" header="${margins.header ?? 0.3}" footer="${margins.footer ?? 0.3}"/>`;

  const pageSetupAttrs = [
    sheet.paperSize !== undefined ? `paperSize="${sheet.paperSize}"` : "",
    `orientation="${sheet.orientation ?? "portrait"}"`,
    sheet.fitToWidth !== undefined ? `fitToWidth="${sheet.fitToWidth}"` : "",
    sheet.fitToHeight !== undefined ? `fitToHeight="${sheet.fitToHeight}"` : "",
    sheet.scale !== undefined ? `scale="${sheet.scale}"` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const rowBreaksXml =
    sheet.rowBreaksAfter && sheet.rowBreaksAfter.length > 0
      ? `<rowBreaks count="${sheet.rowBreaksAfter.length}" manualBreakCount="${sheet.rowBreaksAfter.length}">${sheet.rowBreaksAfter
          .map((id) => `<brk id="${id + 1}" max="16383" man="1"/>`)
          .join("")}</rowBreaks>`
      : "";
  const colBreaksXml =
    sheet.colBreaksAfter && sheet.colBreaksAfter.length > 0
      ? `<colBreaks count="${sheet.colBreaksAfter.length}" manualBreakCount="${sheet.colBreaksAfter.length}">${sheet.colBreaksAfter
          .map((id) => `<brk id="${id + 1}" max="1048575" man="1"/>`)
          .join("")}</colBreaks>`
      : "";

  // ヘッダー/フッター(Phase 22 B-9・B-10): 指定されたセクションだけを&L/&C/&Rで組み立てる。
  const buildHeaderFooterRaw = (spec?: { left?: string; center?: string; right?: string }): string => {
    if (!spec) return "";
    let raw = "";
    if (spec.left) raw += `&L${spec.left}`;
    if (spec.center) raw += `&C${spec.center}`;
    if (spec.right) raw += `&R${spec.right}`;
    return raw;
  };
  const oddHeaderRaw = buildHeaderFooterRaw(sheet.header);
  const oddFooterRaw = buildHeaderFooterRaw(sheet.footer);
  const headerFooterXml =
    oddHeaderRaw || oddFooterRaw
      ? `<headerFooter>${oddHeaderRaw ? `<oddHeader>${escapeXml(oddHeaderRaw)}</oddHeader>` : ""}${
          oddFooterRaw ? `<oddFooter>${escapeXml(oddFooterRaw)}</oddFooter>` : ""
        }</headerFooter>`
      : "";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
${pageSetUpPr}
<dimension ref="${dimensionRef}"/>
<sheetViews><sheetView workbookViewId="0"/></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
${colsXml}
<sheetData>${rowsXml}</sheetData>
${pageMarginsXml}
<pageSetup ${pageSetupAttrs}/>
${headerFooterXml}
${rowBreaksXml}
${colBreaksXml}
</worksheet>`;
}

/** 複数シート仕様から、実際に読み込み可能な最小限の.xlsx(ArrayBuffer)を組み立てる */
export function buildMinimalXlsx(sheets: XlsxSheetSpec[]): Uint8Array {
  // 全シート分のスタイル(罫線・背景色・文字色・太字)の組み合わせを収集し、
  // styles.xmlのfonts/fills/borders/cellXfsへ一意登録する
  const comboByKey = new Map<string, StyleCombo>([
    ["0000||0|0", { border: { top: false, bottom: false, left: false, right: false }, fill: null, fontColor: null, bold: false }],
  ]);
  for (const sheet of sheets) {
    for (const row of sheet.rows) {
      for (const cell of row) {
        if (!cell) continue;
        const key = styleKeyOf(cell);
        if (!comboByKey.has(key)) {
          comboByKey.set(key, {
            border: {
              top: Boolean(cell.border?.top),
              bottom: Boolean(cell.border?.bottom),
              left: Boolean(cell.border?.left),
              right: Boolean(cell.border?.right),
            },
            fill: cell.fill ?? null,
            fontColor: cell.fontColor ?? null,
            bold: Boolean(cell.bold),
          });
        }
      }
    }
  }
  const keys = Array.from(comboByKey.keys());
  const styleIndexByKey = new Map(keys.map((k, i) => [k, i]));
  const combos = keys.map((k) => comboByKey.get(k)!);

  const stylesXml = buildStylesXml(combos);

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("\n")}
</Types>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("\n")}
<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const definedNames = sheets
    .map((s, i) =>
      s.printArea
        ? `<definedName name="_xlnm.Print_Area" localSheetId="${i}">'${escapeXml(s.name)}'!${s.printArea.replace(
            /([A-Z]+)(\d+):([A-Z]+)(\d+)/,
            "$$$1$$$2:$$$3$$$4"
          )}</definedName>`
        : ""
    )
    .filter(Boolean)
    .join("");

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets
    .map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join("")}</sheets>
${definedNames ? `<definedNames>${definedNames}</definedNames>` : ""}
</workbook>`;

  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(contentTypesXml),
    "_rels/.rels": strToU8(rootRelsXml),
    "xl/workbook.xml": strToU8(workbookXml),
    "xl/_rels/workbook.xml.rels": strToU8(workbookRelsXml),
    "xl/styles.xml": strToU8(stylesXml),
  };
  sheets.forEach((sheet, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(buildSheetXml(sheet, styleIndexByKey));
  });

  return zipSync(files);
}
