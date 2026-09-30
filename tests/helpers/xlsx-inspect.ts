/**
 * テスト側（Node.js実行環境）でのXLSX内容検証ヘルパー（Phase 18）。
 *
 * 「ダウンロードイベントが発火した」「ZIPマジックバイトが一致した」だけを
 * 成功と見なさない方針（tests/helpers/tool-runner.ts の assertDownloadedFile は
 * マジックバイト・サイズしか確認していない）に沿い、記入されたPDF→Excel
 * 「テンプレートモード」が生成したXLSXを実際に読み取り、
 * 列名（項目名）・行数（1行1人）・セルの値まで確認するために使う。
 *
 * 新しいnpm依存は追加しない（開発指示書48章）。アプリ本体が既にExcelの
 * 「書き込み」に使っている write-excel-file と対になる、同じ作者による
 * 「読み取り」用パッケージ read-excel-file が package.json に既存の依存として
 * 存在するため（xlsx skillの案内より前に、まず既存依存を確認して再利用する）、
 * そのNode向けエントリポイント（read-excel-file/node）をテストコードから
 * 直接呼び出す。
 */

// read-excel-file/node の型はESM専用パッケージの構成上テスト側のtsconfigと
// 相性が悪い場合があるため、実行時のrequireで読み込む（他ヘルパーのpdfjs-dist
// 動的importと同じ「テストコード側だけで完結させる」方針）。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function importReadSheet(): Promise<(path: string) => Promise<any[][]>> {
  const mod = (await import("read-excel-file/node")) as unknown as {
    readSheet: (path: string) => Promise<unknown[][]>;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return mod.readSheet as any;
}

export interface XlsxSheetContent {
  /** 1行目（ヘッダー行）のセル値を文字列化したもの */
  headers: string[];
  /** 2行目以降（データ行）。各セルは元の型（文字列・数値等）のまま */
  rows: unknown[][];
}

/** 生成されたXLSXファイルの最初のシートを読み取り、ヘッダー行とデータ行に分ける */
export async function readXlsxSheet(filePath: string): Promise<XlsxSheetContent> {
  const readSheet = await importReadSheet();
  const data = await readSheet(filePath);
  const [headerRow, ...rows] = data;
  const headers = (headerRow ?? []).map((c) => (c == null ? "" : String(c)));
  return { headers, rows };
}

/**
 * 生成されたXLSXの罫線・結合セル・セル色（外出先PC修正指示書§21-26・§29-31）を
 * 検証するためのヘルパー。read-excel-fileは値のみを返しスタイル情報を
 * 持たないため、アプリ本体のooxml-page-settings.tsと同じ方針（fflateで
 * ZIPを解凍し、生のXML文字列を直接見る）で、テストからXLSXの内部構造を
 * 直接確認する。新しいnpm依存は追加しない(fflateは既存の依存)。
 */
export interface XlsxRawStructure {
  /** xl/worksheets/sheet1.xml の生テキスト */
  sheetXml: string;
  /** xl/styles.xml の生テキスト（無ければ空文字列） */
  stylesXml: string;
  /** <mergeCell ref="..."/> のref属性一覧 */
  mergedRanges: string[];
  /** styles.xml の<borders>内で、少なくとも1辺にstyle属性(!="none")を持つ<border>の数 */
  borderStyleCount: number;
}

export async function readXlsxRawStructure(filePath: string): Promise<XlsxRawStructure> {
  const fs = await import("node:fs/promises");
  const { unzipSync, strFromU8 } = await import("fflate");
  const bytes = new Uint8Array(await fs.readFile(filePath));
  const entries = unzipSync(bytes, {
    filter: (info) => info.name === "xl/worksheets/sheet1.xml" || info.name === "xl/styles.xml",
  });
  const sheetXml = entries["xl/worksheets/sheet1.xml"] ? strFromU8(entries["xl/worksheets/sheet1.xml"]) : "";
  const stylesXml = entries["xl/styles.xml"] ? strFromU8(entries["xl/styles.xml"]) : "";

  const mergedRanges = Array.from(sheetXml.matchAll(/<mergeCell ref="([^"]+)"/g)).map((m) => m[1]);

  const borderBlocks = Array.from(stylesXml.matchAll(/<border[^>]*>[\s\S]*?<\/border>/g)).map((m) => m[0]);
  const borderStyleCount = borderBlocks.filter((b) => /<(top|bottom|left|right)\s+style="(?!none)[^"]+"/.test(b)).length;

  return { sheetXml, stylesXml, mergedRanges, borderStyleCount };
}
