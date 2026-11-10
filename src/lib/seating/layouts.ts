/**
 * 座席表の用途ごとの配置（席の位置と、名前を入れる順番）。ブラウザ内の計算だけ。
 *
 * 決まり（画面・書き出し・テストで共通）:
 * - seats の並び順が「名前を入れる順番」。入力した1人目が seats[0]（席番号1）に座る。
 * - 位置の単位は、書き出しの画像と同じ大きさの点（px）。画面のプレビューは、これを縮小して表示する。
 * - 会議（対面）は、端の議長席を1番にし、そこから近い順に左右（上下の列）へ交互に座らせる（役職の高い順に入力する想定）。
 */

export type Purpose = "meeting" | "meeting-u" | "group" | "classroom" | "round" | "custom";

export interface PurposeInfo {
  id: Purpose;
  name: string;
  /** 入力欄の見出しなどに使う短い説明（画面には出しすぎない） */
  short: string;
}

export const PURPOSES: PurposeInfo[] = [
  { id: "meeting", name: "会議（対面）", short: "長机・議長席あり" },
  { id: "meeting-u", name: "会議（コの字）", short: "前に向かってコの字" },
  { id: "group", name: "グループワーク", short: "島ごとに座る" },
  { id: "classroom", name: "授業", short: "教室の机の並び" },
  { id: "round", name: "懇親会（円卓）", short: "丸テーブル" },
  { id: "custom", name: "カスタム", short: "席を自由に置く" },
];

export interface LayoutParams {
  /** 会議（対面）：片側の席数／議長席の有無 */
  perSide: number;
  head: boolean;
  /** 会議（コの字）：正面の席数／左右それぞれの席数 */
  front: number;
  sides: number;
  /** グループワーク・円卓：テーブル（島）の数と、1テーブルの席数 */
  tables: number;
  perTable: number;
  /** グループワーク：島ごとに詰める（fill）か、1人ずつ順に配る（deal） */
  deal: boolean;
  /**
   * グループワーク：島を増やす方向。auto（省略時）は、これまでどおり島の数に合わせて並べる。
   * horizontal は、選んだときの段数のまま、増やした島を右へ（次の列の上の段から順に）並べる。
   * vertical は、選んだときの列数のまま、増やした島を下へ（次の段の左の列から順に）並べる。
   */
  groupFlow?: GroupFlow;
  /**
   * グループワーク：島の位置（[段, 列]、0始まり。島1から順）。増やす方向を選んだときの位置を覚えておき、
   * それより後に増やした島だけを、選んだ方向へ並べる（すでに置いた島は動かさない）
   */
  groupCells?: [number, number][];
  /** グループワーク：机（島の長机）の向き（横＝席が机の上下に並ぶ／縦＝席が机の左右に並ぶ）。省略時は横（これまでの向き） */
  groupDesk?: GroupDirection;
  /** 授業・カスタム：行（前から）と列 */
  rows: number;
  cols: number;
  /** 授業：横に（行ごと）並べるか、縦に（列ごと）並べるか */
  byColumn: boolean;
  /** カスタム：席にしないマス（"行-列"、0始まり） */
  holes: string[];
  /** 授業・カスタム：席番号1（名前を入れ始める席）の角。前の左・前の右・後ろの左・後ろの右（前を上にした図で） */
  start: SeatStart;
  /** 会議（対面・コの字）・カスタム：自由に置く卓・机（新工程1。位置・大きさは利用者が決める） */
  desks?: Desk[];
}

/**
 * 自由に置く卓・机（新工程1）。会議の卓を増やす・カスタムの机を置く、で共通に使う。
 * 位置（x・y）は、卓・机を置く前の座席表の座標（左上が0。書き出しの点と同じ単位）。席の位置は動かさない。
 */
export interface Desk {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 卓・机に書く名前（空欄なら何も書かない） */
  label: string;
}

export const DESK_LIMITS = {
  x: [-2000, 6000],
  y: [-2000, 6000],
  w: [30, 2000],
  h: [30, 1200],
} as const;
export const MAX_DESKS = 30;
export const DESK_LABEL_MAX = 20;

/** 卓・机を自由に置ける用途 */
export function supportsDesks(purpose: Purpose): boolean {
  return purpose === "meeting" || purpose === "meeting-u" || purpose === "custom";
}

