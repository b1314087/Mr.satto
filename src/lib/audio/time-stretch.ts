/**
 * 音声の長さだけを変え、音の高さは変えない（タイムストレッチ）。2026-11-27（動画の再生速度変更）。
 *
 * 方式：WSOLA（波形の似ている位置を探して、少しずつ重ねてつなぐ方法）。
 * - 出力側は一定の間隔（hop）で、窓をかけた短い区間（フレーム）を重ねていく
 * - 入力側は速さに合わせた位置から区間を取るが、前の区間と自然につながるように、少しだけ前後にずらして
 *   いちばん波形が似ている位置を選ぶ（ずらす量は全チャンネル共通にして、左右の音がずれないようにする）
 * 純粋な計算だけで、ブラウザの機能は使わない（テストで、ブラウザなしに確かめられる）。
 */

/** フレームの長さ（秒）。話し声・音楽どちらにも無理の少ない長さ */
const FRAME_SEC = 0.04;
/** 位置を探す範囲（秒。前後それぞれ） */
const SEEK_SEC = 0.012;

export interface StretchOptions {
  /** 速さ（2 なら2倍速＝長さが半分。0.5 ならゆっくり＝長さが2倍） */
  speed: number;
  /** サンプリング周波数 */
  sampleRate: number;
  /** 途中で止めるか確かめる（重い計算の途中で、キャンセルに応える） */
  isCanceled?: () => boolean;
}

/**
 * 複数チャンネルの音声を、音の高さを保ったまま速さだけ変える。
 * 戻り値の長さは、おおよそ 元の長さ ÷ 速さ。
 */
export function timeStretch(channels: Float32Array[], { speed, sampleRate, isCanceled }: StretchOptions): Float32Array[] {
  if (channels.length === 0) return [];
  if (!(speed > 0) || !Number.isFinite(speed)) throw new Error("速さの指定が正しくありません。");
  const inLen = channels[0].length;
  const outLen = Math.max(1, Math.round(inLen / speed));
  if (Math.abs(speed - 1) < 1e-6) return channels.map((c) => c.slice());

  const frame = Math.max(64, Math.round(sampleRate * FRAME_SEC) & ~1);
  const hop = frame / 2; // 出力側の間隔（窓を半分ずつ重ねる）
  const seek = Math.max(8, Math.round(sampleRate * SEEK_SEC));
  const window = hann(frame);
  const out = channels.map(() => new Float32Array(outLen + frame));
  const weight = new Float32Array(outLen + frame);

  // 位置探しは、チャンネルを混ぜた1本の波形で行う（計算を軽くし、左右で同じずらし量にする）
  const mono = new Float32Array(inLen);
  for (const c of channels) for (let i = 0; i < inLen; i++) mono[i] += c[i] / channels.length;

  // 似ている位置の比べ方：前のフレームの「自然な続き」と、候補の位置の頭の部分を比べる
  const cmpLen = hop;
  const cmpStep = sampleRate >= 32000 ? 4 : 2; // 何サンプルおきに比べるか（軽くするため）
  const seekStep = 2;

  let prevIn = 0; // 前に使った入力の位置
  for (let outPos = 0, k = 0; outPos < outLen; outPos += hop, k++) {
    if (isCanceled && k % 256 === 0 && isCanceled()) throw new Error("canceled");
    const ideal = Math.round(outPos * speed);
    let best = ideal;
    if (k > 0) {
      const natural = prevIn + hop; // 前のフレームをそのまま続けた場合の位置
      let bestScore = -Infinity;
      for (let d = -seek; d <= seek; d += seekStep) {
        const cand = ideal + d;
        if (cand < 0 || cand + cmpLen >= inLen || natural + cmpLen >= inLen) continue;
        let score = 0;
        for (let i = 0; i < cmpLen; i += cmpStep) score += mono[cand + i] * mono[natural + i];
        if (score > bestScore) {
          bestScore = score;
          best = cand;
        }
      }
    }
    best = Math.max(0, Math.min(best, Math.max(0, inLen - 1)));
    for (let ch = 0; ch < channels.length; ch++) {
      const src = channels[ch];
      const dst = out[ch];
      for (let i = 0; i < frame; i++) {
        const si = best + i;
        if (si >= inLen) break;
        dst[outPos + i] += src[si] * window[i];
      }
    }
    for (let i = 0; i < frame; i++) weight[outPos + i] += window[i];
    prevIn = best;
  }

  // 窓の重なりで大きさがでこぼこにならないよう、重みで割ってそろえる
  return out.map((c) => {
    const r = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) r[i] = weight[i] > 1e-3 ? c[i] / weight[i] : 0;
    return r;
  });
}

function hann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}
