/**
 * 座席表作成（席順の自動作成・条件の判定・手動の入れ替え）。ブラウザ内の処理だけ。
 *
 * 決まり（画面の説明・テストと同じ）:
 * - 参加者は全員、どこかの席に1回だけ座る（重複・欠落なし）。席数（テーブルごとの席数の合計）を超える人数は配置しない。
 * - 条件は3種類。「同じテーブルにしたい人」「別々のテーブルにしたい人（全員が別のテーブル）」「テーブル（と席）を固定する人」。
 * - すべての条件を満たす配置を探す。満たせないときは、配置せずに、どの条件が衝突しているかを説明する（条件を無視して配置しない）。
 * - 乱数は、番号（seed）から作る。同じ番号・同じ条件なら同じ結果、番号を変えると別の結果になる（席順の再抽選）。
 *   条件のない人どうしの並びは、すべて同じ確率で決まる（特定の人が有利・不利にならない）。
 * - 席の割り当て方は2通り。「均等」はできるだけ各テーブルの埋まり具合をそろえ、「前から詰める」は1番のテーブルから順に埋める。
 *   テーブルの中では、席の番号の若い方から人を座らせ、空席は後ろに寄せる（固定した席の人を除く）。
 */
import { nameKey, type Participant } from "./participants";

export type BalanceMode = "even" | "fill";

export interface SeatingSetup {
  /** テーブルごとの席数（長さ＝テーブル数） */
  tableSizes: number[];
  balance: BalanceMode;
}

export interface FixedSeat {
  name: string;
  /** テーブル番号（1始まり） */
  table: number;
  /** 席番号（1始まり）。省略すると、そのテーブルのどこかの席 */
  seat?: number;
}

export interface SeatingConstraints {
  /** 同じテーブルにしたい人たち（名前）。ルールごとに1つの配列 */
  together: string[][];
  /** 別々のテーブルにしたい人たち（名前）。ルールごとに1つの配列。全員が互いに別のテーブルになる */
  apart: string[][];
  fixed: FixedSeat[];
}

/** 席順。tables[テーブル番号-1][席番号-1] が、座る人の id（空席は null） */
export interface SeatingPlan {
  tables: (number | null)[][];
}

export interface SeatRef {
  table: number;
  seat: number;
}

export type ArrangeResult =
  | { ok: true; plan: SeatingPlan; seed: number }
  | { ok: false; reason: "invalid"; messages: string[] }
  | { ok: false; reason: "shortage"; message: string; shortBy: number; seats: number }
  | { ok: false; reason: "conflict"; messages: string[] };

export const EMPTY_CONSTRAINTS: SeatingConstraints = { together: [], apart: [], fixed: [] };

/** 条件を探す回数・1回で探す手数の上限 */
const MAX_ATTEMPTS = 25;
const NODE_BUDGET = 20000;

/** 条件の欄に書かれた名前（「、」「,」「;」「/」・改行で区切る。名前の中の空白では区切らない） */
export function parseRuleNames(text: string): string[] {
  return text
    .split(/[\r\n,、，;；/／]/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s !== "");
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rand: () => number): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function listNames(names: string[], max = 4): string {
  const shown = names.slice(0, max).map((n) => `「${n}」`).join("、");
  return names.length > max ? `${shown}など` : shown;
}

/** 席数が足りないときの説明（何席足りないか・どうすれば足りるか） */
export function shortageMessage(people: number, seats: number, tableCount: number, seatsPerTable: number): string {
  const shortBy = people - seats;
  const needTables = seatsPerTable > 0 ? Math.ceil(people / seatsPerTable) : tableCount + 1;
  return `席が足りません。参加者${people}人に対して、席は${seats}席です（あと${shortBy}席必要です）。テーブルを${Math.max(needTables, tableCount + 1)}卓にするか、1テーブルの席数を増やしてください。`;
}

export function totalSeats(sizes: number[]): number {
  return sizes.reduce((sum, n) => sum + n, 0);
}