/** 用途ごとの呼び方（会議は「卓」、カスタムは「机」） */
export function deskNoun(purpose: Purpose): string {
  return purpose === "custom" ? "机" : "卓";
}

export type GroupDirection = "horizontal" | "vertical";
export type GroupFlow = "auto" | GroupDirection;

export const GROUP_FLOW_OPTIONS: { value: GroupFlow; label: string }[] = [
  { value: "auto", label: "自動" },
  { value: "horizontal", label: "横に増やす" },
  { value: "vertical", label: "縦に増やす" },
];

/** これまでの並べ方：1段に並べる島の数を島の数で決め、左から右へ、端まで来たら次の段へ */
function autoGroupCells(tables: number): [number, number][] {
  const cols = Math.max(1, Math.min(tables, tables <= 4 ? 2 : tables <= 9 ? 3 : 4));
  return Array.from({ length: tables }, (_, t) => [Math.floor(t / cols), t % cols] as [number, number]);
}

/**
 * グループワークの島の位置（[段, 列]）。覚えておいた位置（groupCells）はそのまま使い、足りない分だけ、増やす方向へ足していく。
 * - 横に増やす：今ある段の数はそのまま。左の列から見て、空いているマスがある最初の列の、上の段から入れる（新しい列は、上の段から順に埋まる）
 * - 縦に増やす：今ある列の数はそのまま。上の段から見て、空いているマスがある最初の段の、左の列から入れる
 */
export function groupCellsOf(p: Pick<LayoutParams, "tables" | "groupFlow" | "groupCells">): [number, number][] {
  const flow = p.groupFlow ?? "auto";
  if (flow === "auto") return autoGroupCells(p.tables);
  const cells: [number, number][] = (p.groupCells ?? []).slice(0, p.tables).map(([r, c]) => [Math.max(0, Math.floor(r)), Math.max(0, Math.floor(c))]);
  const used = new Set<string>();
  const unique: [number, number][] = [];
  for (const cell of cells) {
    const k = `${cell[0]},${cell[1]}`;
    if (!used.has(k)) {
      used.add(k);
      unique.push(cell);
    }
  }
  while (unique.length < p.tables) {
    const rows = Math.max(1, ...unique.map(([r]) => r + 1));
    const cols = Math.max(1, ...unique.map(([, c]) => c + 1));
    let next: [number, number] | null = null;
    if (flow === "horizontal") {
      for (let c = 0; next === null; c++) for (let r = 0; r < rows && next === null; r++) if (!used.has(`${r},${c}`)) next = [r, c];
    } else {
      for (let r = 0; next === null; r++) for (let c = 0; c < cols && next === null; c++) if (!used.has(`${r},${c}`)) next = [r, c];
    }
    used.add(`${next[0]},${next[1]}`);
    unique.push(next);
  }
  return unique;
}

export const GROUP_DESK_OPTIONS: { value: GroupDirection; label: string }[] = [
  { value: "horizontal", label: "横向き（席は机の上下）" },
  { value: "vertical", label: "縦向き（席は机の左右）" },
];

export type SeatStart = "front-left" | "front-right" | "back-left" | "back-right";

export const SEAT_START_OPTIONS: { value: SeatStart; label: string }[] = [
  { value: "front-left", label: "前の左" },
  { value: "front-right", label: "前の右" },
  { value: "back-left", label: "後ろの左" },
  { value: "back-right", label: "後ろの右" },
];

export const DEFAULT_PARAMS: LayoutParams = {
  perSide: 4,
  head: true,
  front: 3,
  sides: 4,
  tables: 4,
  perTable: 6,
  deal: false,
  groupFlow: "auto",
  groupDesk: "horizontal",
  rows: 5,
  cols: 6,
  byColumn: false,
  holes: [],
  start: "front-left",
  desks: [],
};

export const LIMITS = {
  perSide: [1, 30],
  front: [1, 15],
  sides: [1, 30],
  tables: [1, 40],
  perTable: [2, 16],
  rows: [1, 20],
  cols: [1, 20],
} as const;

export const MAX_SEATS = 400;

export interface Seat {
  x: number;
  y: number;
  /** 書き出しの一覧に出す、席の場所（「テーブル2」「前から2列目」など） */
  group: string;
}

