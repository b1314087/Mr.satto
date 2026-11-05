/**
 * 座席表：席の鍵（固定）とシャッフル。ブラウザ内の処理だけ。
 *
 * - 鍵をかけた席は、人も席もそのまま（シャッフル・入れ替え・「入力順に戻す」で動かない）。
 * - シャッフルは、鍵のかかっていない席どうしで、人（空席も含む）をランダムに並べ替える。
 * - 「入力順に戻す」は、鍵のかかった席はそのままにして、残りの人を入力順に、鍵のかかっていない席へ前から入れる。
 */

export type Slots = (number | null)[];

/** 0以上 n 未満の乱数（暗号用の乱数を使い、偏りを減らす） */
export function randomIndex(n: number): number {
  if (n <= 1) return 0;
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const limit = Math.floor(0x100000000 / n) * n;
    const buf = new Uint32Array(1);
    do crypto.getRandomValues(buf);
    while (buf[0] >= limit);
    return buf[0] % n;
  }
  return Math.floor(Math.random() * n);
}

/** 鍵のかかっていない席の人を並べ替える。並べ替えられる人が2人以上なら、元と同じ並びにはしない */
export function shuffleUnlocked(slots: Slots, locked: ReadonlySet<number>, rand: (n: number) => number = randomIndex): Slots {
  const free = slots.map((_, i) => i).filter((i) => !locked.has(i));
  const values = free.map((i) => slots[i]);
  const people = values.filter((v) => v !== null).length;
  if (people === 0 || free.length < 2) return slots.slice();
  for (let attempt = 0; attempt < 20; attempt++) {
    const order = values.slice();
    for (let k = order.length - 1; k > 0; k--) {
      const j = rand(k + 1);
      [order[k], order[j]] = [order[j], order[k]];
    }
    const next = slots.slice();
    free.forEach((i, k) => (next[i] = order[k]));
    if (next.some((v, i) => v !== slots[i])) return next;
  }
  return slots.slice();
}

/** 鍵のかかった席はそのまま、残りの人（participantCount 人のうち、鍵の席にいない人）を入力順に空いた席へ入れる */
export function fillAroundLocked(slots: Slots, locked: ReadonlySet<number>, participantCount: number): Slots {
  const next: Slots = slots.map((v, i) => (locked.has(i) ? v : null));
  const placed = new Set(next.filter((v): v is number => v !== null));
  let seat = 0;
  for (let id = 0; id < participantCount; id++) {
    if (placed.has(id)) continue;
    while (seat < next.length && (locked.has(seat) || next[seat] !== null)) seat++;
    if (seat >= next.length) break;
    next[seat] = id;
  }
  return next;
}

/** 鍵のかかっていない席に、2人以上がいるか（シャッフルできるか） */
export function canShuffle(slots: Slots, locked: ReadonlySet<number>): boolean {
  const free = slots.filter((_, i) => !locked.has(i));
  return free.length >= 2 && free.some((v) => v !== null);
}

/**
 * 「空席にした席」（だれも座らせない席）にいる人を、ほかの空いている席（空席にした席を除く）へ前から移す。
 * 移せる席がなければ、その人は席なしになる（画面で「席が足りません」と出る）。
 */
export function evictBlocked(slots: Slots, blocked: ReadonlySet<number>): Slots {
  if (blocked.size === 0) return slots;
  const next = slots.slice();
  const movers: number[] = [];
  blocked.forEach((i) => {
    const v = next[i];
    if (i < next.length && v !== null && v !== undefined) {
      movers.push(v);
      next[i] = null;
    }
  });
  if (movers.length === 0) return slots;
  movers.sort((a, b) => a - b);
  let seat = 0;
  for (const id of movers) {
    while (seat < next.length && (blocked.has(seat) || next[seat] !== null)) seat++;
    if (seat >= next.length) break;
    next[seat] = id;
  }
  return next;
}

/** 列の固定：縦の列（同じ左右の位置）だけ、または横の列（同じ前後の位置）だけで動かす */
export type AxisFix = "col" | "row";

/**
 * 位置（x または y）が近い席を、同じ列としてまとめる。返り値は席ごとの列の番号。
 * tolerance 以内の差は同じ列とみなす（席の大きさの半分ほど）。
 */
export function axisGroups(values: readonly number[], tolerance: number): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const group = Array<number>(values.length).fill(0);
  let g = -1;
  let last = Number.NEGATIVE_INFINITY;
  for (const { v, i } of order) {
    if (v - last > tolerance) g++;
    group[i] = g;
    last = v;
  }
  return group;
}

/**
 * 鍵・空席の席はそのまま、列を固定した人は同じ列の席の中だけで、ほかの人は自由に並べ替える。
 * - axisOf(人の番号)：その人の列の固定（なければ null）
 * - colOf / rowOf：席ごとの縦の列・横の列の番号（axisGroups）
 * 列を固定した人を先に、選べる席が少ない人から順に置く（行き詰まったら、やり直す）。
 * 並べ替えられる人が2人以上なら、元と同じ並びにはしない（どうしても同じになる場合はそのまま）。
 */
export function shuffleWithAxisFix(
  slots: Slots,
  locked: ReadonlySet<number>,
  axisOf: (personId: number) => AxisFix | null,
  colOf: readonly number[],
  rowOf: readonly number[],
  rand: (n: number) => number = randomIndex
): Slots {
  const free = slots.map((_, i) => i).filter((i) => !locked.has(i));
  const fixedPeople = free.filter((i) => slots[i] !== null && axisOf(slots[i]!) !== null);
  if (fixedPeople.length === 0) return shuffleUnlocked(slots, locked, rand);
  if (!canShuffle(slots, locked)) return slots.slice();

  const sameLine = (seat: number, other: number, axis: AxisFix) => (axis === "col" ? colOf[seat] === colOf[other] : rowOf[seat] === rowOf[other]);

  for (let attempt = 0; attempt < 40; attempt++) {
    const next: Slots = slots.slice();
    const taken = new Set<number>();
    // 選べる席が少ない人から置く
    const constrained = fixedPeople
      .map((seat) => {
        const id = slots[seat]!;
        const axis = axisOf(id)!;
        return { id, options: free.filter((s) => sameLine(s, seat, axis)) };
      })
      .sort((a, b) => a.options.length - b.options.length || rand(3) - 1);
    let ok = true;
    for (const { id, options } of constrained) {
      const open = options.filter((s) => !taken.has(s));
      if (open.length === 0) {
        ok = false;
        break;
      }
      const s = open[rand(open.length)];
      next[s] = id;
      taken.add(s);
    }
    if (!ok) continue;
    // 残りの人（空席も含む）を、残りの席へランダムに入れる
    const fixedIds = new Set(constrained.map((c) => c.id));
    const rest = free.map((i) => slots[i]).filter((v) => v === null || !fixedIds.has(v));
    for (let k = rest.length - 1; k > 0; k--) {
      const j = rand(k + 1);
      [rest[k], rest[j]] = [rest[j], rest[k]];
    }
    let r = 0;
    for (const s of free) {
      if (taken.has(s)) continue;
      next[s] = rest[r++] ?? null;
    }
    if (next.some((v, i) => v !== slots[i])) return next;
  }
  return slots.slice();
}
