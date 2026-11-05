/**
 * 座席表：席の条件（シャッフルのときに守る条件）。ブラウザ内の計算だけ。
 *
 * 条件は「人（名前）」に付ける。席に付ける鍵・空席とは別。
 * - apart：AさんとBさんを n 席以上離す（隣・前後・斜めの席は 1 席。縦・横の席の数の大きいほうで数える）
 * - near ：AさんとBさんを近くにする（隣、または前後）
 * - place：Aさんを、縦の列（左から）または横の列（前から）の from〜to 列目にする
 * - stay ：Aさんを、今の縦の列（または横の列）から動かさない（その列の中では動く）
 *
 * 列・行の番号は、席の位置から決める（axisGroups。左から・前から 0 始まり）。
 * 鍵の席・空席の席は動かさない。鍵の席の人に付いた条件は、その席の位置で判定する。
 */

import { randomIndex, type Slots } from "./arrange";

export type SeatRule =
  | { id: string; kind: "apart"; a: string; b: string; n: number }
  | { id: string; kind: "near"; a: string; b: string }
  | { id: string; kind: "place"; a: string; axis: "col" | "row"; from: number; to: number }
  | { id: string; kind: "stay"; a: string; axis: "col" | "row" };

export interface SeatGrid {
  /** 席ごとの縦の列の番号（左から 0 始まり） */
  col: readonly number[];
  /** 席ごとの横の列の番号（前から 0 始まり） */
  row: readonly number[];
}

/** 2つの席の離れ具合（縦・横の席の数の大きいほう。隣・前後・斜めは 1） */
export function seatDistance(g: SeatGrid, s: number, t: number): number {
  return Math.max(Math.abs(g.col[s] - g.col[t]), Math.abs(g.row[s] - g.row[t]));
}

/** 隣、または前後か */
export function isNear(g: SeatGrid, s: number, t: number): boolean {
  return Math.abs(g.col[s] - g.col[t]) + Math.abs(g.row[s] - g.row[t]) === 1;
}

/** 条件に出てくる人の名前 */
export function ruleNames(r: SeatRule): string[] {
  return r.kind === "apart" || r.kind === "near" ? [r.a, r.b] : [r.a];
}

/** 名簿にいる人だけの、有効な条件か（同じ人どうし・名簿にいない人の条件は使わない） */
export function isActiveRule(r: SeatRule, names: ReadonlySet<string>): boolean {
  if (!ruleNames(r).every((n) => n !== "" && names.has(n))) return false;
  if ((r.kind === "apart" || r.kind === "near") && r.a === r.b) return false;
  return true;
}

/**
 * ある並びで、条件を満たしているか。
 * seatOf：名前 → 席の番号（座っていなければ undefined）。stayFrom：stay の基準の席（シャッフル前の席）。
 */
export function ruleSatisfied(r: SeatRule, seatOf: (name: string) => number | undefined, g: SeatGrid, stayFrom?: (name: string) => number | undefined): boolean {
  const a = seatOf(r.a);
  if (a === undefined) return true;
  switch (r.kind) {
    case "apart": {
      const b = seatOf(r.b);
      return b === undefined || seatDistance(g, a, b) >= r.n;
    }
    case "near": {
      const b = seatOf(r.b);
      return b === undefined || isNear(g, a, b);
    }
    case "place": {
      const v = (r.axis === "col" ? g.col[a] : g.row[a]) + 1;
      return v >= r.from && v <= r.to;
    }
    case "stay": {
      const from = stayFrom?.(r.a);
      if (from === undefined) return true;
      return r.axis === "col" ? g.col[a] === g.col[from] : g.row[a] === g.row[from];
    }
  }
}

/** 今の並びで満たしていない条件 */
export function violatedRules(rules: readonly SeatRule[], slots: Slots, nameOf: (id: number) => string, g: SeatGrid): SeatRule[] {
  const seat = new Map<string, number>();
  slots.forEach((id, i) => {
    if (id !== null) seat.set(nameOf(id), i);
  });
  // stay は「今の列のまま」なので、今の並びでは必ず満たしている
  return rules.filter((r) => r.kind !== "stay" && !ruleSatisfied(r, (n) => seat.get(n), g));
}

export type ShuffleResult = { ok: true; slots: Slots } | { ok: false; slots: Slots };

/**
 * 鍵・空席の席はそのまま、条件をすべて満たすように、ほかの席の人をランダムに並べ替える。
 * 条件に出てくる人を先に（置ける席が少ない人から）置き、行き詰まったら戻ってやり直す（回数に上限あり）。
 * 見つからなければ ok: false と、元の並びを返す。並べ替えられる人が2人以上なら、元と同じ並びにはしない。
 */