export type Shape =
  | { kind: "rect"; x: number; y: number; w: number; h: number; label?: string }
  | { kind: "circle"; cx: number; cy: number; r: number; label?: string };

export interface Mark {
  x: number;
  y: number;
  w: number;
  text: string;
}

export interface LayoutGeometry {
  seats: Seat[];
  shapes: Shape[];
  marks: Mark[];
  width: number;
  height: number;
}

export const SEAT_W = 132;
export const SEAT_H = 60;
const GAP = 14;
const PAD = 28;

function clamp(n: number, [min, max]: readonly [number, number]): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 人数に合わせた、用途ごとの席数 */
export function autoParams(purpose: Purpose, people: number, base: LayoutParams): LayoutParams {
  const n = Math.max(1, people);
  const p = { ...base };
  switch (purpose) {
    case "meeting":
      p.head = true;
      p.perSide = clamp(Math.ceil((n - 1) / 2), LIMITS.perSide);
      break;
    case "meeting-u":
      p.front = clamp(Math.min(3, n), LIMITS.front);
      p.sides = clamp(Math.ceil((n - p.front) / 2), LIMITS.sides);
      break;
    case "group":
      p.perTable = clamp(base.perTable || 6, LIMITS.perTable);
      p.tables = clamp(Math.ceil(n / p.perTable), LIMITS.tables);
      break;
    case "round":
      p.perTable = clamp(base.perTable || 8, LIMITS.perTable);
      p.tables = clamp(Math.ceil(n / p.perTable), LIMITS.tables);
      break;
    case "classroom":
      p.cols = clamp(base.cols || 6, LIMITS.cols);
      p.rows = clamp(Math.ceil(n / p.cols), LIMITS.rows);
      break;
    case "custom": {
      const cols = clamp(base.cols || 6, LIMITS.cols);
      p.cols = cols;
      // 通路にしたマスの分も足して、人数ぶんの席ができる行数にする
      let rows = Math.max(1, Math.ceil(n / cols));
      const holesIn = (r: number) => base.holes.filter((h) => Number(h.split("-")[0]) < r && Number(h.split("-")[1]) < cols).length;
      while (rows * cols - holesIn(rows) < n && rows < LIMITS.rows[1]) rows++;
      p.rows = clamp(rows, LIMITS.rows);
      break;
    }
  }
  return p;
}

/** 名前の行（範囲外の値を直した、有効な値） */
export function normalizeParams(p: LayoutParams): LayoutParams {
  return {
    ...p,
    perSide: clamp(p.perSide, LIMITS.perSide),
    front: clamp(p.front, LIMITS.front),
    sides: clamp(p.sides, LIMITS.sides),
    tables: clamp(p.tables, LIMITS.tables),
    perTable: clamp(p.perTable, LIMITS.perTable),
    rows: clamp(p.rows, LIMITS.rows),
    cols: clamp(p.cols, LIMITS.cols),
    desks: normalizeDesks(p.desks),
  };
}

/** 卓・机の値を、範囲の中に直す（数でないもの・多すぎる分は除く） */
export function normalizeDesks(desks: Desk[] | undefined): Desk[] {
  if (!Array.isArray(desks)) return [];
  return desks.slice(0, MAX_DESKS).map((d) => ({
    id: String(d.id),
    x: clamp(d.x, DESK_LIMITS.x),
    y: clamp(d.y, DESK_LIMITS.y),
    w: clamp(d.w, DESK_LIMITS.w),
    h: clamp(d.h, DESK_LIMITS.h),
    label: String(d.label ?? "").slice(0, DESK_LABEL_MAX),
  }));
}

/** 卓・机を、座席表に加える（席・ほかの図形の位置は変えない。はみ出す分だけ全体を広げる） */
export function withDesks(g: LayoutGeometry, desks: Desk[]): LayoutGeometry {
  if (desks.length === 0) return g;
  const shapes: Shape[] = [...g.shapes, ...desks.map((d): Shape => ({ kind: "rect", x: d.x, y: d.y, w: d.w, h: d.h, label: d.label || undefined }))];
  return finish(g.seats, shapes, g.marks);
}