interface Failure {
  depth: number;
  unit: number;
  reasons: string[];
}

export function arrangeSeating(
  participants: Participant[],
  setup: SeatingSetup,
  constraints: SeatingConstraints,
  seed: number
): ArrangeResult {
  const sizes = setup.tableSizes;
  const tableCount = sizes.length;
  if (tableCount < 1 || sizes.some((s) => !Number.isInteger(s) || s < 1)) {
    return { ok: false, reason: "invalid", messages: ["テーブル数と、各テーブルの席数（1以上）を設定してください。"] };
  }
  if (participants.length === 0) {
    return { ok: false, reason: "invalid", messages: ["参加者がいません。名前を入力するか、ファイルを読み込んでください。"] };
  }
  const seats = totalSeats(sizes);
  if (participants.length > seats) {
    const per = Math.max(...sizes);
    return {
      ok: false,
      reason: "shortage",
      message: shortageMessage(participants.length, seats, tableCount, per),
      shortBy: participants.length - seats,
      seats,
    };
  }

  const n = participants.length;
  const indexByKey = new Map<string, number>();
  participants.forEach((p, i) => {
    const key = nameKey(p.name);
    if (!indexByKey.has(key)) indexByKey.set(key, i);
  });

  const invalid: string[] = [];
  const conflicts: string[] = [];
  const resolve = (name: string, label: string): number => {
    const idx = indexByKey.get(nameKey(name));
    if (idx === undefined) {
      invalid.push(`「${name}」は参加者の名簿にありません（${label}）。名前を確認してください。`);
      return -1;
    }
    return idx;
  };
  const resolveGroup = (names: string[], label: string): number[] => {
    const seen = new Set<number>();
    for (const name of names) {
      const idx = resolve(name, label);
      if (idx >= 0) seen.add(idx);
    }
    return [...seen];
  };

  const together = constraints.together.map((g, i) => resolveGroup(g, `同じテーブルにしたい人の${i + 1}つ目`)).filter((g) => g.length >= 2);
  const apart = constraints.apart.map((g, i) => resolveGroup(g, `別々にしたい人の${i + 1}つ目`)).filter((g) => g.length >= 2);

  // 固定席
  const fixedOf = new Map<number, { table: number; seat?: number }>();
  const seatTaken = new Map<string, number>();
  constraints.fixed.forEach((f, i) => {
    const label = `固定する人の${i + 1}つ目`;
    if (f.name.trim() === "") return;
    const idx = resolve(f.name, label);
    if (idx < 0) return;
    if (!Number.isInteger(f.table) || f.table < 1 || f.table > tableCount) {
      invalid.push(`「${f.name}」を固定するテーブル番号は、1〜${tableCount}で指定してください。`);
      return;
    }
    if (f.seat !== undefined && (!Number.isInteger(f.seat) || f.seat < 1 || f.seat > sizes[f.table - 1])) {
      invalid.push(`「${f.name}」の席番号は、テーブル${f.table}の席数（${sizes[f.table - 1]}席）以内で指定してください。`);
      return;
    }
    const before = fixedOf.get(idx);
    if (before && (before.table !== f.table - 1 || before.seat !== f.seat)) {
      conflicts.push(`「${f.name}」が、異なる場所に重ねて固定されています。固定は1人につき1つにしてください。`);
      return;
    }
    fixedOf.set(idx, { table: f.table - 1, seat: f.seat });
    if (f.seat !== undefined) {
      const key = `${f.table - 1}-${f.seat}`;
      const other = seatTaken.get(key);
      if (other !== undefined && other !== idx) {
        conflicts.push(`「${participants[other].name}」と「${f.name}」が、どちらもテーブル${f.table}の席${f.seat}に固定されています。`);
      } else {
        seatTaken.set(key, idx);
      }
    }
  });

  if (invalid.length > 0) return { ok: false, reason: "invalid", messages: invalid };

  // 同じテーブルにしたい人 → まとまり（unit）にする
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (const g of together) for (let i = 1; i < g.length; i++) parent[find(g[i])] = find(g[0]);
  const unitOfRoot = new Map<number, number>();
  const unitMembers: number[][] = [];
  const unitOf = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const root = find(i);
    let u = unitOfRoot.get(root);
    if (u === undefined) {
      u = unitMembers.length;
      unitOfRoot.set(root, u);
      unitMembers.push([]);
    }
    unitMembers[u].push(i);
    unitOf[i] = u;
  }
  const unitCount = unitMembers.length;
  const unitNames = (u: number) => unitMembers[u].map((i) => participants[i].name);

  // 固定とまとまりの整合
  const unitFixed = new Array<number>(unitCount).fill(-1);
  const unitFixedBy = new Array<number>(unitCount).fill(-1);
  for (const [idx, f] of fixedOf) {
    const u = unitOf[idx];
    if (unitFixed[u] >= 0 && unitFixed[u] !== f.table) {
      conflicts.push(
        `「${participants[unitFixedBy[u]].name}」と「${participants[idx].name}」は同じテーブルにしたい条件なのに、テーブル${unitFixed[u] + 1}とテーブル${f.table + 1}に固定されています。`
      );
      continue;
    }
    unitFixed[u] = f.table;
    if (unitFixedBy[u] < 0) unitFixedBy[u] = idx;
  }

  // 別々にしたい人
  const neighbors: Set<number>[] = Array.from({ length: unitCount }, () => new Set<number>());
  for (const g of apart) {
    const units = new Set(g.map((i) => unitOf[i]));
    if (units.size > tableCount) {
      conflicts.push(
        `別々のテーブルにしたい${units.size}組（${listNames(g.map((i) => participants[i].name))}）には、少なくとも${units.size}つのテーブルが必要ですが、テーブルは${tableCount}つです。`
      );
    }
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        const a = unitOf[g[i]];
        const b = unitOf[g[j]];
        if (a === b) {
          conflicts.push(
            `「${participants[g[i]].name}」と「${participants[g[j]].name}」は、同じテーブルにしたい条件と、別々にしたい条件の両方に入っています（同じテーブルにしたい人どうしの組み合わせを通じて）。どちらかを外してください。`
          );
        } else {
          neighbors[a].add(b);
          neighbors[b].add(a);
        }
      }
    }
  }
  for (let a = 0; a < unitCount; a++) {
    for (const b of neighbors[a]) {
      if (a < b && unitFixed[a] >= 0 && unitFixed[a] === unitFixed[b]) {
        conflicts.push(
          `「${participants[unitMembers[a][0]].name}」と「${participants[unitMembers[b][0]].name}」は別々のテーブルにしたいのに、どちらもテーブル${unitFixed[a] + 1}に固定されています。`
        );
      }
    }
  }

  // 席数
  const maxSize = Math.max(...sizes);
  const fixedLoad = new Array<number>(tableCount).fill(0);
  for (let u = 0; u < unitCount; u++) {
    const size = unitMembers[u].length;
    if (unitFixed[u] >= 0) {
      fixedLoad[unitFixed[u]] += size;
    } else if (size > maxSize) {
      conflicts.push(`同じテーブルにしたい${size}人（${listNames(unitNames(u))}）が、最も席数の多いテーブル（${maxSize}席）にも入りません。`);
    }
  }
  fixedLoad.forEach((load, t) => {
    if (load > sizes[t]) {
      conflicts.push(`テーブル${t + 1}に固定された人（同じテーブルにしたい人を含めて${load}人）が、席数（${sizes[t]}席）を超えています。`);
    }
  });
  if (conflicts.length > 0) return { ok: false, reason: "conflict", messages: dedupe(conflicts) };

  // 探索（ランダムな順序での深さ優先。手数の上限つき。何度かやり直す）
  const freeUnits: number[] = [];
  for (let u = 0; u < unitCount; u++) if (unitFixed[u] < 0) freeUnits.push(u);
  let best: Failure | null = null;
  let tableOf: number[] | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS && !tableOf; attempt++) {
    const rand = mulberry32((seed + attempt * 7919) >>> 0);
    const assigned = new Array<number>(unitCount).fill(-1);
    const load = new Array<number>(tableCount).fill(0);
    for (let u = 0; u < unitCount; u++) {
      if (unitFixed[u] >= 0) {
        assigned[u] = unitFixed[u];
        load[unitFixed[u]] += unitMembers[u].length;
      }
    }
    const jitter = new Map<number, number>();
    for (const u of freeUnits) jitter.set(u, rand());
    const order = freeUnits
      .slice()
      .sort((a, b) => unitMembers[b].length - unitMembers[a].length || neighbors[b].size - neighbors[a].size || (jitter.get(a) as number) - (jitter.get(b) as number));
    let nodes = 0;

    const dfs = (depth: number): boolean => {
      if (depth === order.length) return true;
      if (++nodes > NODE_BUDGET) return false;
      const u = order[depth];
      const size = unitMembers[u].length;
      const candidates: { t: number; key: number; tie: number }[] = [];
      const reasons: string[] = [];
      for (let t = 0; t < tableCount; t++) {
        if (load[t] + size > sizes[t]) {
          reasons.push(`テーブル${t + 1}: 席が足りません（残り${sizes[t] - load[t]}席）`);
          continue;
        }
        let blocker: number | null = null;
        for (const v of neighbors[u]) {
          if (assigned[v] === t) {
            blocker = v;
            break;
          }
        }
        if (blocker !== null) {
          reasons.push(`テーブル${t + 1}: 「${participants[unitMembers[blocker][0]].name}」と別々にしたい条件`);
          continue;
        }
        candidates.push({
          t,
          key: setup.balance === "even" ? (load[t] + size) / sizes[t] : t,
          tie: rand(),
        });
      }
      if (candidates.length === 0) {
        if (!best || depth >= best.depth) best = { depth, unit: u, reasons };
        return false;
      }
      candidates.sort((a, b) => a.key - b.key || a.tie - b.tie);
      for (const c of candidates) {
        assigned[u] = c.t;
        load[c.t] += size;
        if (dfs(depth + 1)) return true;
        load[c.t] -= size;
        assigned[u] = -1;
        if (nodes > NODE_BUDGET) return false;
      }
      return false;
    };

    if (dfs(0)) tableOf = assigned;
  }

  if (!tableOf) {
    const messages = ["すべての条件を満たす席順が見つかりませんでした。条件が多すぎるか、席数に余裕がない可能性があります。"];
    const failure = best as Failure | null;
    if (failure) {
      const names = unitNames(failure.unit);
      messages.push(`例: ${listNames(names)}を置けるテーブルがありませんでした。${failure.reasons.join(" ／ ")}`);
    }
    messages.push("条件を減らす、または席数・テーブル数を増やして、もう一度お試しください。");
    return { ok: false, reason: "conflict", messages };
  }

  // 席の割り当て（テーブルの中。固定席の人はその席、ほかの人は若い席番号から順に）
  const rand = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const members: number[][] = Array.from({ length: tableCount }, () => []);
  for (let u = 0; u < unitCount; u++) for (const i of unitMembers[u]) members[tableOf[u]].push(i);
  const tables: (number | null)[][] = [];
  for (let t = 0; t < tableCount; t++) {
    const row = new Array<number | null>(sizes[t]).fill(null);
    const rest: number[] = [];
    for (const i of members[t]) {
      const f = fixedOf.get(i);
      if (f && f.seat !== undefined) row[f.seat - 1] = participants[i].id;
      else rest.push(i);
    }
    let seat = 0;
    for (const i of shuffle(rest, rand)) {
      while (row[seat] !== null) seat++;
      row[seat] = participants[i].id;
    }
    tables.push(row);
  }
  return { ok: true, plan: { tables }, seed };
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

