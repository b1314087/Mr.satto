import { StreamTarget, type StreamTargetChunk } from "mediabunny";

/**
 * 動画の書き出し先（動画編集 工程1：書き出し時のメモリ削減）。
 *
 * ■ これまで
 *   BufferTarget（出力全体を1つのArrayBufferに書き込む）と、MP4の fastStart="in-memory"
 *   （書き出しが終わるまで映像・音声のデータをすべてメモリに持つ）を使っていた。
 *   さらに保存用に new Blob([buffer]) でもう一度コピーするため、出力サイズの2〜3倍のメモリを一時的に使っていた。
 *
 * ■ これから
 *   mediabunny の StreamTarget で、出力を少しずつ（数MBずつ）受け取り、受け取ったそばから Blob の小片にする。
 *   - Blob の小片は、元の配列（Uint8Array）とは別に保存されるため、元の配列はすぐに手放せる
 *     （大きなデータは、ブラウザがメモリの外（ディスク）へ逃がせる）。
 *   - あとから前の位置への書き直し（ファイルの先頭の大きさの情報など）が来ても、Blob.slice()（コピーしない）で
 *     差し替えられる（下の BlobAssembler）。
 *   - 最後の Blob は小片を並べるだけで作る（中身をもう一度コピーしない）。
 *
 * ■ MP4の「Fast Start」（再生に必要な情報 moov をファイルの先頭に置くこと）
 *   StreamTarget では、moov はファイルの最後に書かれる（fastStart: false）。
 *   そのままでもパソコン・スマホの再生アプリで再生できるが、これまでどおり先頭に置くため、
 *   書き出しのあとで moov を先頭へ移し、データの位置の表（stco / co64）を moov の大きさだけずらす
 *   （moveMoovToFront。ffmpeg の「-movflags +faststart」や qt-faststart と同じ考え方）。
 *   映像・音声のデータ（mdat）は Blob.slice() で並べ替えるだけで、コピーしない。
 */

/** StreamTarget に渡す、1回の書き出しの大きさ（この大きさにまとめてから受け取る） */
const STREAM_CHUNK_SIZE = 4 * 1024 * 1024;

interface Segment {
  start: number;
  blob: Blob;
}

/**
 * 位置つきの書き込み（StreamTarget の chunk）を受け取り、1つの Blob に組み立てる。
 * 書き込みは基本的に後ろへの追加。前の位置への書き直しが来たときは、重なった部分だけを差し替える。
 */
export class BlobAssembler {
  private segments: Segment[] = [];
  private end = 0;

  /** 受け取ったバイト数（ファイルの大きさ） */
  get size(): number {
    return this.end;
  }

  write(position: number, data: Uint8Array): void {
    if (data.byteLength === 0) return;
    // 受け取ったデータは、すぐに Blob にする（mediabunny が元の配列を使い回しても影響を受けない）
    const blob = new Blob([data as BlobPart]);
    const writeEnd = position + data.byteLength;

    if (position >= this.end) {
      if (position > this.end) {
        // 間が空いた場合は0で埋める（通常は起きない）
        this.segments.push({ start: this.end, blob: new Blob([new Uint8Array(position - this.end)]) });
      }
      this.segments.push({ start: position, blob });
      this.end = writeEnd;
      return;
    }

    // 前の位置への書き直し：重なる小片を、重ならない部分（左・右）と新しいデータに分け直す
    const next: Segment[] = [];
    let inserted = false;
    for (const seg of this.segments) {
      const segEnd = seg.start + seg.blob.size;
      if (segEnd <= position || seg.start >= writeEnd) {
        if (!inserted && seg.start >= writeEnd) {
          next.push({ start: position, blob });
          inserted = true;
        }
        next.push(seg);
        continue;
      }
      if (seg.start < position) next.push({ start: seg.start, blob: seg.blob.slice(0, position - seg.start) });
      if (!inserted) {
        next.push({ start: position, blob });
        inserted = true;
      }
      if (segEnd > writeEnd) next.push({ start: writeEnd, blob: seg.blob.slice(writeEnd - seg.start) });
    }
    if (!inserted) next.push({ start: position, blob });
    this.segments = next;
    this.end = Math.max(this.end, writeEnd);
  }

  toBlob(type: string): Blob {
    return new Blob(
      this.segments.map((s) => s.blob),
      { type }
    );
  }

  /** キャンセル・失敗のとき、受け取った分を手放す */
  clear(): void {
    this.segments = [];
    this.end = 0;
  }
}