/** 新しく置く卓・机（今の座席表の下に置く。大きさは、会議は長机・カスタムは机1つ分） */
export function newDesk(purpose: Purpose, base: LayoutGeometry, desks: Desk[], id: string): Desk {
  const custom = purpose === "custom";
  const w = custom ? SEAT_W : 240;
  const h = custom ? SEAT_H : 70;
  // 置いてある卓・机と、座席表の一番下より、さらに下に置く（重ならないように）
  let bottom = base.height - PAD;
  for (const d of desks) bottom = Math.max(bottom, d.y + d.h);
  return { id, x: PAD, y: bottom + GAP * 2, w, h, label: `${deskNoun(purpose)}${desks.length + 1}` };
}

function finish(seats: Seat[], shapes: Shape[], marks: Mark[]): LayoutGeometry {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const take = (x0: number, y0: number, x1: number, y1: number) => {
    minX = Math.min(minX, x0);
    minY = Math.min(minY, y0);
    maxX = Math.max(maxX, x1);
    maxY = Math.max(maxY, y1);
  };
  for (const s of seats) take(s.x, s.y, s.x + SEAT_W, s.y + SEAT_H);
  for (const sh of shapes) {
    if (sh.kind === "rect") take(sh.x, sh.y, sh.x + sh.w, sh.y + sh.h);
    else take(sh.cx - sh.r, sh.cy - sh.r, sh.cx + sh.r, sh.cy + sh.r);
  }
  for (const m of marks) take(m.x, m.y, m.x + m.w, m.y + 30);
  if (!Number.isFinite(minX)) return { seats, shapes, marks, width: 200, height: 100 };
  const dx = PAD - minX;
  const dy = PAD - minY;
  return {
    seats: seats.map((s) => ({ ...s, x: s.x + dx, y: s.y + dy })),
    shapes: shapes.map((sh) => (sh.kind === "rect" ? { ...sh, x: sh.x + dx, y: sh.y + dy } : { ...sh, cx: sh.cx + dx, cy: sh.cy + dy })),
    marks: marks.map((m) => ({ ...m, x: m.x + dx, y: m.y + dy })),
    width: maxX - minX + PAD * 2,
    height: maxY - minY + PAD * 2,
  };
}

function meeting(p: LayoutParams): LayoutGeometry {
  const n = p.perSide;
  const tableW = n * SEAT_W + (n - 1) * GAP + GAP * 2;
  const tableH = 70;
  const tableX = (p.head ? SEAT_W + GAP * 2 : 0);
  const tableY = SEAT_H + GAP;
  const shapes: Shape[] = [{ kind: "rect", x: tableX, y: tableY, w: tableW, h: tableH }];
  const seats: Seat[] = [];
  if (p.head) seats.push({ x: 0, y: tableY + tableH / 2 - SEAT_H / 2, group: "議長席" });
  for (let i = 0; i < n; i++) {
    const x = tableX + GAP + i * (SEAT_W + GAP);
    seats.push({ x, y: 0, group: `奥側 ${i + 1}番目` });
    seats.push({ x, y: tableY + tableH + GAP, group: `手前側 ${i + 1}番目` });
  }
  return finish(seats, shapes, []);
}

function meetingU(p: LayoutParams): LayoutGeometry {
  const seats: Seat[] = [];
  const f = p.front;
  const frontW = f * SEAT_W + (f - 1) * GAP;
  const sideX = 0;
  const innerX = SEAT_W + GAP * 2 + 40;
  const frontX = innerX + GAP;
  const frontY = 0;
  const tableTopY = SEAT_H + GAP;
  const sideTableW = 40;
  const sideStartY = tableTopY + 40 + GAP * 2;
  const totalW = frontX + frontW + GAP;
  const rightTableX = totalW;
  const rightX = rightTableX + sideTableW + GAP * 2;
  const sideLen = p.sides * SEAT_H + (p.sides - 1) * GAP;
  const shapes: Shape[] = [
    { kind: "rect", x: innerX - sideTableW, y: tableTopY, w: rightTableX - innerX + sideTableW * 2, h: 40 },
    { kind: "rect", x: innerX - sideTableW, y: tableTopY + 40, w: sideTableW, h: sideLen + GAP * 2 },
    { kind: "rect", x: rightTableX, y: tableTopY + 40, w: sideTableW, h: sideLen + GAP * 2 },
  ];
  // 正面は、真ん中から外へ交互に
  const order: number[] = [];
  const mid = (f - 1) / 2;
  const idx = Array.from({ length: f }, (_, i) => i).sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b);
  order.push(...idx);
  for (const i of order) seats.push({ x: frontX + i * (SEAT_W + GAP), y: frontY, group: `正面 ${i + 1}番目` });
  for (let i = 0; i < p.sides; i++) {
    const y = sideStartY + i * (SEAT_H + GAP);
    seats.push({ x: sideX, y, group: `左側 ${i + 1}番目` });
    seats.push({ x: rightX, y, group: `右側 ${i + 1}番目` });
  }
  const bottom = sideStartY + sideLen + GAP * 3;
  return finish(seats, shapes, [{ x: innerX, y: bottom, w: rightTableX - innerX, text: "前（スクリーン）" }]);
}