/** 席順の確認。重複・欠落・席数の食い違いがあれば、その説明を返す（問題がなければ空） */
export function validatePlan(plan: SeatingPlan, participants: Participant[], tableSizes: number[]): string[] {
  const errors: string[] = [];
  if (plan.tables.length !== tableSizes.length) errors.push("テーブルの数が設定と違います。");
  plan.tables.forEach((row, t) => {
    if (row.length !== tableSizes[t]) errors.push(`テーブル${t + 1}の席数が設定と違います。`);
  });
  const known = new Set(participants.map((p) => p.id));
  const seen = new Set<number>();
  for (const row of plan.tables) {
    for (const id of row) {
      if (id === null) continue;
      if (!known.has(id)) errors.push("名簿にない人が席に入っています。");
      else if (seen.has(id)) errors.push(`「${participants.find((p) => p.id === id)?.name}」が2つの席に入っています。`);
      seen.add(id);
    }
  }
  for (const p of participants) if (!seen.has(p.id)) errors.push(`「${p.name}」の席がありません。`);
  return dedupe(errors);
}

/** 2つの席を入れ替える（片方が空席なら、移動）。元の席順は変更しない。どちらかが範囲外なら、そのまま返す */
export function swapSeats(plan: SeatingPlan, a: SeatRef, b: SeatRef): SeatingPlan {
  const valid = (r: SeatRef) => r.table >= 0 && r.table < plan.tables.length && r.seat >= 0 && r.seat < plan.tables[r.table].length;
  if (!valid(a) || !valid(b)) return plan;
  const tables = plan.tables.map((row) => row.slice());
  const tmp = tables[a.table][a.seat];
  tables[a.table][a.seat] = tables[b.table][b.seat];
  tables[b.table][b.seat] = tmp;
  return { tables };
}