/** mediabunny の StreamTarget と、その書き込みを受け取る BlobAssembler を作る */
export function createBlobStreamTarget(): { target: StreamTarget; assembler: BlobAssembler } {
  const assembler = new BlobAssembler();
  const writable = new WritableStream<StreamTargetChunk>({
    write(chunk) {
      assembler.write(chunk.position, chunk.data);
    },
    abort() {
      assembler.clear();
    },
  });
  const target = new StreamTarget(writable, { chunked: true, chunkSize: STREAM_CHUNK_SIZE });
  return { target, assembler };
}

// ---------------------------------------------------------------------------
// MP4：moov を先頭へ移す（Fast Start）
// ---------------------------------------------------------------------------

interface BoxInfo {
  type: string;
  offset: number;
  size: number;
}

async function readTopLevelBoxes(blob: Blob): Promise<BoxInfo[] | null> {
  const boxes: BoxInfo[] = [];
  let offset = 0;
  while (offset < blob.size) {
    if (blob.size - offset < 8) return null;
    const header = new DataView(await blob.slice(offset, Math.min(blob.size, offset + 16)).arrayBuffer());
    let size = header.getUint32(0);
    const type = String.fromCharCode(header.getUint8(4), header.getUint8(5), header.getUint8(6), header.getUint8(7));
    if (size === 1) {
      if (header.byteLength < 16) return null;
      size = Number(header.getBigUint64(8));
    } else if (size === 0) {
      size = blob.size - offset;
    }
    if (size < 8 || offset + size > blob.size) return null;
    boxes.push({ type, offset, size });
    offset += size;
  }
  return boxes;
}

/** 中に箱（box）を持つ箱。データの位置の表（stco / co64）は moov > trak > mdia > minf > stbl の中にある */
const CONTAINER_BOXES = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "mvex"]);

/**
 * moov の中の stco（32ビット）・co64（64ビット）のすべての値に delta を足す。
 * 32ビットに収まらなくなる場合は false（呼び出し側は並べ替えをやめ、元のファイルのまま使う）。
 */
export function shiftChunkOffsets(buf: Uint8Array, delta: number): boolean {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const walk = (start: number, end: number): boolean => {
    let p = start;
    while (p + 8 <= end) {
      let size = view.getUint32(p);
      const type = String.fromCharCode(buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]);
      let headerSize = 8;
      if (size === 1) {
        if (p + 16 > end) return false;
        size = Number(view.getBigUint64(p + 8));
        headerSize = 16;
      } else if (size === 0) {
        size = end - p;
      }
      if (size < headerSize || p + size > end) return false;
      if (CONTAINER_BOXES.has(type)) {
        if (!walk(p + headerSize, p + size)) return false;
      } else if (type === "stco" || type === "co64") {
        const count = view.getUint32(p + headerSize + 4);
        const entryBytes = type === "stco" ? 4 : 8;
        let q = p + headerSize + 8;
        if (q + count * entryBytes > p + size) return false;
        for (let i = 0; i < count; i++, q += entryBytes) {
          if (type === "stco") {
            const v = view.getUint32(q) + delta;
            if (v > 0xffffffff) return false;
            view.setUint32(q, v);
          } else {
            view.setBigUint64(q, view.getBigUint64(q) + BigInt(delta));
          }
        }
      }
      p += size;
    }
    return true;
  };
  return walk(0, buf.byteLength);
}

/**
 * MP4の moov（再生に必要な情報）をファイルの先頭側（最初の mdat の前）へ移す。
 * すでに先頭にある・形が想定と違う・32ビットの位置の表に収まらない場合は、元の Blob をそのまま返す
 * （moov が最後にあっても、ファイルとしては正しく再生できる）。
 */
export async function moveMoovToFront(blob: Blob): Promise<Blob> {
  const boxes = await readTopLevelBoxes(blob);
  if (!boxes) return blob;
  const moovIndex = boxes.findIndex((b) => b.type === "moov");
  const mdatIndex = boxes.findIndex((b) => b.type === "mdat");
  if (moovIndex < 0 || mdatIndex < 0 || moovIndex < mdatIndex) return blob;
  const moov = boxes[moovIndex];
  const moovBytes = new Uint8Array(await blob.slice(moov.offset, moov.offset + moov.size).arrayBuffer());
  if (!shiftChunkOffsets(moovBytes, moov.size)) return blob;

  const parts: BlobPart[] = [];
  boxes.forEach((box, i) => {
    if (i === moovIndex) return;
    if (i === mdatIndex) parts.push(moovBytes);
    parts.push(blob.slice(box.offset, box.offset + box.size));
  });
  return new Blob(parts, { type: blob.type });
}