/** 円卓のまわりに並べた席が、互いに重ならない最小の半径 */
export function roundRing(perTable: number): number {
  for (let ring = 90; ring < 2000; ring += 4) {
    const pts = Array.from({ length: perTable }, (_, s) => {
      const a = -Math.PI / 2 + (2 * Math.PI * s) / perTable;
      return { x: Math.cos(a) * ring, y: Math.sin(a) * ring };
    });
    let ok = true;
    for (let i = 0; i < pts.length && ok; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        if (Math.abs(pts[i].x - pts[j].x) < SEAT_W + 6 && Math.abs(pts[i].y - pts[j].y) < SEAT_H + 6) {
          ok = false;
          break;
        }
      }
    }
    if (ok) return ring;
  }
  return 2000;
}

function islands(p: LayoutParams, round: boolean): LayoutGeometry {
  const cols = Math.min(p.tables, p.tables <= 4 ? 2 : p.tables <= 9 ? 3 : 4);
  const perTable = p.perTable;
  const seatsByTable: Seat[][] = [];
  const shapes: Shape[] = [];
  let cellW: number;
  let cellH: number;
  if (round) {
    const ring = roundRing(perTable);
    const r = Math.max(50, ring - SEAT_H / 2 - 24);
    cellW = ring * 2 + SEAT_W + GAP * 3;
    cellH = ring * 2 + SEAT_H + GAP * 3;
    for (let t = 0; t < p.tables; t++) {
      const cx = (t % cols) * cellW + cellW / 2;
      const cy = Math.floor(t / cols) * cellH + cellH / 2;
      shapes.push({ kind: "circle", cx, cy, r, label: `テーブル${t + 1}` });
      const list: Seat[] = [];
      for (let s = 0; s < perTable; s++) {
        const a = -Math.PI / 2 + (2 * Math.PI * s) / perTable;
        list.push({ x: cx + Math.cos(a) * ring - SEAT_W / 2, y: cy + Math.sin(a) * ring - SEAT_H / 2, group: `テーブル${t + 1}` });
      }
      seatsByTable.push(list);
    }
  } else {
    // 1つの島：机の片側に top 席、反対側に bottom 席
    const top = Math.ceil(perTable / 2);
    const bottom = perTable - top;
    const th = 56;
    const vertical = p.groupDesk === "vertical";
    // 机の長さ（席が並ぶ方向）と、島1つ分の大きさ（机と両側の席を含む）
    const along = vertical ? top * SEAT_H + (top - 1) * GAP + GAP * 2 : top * SEAT_W + (top - 1) * GAP + GAP * 2;
    const islandW = vertical ? SEAT_W * 2 + th + GAP * 2 : along;
    const islandH = vertical ? along : SEAT_H * 2 + th + GAP * 2;
    cellW = islandW + GAP * 5;
    cellH = islandH + GAP * 5;
    // 島の位置（[段, 列]）。増やす方向を選んでいなければ、これまでどおりの並び
    const cells = groupCellsOf(p);
    for (let t = 0; t < p.tables; t++) {
      const [gy, gx] = cells[t];
      const x0 = gx * cellW;
      const y0 = gy * cellH;
      const list: Seat[] = [];
      if (vertical) {
        const tableX = x0 + SEAT_W + GAP;
        shapes.push({ kind: "rect", x: tableX, y: y0, w: th, h: along, label: `島${t + 1}` });
        for (let s = 0; s < top; s++) list.push({ x: x0, y: y0 + GAP + s * (SEAT_H + GAP), group: `島${t + 1}` });
        for (let s = 0; s < bottom; s++) list.push({ x: tableX + th + GAP, y: y0 + GAP + s * (SEAT_H + GAP), group: `島${t + 1}` });
      } else {
        const tableY = y0 + SEAT_H + GAP;
        shapes.push({ kind: "rect", x: x0, y: tableY, w: along, h: th, label: `島${t + 1}` });
        for (let s = 0; s < top; s++) list.push({ x: x0 + GAP + s * (SEAT_W + GAP), y: y0, group: `島${t + 1}` });
        for (let s = 0; s < bottom; s++) list.push({ x: x0 + GAP + s * (SEAT_W + GAP), y: tableY + th + GAP, group: `島${t + 1}` });
      }
      seatsByTable.push(list);
    }
  }
  let seats: Seat[];
  if (!round && p.deal) {
    // 1人ずつ順に配る：島1の1席目、島2の1席目…
    seats = [];
    for (let s = 0; s < perTable; s++) for (let t = 0; t < p.tables; t++) seats.push(seatsByTable[t][s]);
  } else {
    seats = seatsByTable.flat();
  }
  return finish(seats, shapes, []);
}