export function shuffleWithRules(
  slots: Slots,
  fixed: ReadonlySet<number>,
  rules: readonly SeatRule[],
  nameOf: (id: number) => string,
  g: SeatGrid,
  rand: (n: number) => number = randomIndex
): ShuffleResult {
  const free = slots.map((_, i) => i).filter((i) => !fixed.has(i));
  const before = new Map<string, number>();
  slots.forEach((id, i) => {
    if (id !== null) before.set(nameOf(id), i);
  });
  const stayFrom = (n: string) => before.get(n);
  const fixedSeatOf = new Map<string, number>();
  slots.forEach((id, i) => {
    if (id !== null && fixed.has(i)) fixedSeatOf.set(nameOf(id), i);
  });

  // 条件に出てくる、動かせる人
  const movable = new Map<string, number>(); // 名前 → 人の番号
  free.forEach((i) => {
    const id = slots[i];
    if (id !== null) movable.set(nameOf(id), id);
  });
  const constrainedNames = [...new Set(rules.flatMap(ruleNames))].filter((n) => movable.has(n));
  const freeValues = free.map((i) => slots[i]);
  const peopleCount = freeValues.filter((v) => v !== null).length;

  // 1人だけで決まる条件（place・stay）で、置ける席を絞る
  const unaryOk = (name: string, seat: number) =>
    rules.every((r) => (r.kind === "place" || r.kind === "stay") && r.a === name ? ruleSatisfied(r, () => seat, g, stayFrom) : true);

  const shuffled = <T,>(xs: T[]): T[] => {
    const out = xs.slice();
    for (let k = out.length - 1; k > 0; k--) {
      const j = rand(k + 1);
      [out[k], out[j]] = [out[j], out[k]];
    }
    return out;
  };

  const tryOnce = (): Slots | null => {
    const placed = new Map<string, number>(fixedSeatOf);
    const taken = new Set<number>();
    const options = new Map(constrainedNames.map((n) => [n, free.filter((s) => unaryOk(n, s))]));
    const order = shuffled(constrainedNames).sort((x, y) => options.get(x)!.length - options.get(y)!.length);
    let budget = 4000;
    const pairOk = (name: string, seat: number) =>
      rules.every((r) => {
        if (r.kind !== "apart" && r.kind !== "near") return true;
        if (r.a !== name && r.b !== name) return true;
        const other = r.a === name ? r.b : r.a;
        const os = placed.get(other);
        if (os === undefined) return true;
        return r.kind === "apart" ? seatDistance(g, seat, os) >= r.n : isNear(g, seat, os);
      });
    const place = (k: number): boolean => {
      if (k === order.length) return true;
      const name = order[k];
      for (const s of shuffled(options.get(name)!)) {
        if (taken.has(s) || !pairOk(name, s)) continue;
        if (--budget < 0) return false;
        placed.set(name, s);
        taken.add(s);
        if (place(k + 1)) return true;
        placed.delete(name);
        taken.delete(s);
      }
      return false;
    };
    if (!place(0)) return null;
    const next: Slots = slots.slice();
    const constrainedIds = new Set(constrainedNames.map((n) => movable.get(n)!));
    for (const n of constrainedNames) next[placed.get(n)!] = movable.get(n)!;
    const rest = shuffled(freeValues.filter((v) => v === null || !constrainedIds.has(v)));
    let r = 0;
    for (const s of free) {
      if (taken.has(s)) continue;
      next[s] = rest[r++] ?? null;
    }
    // 鍵の席どうしの条件など、動かせない人だけの条件も確かめる
    const seat = new Map<string, number>();
    next.forEach((id, i) => {
      if (id !== null) seat.set(nameOf(id), i);
    });
    return rules.every((rule) => ruleSatisfied(rule, (n) => seat.get(n), g, stayFrom)) ? next : null;
  };

  let found: Slots | null = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    const next = tryOnce();
    if (!next) continue;
    found = next;
    if (peopleCount === 0 || free.length < 2 || next.some((v, i) => v !== slots[i])) return { ok: true, slots: next };
  }
  return found ? { ok: true, slots: found } : { ok: false, slots: slots.slice() };
}

/** 条件の説明（画面の一覧用） */
export function describeRule(r: SeatRule): string {
  switch (r.kind) {
    case "apart":
      return `${r.a}さんと${r.b}さんを${r.n}席以上離す`;
    case "near":
      return `${r.a}さんと${r.b}さんを近くにする`;
    case "place":
      return `${r.a}さんを${r.axis === "col" ? "左から" : "前から"}${r.from === r.to ? r.from : `${r.from}〜${r.to}`}列目にする`;
    case "stay":
      return `${r.a}さんを今の${r.axis === "col" ? "縦の列" : "横の列"}のままにする`;
  }
}