/** 席順が、条件を満たしているかを調べる（手動で入れ替えたあとの注意表示用）。守られていない条件の説明を返す */
export function evaluateConstraints(plan: SeatingPlan, participants: Participant[], constraints: SeatingConstraints): string[] {
  const tableOfId = new Map<number, number>();
  const seatOfId = new Map<number, number>();
  plan.tables.forEach((row, t) =>
    row.forEach((id, s) => {
      if (id !== null) {
        tableOfId.set(id, t);
        seatOfId.set(id, s);
      }
    })
  );
  const byKey = new Map<string, Participant>();
  for (const p of participants) if (!byKey.has(nameKey(p.name))) byKey.set(nameKey(p.name), p);
  const find = (name: string) => byKey.get(nameKey(name));
  const out: string[] = [];

  for (const g of constraints.together) {
    const people = [...new Set(g.map(find).filter((p): p is Participant => !!p))];
    if (people.length < 2) continue;
    const tables = new Set(people.map((p) => tableOfId.get(p.id)));
    if (tables.size > 1) out.push(`同じテーブルにしたい${listNames(people.map((p) => p.name))}が、別のテーブルになっています。`);
  }
  for (const g of constraints.apart) {
    const people = [...new Set(g.map(find).filter((p): p is Participant => !!p))];
    for (let i = 0; i < people.length; i++) {
      for (let j = i + 1; j < people.length; j++) {
        const ti = tableOfId.get(people[i].id);
        if (ti !== undefined && ti === tableOfId.get(people[j].id)) {
          out.push(`別々にしたい「${people[i].name}」と「${people[j].name}」が、同じテーブル（テーブル${ti + 1}）になっています。`);
        }
      }
    }
  }
  for (const f of constraints.fixed) {
    const p = find(f.name);
    if (!p) continue;
    const t = tableOfId.get(p.id);
    if (t === undefined) continue;
    if (t !== f.table - 1) out.push(`「${p.name}」はテーブル${f.table}に固定する条件ですが、テーブル${t + 1}にいます。`);
    else if (f.seat !== undefined && seatOfId.get(p.id) !== f.seat - 1) out.push(`「${p.name}」は席${f.seat}に固定する条件ですが、別の席にいます。`);
  }
  return dedupe(out);
}
