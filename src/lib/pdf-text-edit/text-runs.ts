import type { ContentOperation, ContentValue } from "./content-tokens";

/**
 * ページの「文字を描く命令」（Tj・TJ・'・"）ごとに、1文字ずつの位置と、元のバイトの中のどこにあるかを求める（2026-11-18 文字を消す機能）。
 *
 * 文字の形の幅（どれだけ進むか）は、PDFを表示する部品（pdf.js）が読み取ったものを使う。
 * pdf.js の命令の一覧（getOperatorList）の「文字を描く」と、このファイルで読んだ命令は、同じ順番で並ぶので、順番で対応させる。
 * 対応が少しでも合わないページは、安全のため、文字を消せないページとして扱う。
 */

export type Matrix = [number, number, number, number, number, number];

/** pdf.js が読み取った1文字（命令の一覧の showText の中身） */
export interface SourceGlyph {
  unicode: string;
  /** 文字コード（1バイトのフォントなら0〜255、2バイトなら0〜65535） */
  originalCharCode: number;
  /** 文字の幅（1000分の1em） */
  width: number;
}

/** フォントの情報（pdf.js のフォントから取る） */
export interface RunFontInfo {
  /** 縦書きのフォント（このフォントの文字は消せない） */
  vertical: boolean;
  /** 標準の大きさの決まり（1000分の1em）でないフォント（Type3など。消せない） */
  unusualMatrix: boolean;
  /** 文字の上端・下端（em。例：0.88・-0.12） */
  ascent: number;
  descent: number;
}

export interface RunGlyph {
  unicode: string;
  code: number;
  byteLen: 1 | 2;
  width: number;
  /** 画面のページの座標（左下が原点、上が正。pt）での、文字の範囲 */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 文字の基準線（文字の下のほう）の高さと、文字の左端（画面のページの座標） */
  baseX: number;
  baseY: number;
}

export interface TextRun {
  /** 命令の一覧（parseContentStream の結果）の何番目か */
  opIndex: number;
  operator: string;
  glyphs: RunGlyph[];
  /** この命令の文字を消せるか（縦書き・特別なフォントなどは消せない） */
  erasable: boolean;
  /** 命令のときの文字の大きさ・文字間隔・単語間隔（消したあとの位置合わせに使う） */
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  /** 画面のページの座標での、だいたいの文字の高さ（pt） */
  displayFontSize: number;
  /** この命令を囲む「BDC」命令（ActualText などの読み上げ用の文字を持つことがある）の番号 */
  enclosingMarkedContent: number[];
}

export interface TextRunsInput {
  ops: ContentOperation[];
  /** pdf.js の命令の一覧の、ページ直下（フォームや注釈の中を除く）の showText の中身を、順番に並べたもの */
  showTextGlyphs: (SourceGlyph | number)[][];
  /** pdf.js の命令の一覧の、ページ直下の setFont のフォントのIDを、順番に並べたもの */
  setFontIds: string[];
  fonts: Record<string, RunFontInfo>;
  /** ページの座標（PDFの本来の座標）を、画面のページの座標（左下が原点、上が正）に直す */
  toDisplay: (x: number, y: number) => [number, number];
}

