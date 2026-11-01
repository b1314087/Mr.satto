/**
 * 2つの並び（行・段落など）の、共通部分と違う部分を求める（Myersの差分アルゴリズム）。
 * 違いが多すぎて計算が重くなるとき（maxEdits を超えるとき）は null を返し、呼び出し側で別の方法に切り替える。
 */
export type DiffOp = { type: "equal"; a: number; b: number } | { type: "delete"; a: number } | { type: "insert"; b: number };

export function diffSequences<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean, maxEdits = 2000): DiffOp[] | null {
  const n = a.length;
  const m = b.length;
  // 先頭と末尾の同じ部分は、先に取り除く（計算を軽くする）
  let start = 0;
  while (start < n && start < m && eq(a[start], b[start])) start++;
  let endA = n;
  let endB = m;
  while (endA > start && endB > start && eq(a[endA - 1], b[endB - 1])) {
    endA--;
    endB--;
  }
  const midOps = myers(a, b, start, endA, start, endB, eq, maxEdits);
  if (midOps === null) return null;
  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ type: "equal", a: i, b: i });
  ops.push(...midOps);
  for (let i = 0; i < n - endA; i++) ops.push({ type: "equal", a: endA + i, b: endB + i });
  return ops;
}

function myers<T>(a: T[], b: T[], a0: number, a1: number, b0: number, b1: number, eq: (x: T, y: T) => boolean, maxEdits: number): DiffOp[] | null {
  const n = a1 - a0;
  const m = b1 - b0;
  if (n === 0 && m === 0) return [];
  if (n === 0) return Array.from({ length: m }, (_, i) => ({ type: "insert", b: b0 + i }) as DiffOp);
  if (m === 0) return Array.from({ length: n }, (_, i) => ({ type: "delete", a: a0 + i }) as DiffOp);
  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // 各回の v（k = -d〜d の範囲だけ）を残す。範囲だけを残すので、メモリは違いの数の2乗程度で済む
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && eq(a[a0 + x], b[b0 + y])) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  if (!found) return null;
  // 経路をさかのぼって、操作の並びにする（trace[d] は、d回目を始める前の v。添字は k + d）
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d];
    const get = (k: number) => (k < -d || k > d ? 0 : vd[k + d]);
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && get(k - 1) < get(k + 1))) prevK = k + 1;
    else prevK = k - 1;
    const prevX = d === 0 ? 0 : get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: "equal", a: a0 + x - 1, b: b0 + y - 1 });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ type: "insert", b: b0 + y - 1 });
      else ops.push({ type: "delete", a: a0 + x - 1 });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

/**
 * 差分の操作を、「同じ部分」と「違う部分のかたまり（削除された側・追加された側）」に分ける。
 * 違う部分のかたまりは、並んでいる削除と追加を1組にする（あとで「変更」として対応づけるため）。
 */
export type DiffChunk = { type: "equal"; a: number; b: number } | { type: "change"; deleted: number[]; inserted: number[] };

export function groupChunks(ops: DiffOp[]): DiffChunk[] {
  const chunks: DiffChunk[] = [];
  let del: number[] = [];
  let ins: number[] = [];
  const flush = () => {
    if (del.length || ins.length) chunks.push({ type: "change", deleted: del, inserted: ins });
    del = [];
    ins = [];
  };
  for (const op of ops) {
    if (op.type === "equal") {
      flush();
      chunks.push(op);
    } else if (op.type === "delete") del.push(op.a);
    else ins.push(op.b);
  }
  flush();
  return chunks;
}

/** 文字単位の違い（画面で、変わった文字に印を付けるため）。長すぎる・違いが多すぎるときは null */
export type CharSpan = { type: "equal" | "delete" | "insert"; text: string };

export function diffChars(before: string, after: string): CharSpan[] | null {
  const a = Array.from(before);
  const b = Array.from(after);
  if (a.length + b.length > 6000) return null;
  const ops = diffSequences(a, b, (x, y) => x === y, 600);
  if (!ops) return null;
  const spans: CharSpan[] = [];
  for (const op of ops) {
    const type = op.type;
    const ch = op.type === "insert" ? b[op.b] : a[op.a];
    const last = spans[spans.length - 1];
    if (last && last.type === type) last.text += ch;
    else spans.push({ type, text: ch });
  }
  return spans;
}