function grid(p: LayoutParams, custom: boolean): LayoutGeometry {
  const holes = new Set(custom ? p.holes : []);
  // 席どうしの間隔は、縦も横も同じにする（通路の分の広い間隔は付けない）
  const xOf = (c: number) => c * (SEAT_W + GAP);
  const top = 30 + GAP * 3;
  const yOf = (r: number) => top + r * (SEAT_H + GAP);
  // 席番号1の角から、横に（または縦に）順番を付ける
  const start = p.start ?? "front-left";
  const rowOrder = Array.from({ length: p.rows }, (_, i) => (start.startsWith("back") ? p.rows - 1 - i : i));
  const colOrder = Array.from({ length: p.cols }, (_, i) => (start.endsWith("right") ? p.cols - 1 - i : i));
  const cells: { r: number; c: number }[] = [];
  if (!custom && p.byColumn) {
    for (const c of colOrder) for (const r of rowOrder) cells.push({ r, c });
  } else {
    for (const r of rowOrder) for (const c of colOrder) cells.push({ r, c });
  }
  const seats = cells
    .filter(({ r, c }) => !holes.has(`${r}-${c}`))
    .map(({ r, c }) => ({ x: xOf(c), y: yOf(r), group: `前から${r + 1}列目・左から${c + 1}番目` }));
  const width = xOf(p.cols - 1) + SEAT_W;
  const markW = Math.min(240, width);
  return finish(seats, [], [{ x: (width - markW) / 2, y: 0, w: markW, text: custom ? "前" : "教卓" }]);
}

export function buildLayout(purpose: Purpose, params: LayoutParams): LayoutGeometry {
  const p = normalizeParams(params);
  const base = buildBaseLayout(purpose, p);
  return supportsDesks(purpose) ? withDesks(base, p.desks ?? []) : base;
}

/** 卓・机を置く前の座席表 */
export function buildBaseLayout(purpose: Purpose, params: LayoutParams): LayoutGeometry {
  const p = normalizeParams(params);
  switch (purpose) {
    case "meeting":
      return meeting(p);
    case "meeting-u":
      return meetingU(p);
    case "group":
      return islands(p, false);
    case "round":
      return islands(p, true);
    case "classroom":
      return grid(p, false);
    case "custom":
      return grid(p, true);
  }
}

/**
 * 座席表の向きを逆にする（180度回す）。前（教卓・議長席など）が上の図を、前が下の図にする。
 * 先生・司会など、前から見た向きにするときに使う。左右も逆になる（前から見ると、生徒の右手が左に見えるため）。
 * 文字は回さない（読める向きのまま）。席の番号・人の割り当ては変えない。
 */
export function rotateLayout(g: LayoutGeometry): LayoutGeometry {
  const W = g.width;
  const H = g.height;
  return {
    ...g,
    seats: g.seats.map((s) => ({ ...s, x: W - s.x - SEAT_W, y: H - s.y - SEAT_H })),
    shapes: g.shapes.map((sh) => (sh.kind === "rect" ? { ...sh, x: W - sh.x - sh.w, y: H - sh.y - sh.h } : { ...sh, cx: W - sh.cx, cy: H - sh.cy })),
    marks: g.marks.map((m) => ({ ...m, x: W - m.x - m.w, y: H - m.y - 30 })),
  };
}