export interface TextRunsResult {
  runs: TextRun[];
  /** pdf.js との対応が最後まで取れたか（取れなかったページは、文字を消さない） */
  aligned: boolean;
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function mul(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
}

function num(v: ContentValue | undefined, fallback = 0): number {
  return v && v.kind === "number" ? v.value : fallback;
}

interface GState {
  ctm: Matrix;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  leading: number;
  fontName: string | null;
  fontSize: number;
  rise: number;
}

/** 文字列のバイトを、文字コードに分ける（1文字のバイト数を、pdf.js が読んだ文字コードと照らして決める） */
export function splitCodes(bytes: Uint8Array, glyphs: SourceGlyph[]): (1 | 2)[] | null {
  const tryLen = (len: 1 | 2): (1 | 2)[] | null => {
    if (bytes.length !== glyphs.length * len) return null;
    for (let i = 0; i < glyphs.length; i++) {
      const code = len === 1 ? bytes[i] : bytes[i * 2] * 256 + bytes[i * 2 + 1];
      if (code !== glyphs[i].originalCharCode) return null;
    }
    return glyphs.map(() => len);
  };
  const same = tryLen(1) ?? tryLen(2);
  if (same) return same;
  // 1バイトと2バイトが混ざるフォント：文字コードの大きさで決め、全体のバイト数と中身が合うか確かめる
  const lens: (1 | 2)[] = [];
  let p = 0;
  for (const g of glyphs) {
    const len: 1 | 2 = g.originalCharCode > 0xff ? 2 : 1;
    const code = len === 1 ? bytes[p] : bytes[p] * 256 + bytes[p + 1];
    if (code !== g.originalCharCode) return null;
    lens.push(len);
    p += len;
  }
  return p === bytes.length ? lens : null;
}

export function computeTextRuns(input: TextRunsInput): TextRunsResult {
  const { ops, showTextGlyphs, setFontIds, fonts, toDisplay } = input;
  const runs: TextRun[] = [];
  let aligned = true;
  let showIndex = 0;
  let fontIndex = 0;
  const fontByName = new Map<string, string>();
  const stack: GState[] = [];
  let gs: GState = { ctm: IDENTITY, charSpacing: 0, wordSpacing: 0, hScale: 1, leading: 0, fontName: null, fontSize: 0, rise: 0 };
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  const markedStack: number[] = [];

  const nextLine = () => {
    tlm = mul([1, 0, 0, 1, 0, -gs.leading], tlm);
    tm = tlm;
  };

  const show = (opIndex: number, operator: string, strings: ContentValue[]) => {
    const glyphItems = showTextGlyphs[showIndex++];
    if (!glyphItems) {
      aligned = false;
      return;
    }
    const sourceGlyphs = glyphItems.filter((g): g is SourceGlyph => typeof g !== "number");
    const pdfjsFontId = gs.fontName ? fontByName.get(gs.fontName) : undefined;
    const info = pdfjsFontId ? fonts[pdfjsFontId] : undefined;
    let erasable = Boolean(info && !info.vertical && !info.unusualMatrix && gs.fontSize !== 0 && gs.hScale !== 0);
    const asc = info?.ascent || 0.88;
    const desc = info?.descent || -0.12;

    // 命令の中の文字列ごとに、文字のバイト数を決める
    const totalStringGlyphs: { bytes: Uint8Array; lens: (1 | 2)[] | null }[] = [];
    let gp = 0;
    const stringValues = strings.filter((s) => s.kind === "string") as Extract<ContentValue, { kind: "string" }>[];
    // pdf.js の文字の並びを、文字列ごとに割り当てる（文字列のバイト数から、文字の数を決める）
    for (const s of stringValues) {
      let lens: (1 | 2)[] | null = null;
      // 文字の数は、1バイトなら長さ、2バイトなら半分。両方を試して、文字コードが合うほうを選ぶ
      for (const count of [s.bytes.length, s.bytes.length / 2]) {
        if (!Number.isInteger(count)) continue;
        const part = sourceGlyphs.slice(gp, gp + count);
        if (part.length !== count) continue;
        const l = splitCodes(s.bytes, part);
        if (l) {
          lens = l;
          gp += count;
          break;
        }
      }
      if (!lens) {
        // 混ざるフォント：先頭から文字コードの大きさで割り当てる
        const part: SourceGlyph[] = [];
        let used = 0;
        let q = gp;
        while (used < s.bytes.length && q < sourceGlyphs.length) {
          used += sourceGlyphs[q].originalCharCode > 0xff ? 2 : 1;
          part.push(sourceGlyphs[q++]);
        }
        const l = used === s.bytes.length ? splitCodes(s.bytes, part) : null;
        if (l) {
          lens = l;
          gp = q;
        }
      }
      totalStringGlyphs.push({ bytes: s.bytes, lens });
      if (!lens) erasable = false;
    }
    if (gp !== sourceGlyphs.length || totalStringGlyphs.some((t) => !t.lens)) {
      aligned = false;
      erasable = false;
    }

    const glyphs: RunGlyph[] = [];
    let srcIndex = 0;
    const th = gs.hScale;
    const tfs = gs.fontSize;
    let stringNo = 0;
    for (const item of strings) {
      if (item.kind === "number") {
        const tx = (-item.value / 1000) * tfs * th;
        tm = mul([1, 0, 0, 1, tx, 0], tm);
        continue;
      }
      if (item.kind !== "string") continue;
      const lens = totalStringGlyphs[stringNo++]?.lens;
      let bp = 0;
      const glyphCount = lens ? lens.length : 0;
      for (let k = 0; k < glyphCount; k++) {
        const g = sourceGlyphs[srcIndex++];
        const len = lens![k];
        const code = len === 1 ? item.bytes[bp] : item.bytes[bp] * 256 + item.bytes[bp + 1];
        bp += len;
        const w = g?.width ?? 0;
        const trm = mul(mul([tfs * th, 0, 0, tfs, 0, gs.rise], tm), gs.ctm);
        const corners = [
          apply(trm, 0, desc),
          apply(trm, w / 1000, desc),
          apply(trm, 0, asc),
          apply(trm, w / 1000, asc),
        ].map(([x, y]) => toDisplay(x, y));
        const [bx, by] = toDisplay(...apply(trm, 0, 0));
        glyphs.push({
          unicode: g?.unicode ?? "",
          code,
          byteLen: len,
          width: w,
          x0: Math.min(...corners.map((c) => c[0])),
          x1: Math.max(...corners.map((c) => c[0])),
          y0: Math.min(...corners.map((c) => c[1])),
          y1: Math.max(...corners.map((c) => c[1])),
          baseX: bx,
          baseY: by,
        });
        const wordSp = len === 1 && code === 32 ? gs.wordSpacing : 0;
        const tx = ((w / 1000) * tfs + gs.charSpacing + wordSp) * th;
        tm = mul([1, 0, 0, 1, tx, 0], tm);
      }
    }
    // 画面での文字の高さ（回転していても大きさが分かるよう、縦方向の長さで測る）
    const trm0 = mul(mul([tfs * th, 0, 0, tfs, 0, 0], tm), gs.ctm);
    const [ox, oy] = toDisplay(...apply(trm0, 0, 0));
    const [ux, uy] = toDisplay(...apply(trm0, 0, 1));
    runs.push({
      opIndex,
      operator,
      glyphs,
      erasable,
      fontSize: tfs,
      charSpacing: gs.charSpacing,
      wordSpacing: gs.wordSpacing,
      displayFontSize: Math.hypot(ux - ox, uy - oy),
      enclosingMarkedContent: [...markedStack],
    });
  };

  ops.forEach((op, i) => {
    const o = op.operands;
    switch (op.operator) {
      case "q":
        stack.push({ ...gs });
        break;
      case "Q":
        gs = stack.pop() ?? gs;
        break;
      case "cm":
        gs = { ...gs, ctm: mul([num(o[0], 1), num(o[1]), num(o[2]), num(o[3], 1), num(o[4]), num(o[5])], gs.ctm) };
        break;
      case "BT":
        tm = IDENTITY;
        tlm = IDENTITY;
        break;
      case "Tc":
        gs = { ...gs, charSpacing: num(o[0]) };
        break;
      case "Tw":
        gs = { ...gs, wordSpacing: num(o[0]) };
        break;
      case "Tz":
        gs = { ...gs, hScale: num(o[0], 100) / 100 };
        break;
      case "TL":
        gs = { ...gs, leading: num(o[0]) };
        break;
      case "Ts":
        gs = { ...gs, rise: num(o[0]) };
        break;
      case "Tf": {
        const name = o[0] && o[0].kind === "name" ? o[0].value : null;
        const id = setFontIds[fontIndex++];
        if (name && id) fontByName.set(name, id);
        if (!id) aligned = false;
        gs = { ...gs, fontName: name, fontSize: num(o[1]) };
        break;
      }
      case "Td":
        tlm = mul([1, 0, 0, 1, num(o[0]), num(o[1])], tlm);
        tm = tlm;
        break;
      case "TD":
        gs = { ...gs, leading: -num(o[1]) };
        tlm = mul([1, 0, 0, 1, num(o[0]), num(o[1])], tlm);
        tm = tlm;
        break;
      case "Tm":
        tlm = [num(o[0], 1), num(o[1]), num(o[2]), num(o[3], 1), num(o[4]), num(o[5])];
        tm = tlm;
        break;
      case "T*":
        nextLine();
        break;
      case "Tj":
        show(i, "Tj", o.slice(0, 1));
        break;
      case "TJ":
        show(i, "TJ", o[0] && o[0].kind === "array" ? o[0].items : []);
        break;
      case "'":
        nextLine();
        show(i, "'", o.slice(0, 1));
        break;
      case '"':
        gs = { ...gs, wordSpacing: num(o[0]), charSpacing: num(o[1]) };
        nextLine();
        show(i, '"', o.slice(2, 3));
        break;
      case "BDC":
      case "BMC":
        markedStack.push(i);
        break;
      case "EMC":
        markedStack.pop();
        break;
      default:
        break;
    }
  });
  if (showIndex !== showTextGlyphs.length || fontIndex !== setFontIds.length) aligned = false;
  if (!aligned) for (const r of runs) r.erasable = false;
  return { runs, aligned };
}
