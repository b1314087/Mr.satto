/**
 * テスト用：MKV・WebM（Matroska）ファイルから、トラックの一覧と、字幕トラック（WebVTT）の中身を読み出す。
 * mediabunny は字幕トラックを読み込まないため、ファイルの構造（EBML）を直接たどって確かめる。
 * テストで使う範囲（Segment・Info・Tracks・Cluster・SimpleBlock・BlockGroup）だけを読む。
 */

export interface MkvTrack {
  number: number;
  type: number; // 1=映像 2=音声 17=字幕
  codecId: string;
  language: string | null;
  name: string | null;
  codecPrivate: string | null;
  flagDefault: boolean | null;
}

export interface MkvBlock {
  track: number;
  /** 秒 */
  start: number;
  /** 秒（BlockDuration があれば） */
  duration: number | null;
  data: Buffer;
}

const ID = {
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  Language: 0x22b59c,
  LanguageBCP47: 0x22b59d,
  Name: 0x536e,
  FlagDefault: 0x88,
  Cluster: 0x1f43b675,
  Timestamp: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
};

const MASTERS = new Set([ID.Segment, ID.Info, ID.Tracks, ID.TrackEntry, ID.Cluster, ID.BlockGroup]);

function readVint(buf: Buffer, pos: number, keepMarker: boolean): { value: number; length: number; unknown: boolean } {
  const first = buf[pos];
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = (first & (0xff >> length)) === 0xff >> length;
  for (let i = 1; i < length; i++) {
    value = value * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

function readUint(buf: Buffer, start: number, size: number): number {
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + buf[start + i];
  return v;
}

export function parseMkv(buf: Buffer): { tracks: MkvTrack[]; blocks: MkvBlock[]; timestampScale: number } {
  const tracks: MkvTrack[] = [];
  const blocks: MkvBlock[] = [];
  let timestampScale = 1_000_000;
  let clusterTs = 0;
  let current: MkvTrack | null = null;
  let group: { data: Buffer | null; duration: number | null } | null = null;

  const pushBlock = (data: Buffer, duration: number | null) => {
    const tn = readVint(data, 0, false);
    const rel = data.readInt16BE(tn.length);
    blocks.push({
      track: tn.value,
      start: ((clusterTs + rel) * timestampScale) / 1e9,
      duration: duration === null ? null : (duration * timestampScale) / 1e9,
      data: data.subarray(tn.length + 3),
    });
  };

  const walk = (start: number, end: number, parent: number | null): number => {
    let pos = start;
    while (pos < end) {
      const id = readVint(buf, pos, true);
      // 長さ不明の Cluster の中で、次の Cluster が始まったら、親へ戻る
      if (parent === ID.Cluster && (id.value === ID.Cluster || id.value === ID.Tracks)) return pos;
      const size = readVint(buf, pos + id.length, false);
      const dataStart = pos + id.length + size.length;
      const dataEnd = size.unknown ? end : Math.min(end, dataStart + size.value);
      const v = id.value;
      if (MASTERS.has(v)) {
        if (v === ID.TrackEntry) current = { number: 0, type: 0, codecId: "", language: null, name: null, codecPrivate: null, flagDefault: null };
        if (v === ID.BlockGroup) group = { data: null, duration: null };
        const next = walk(dataStart, dataEnd, v);
        if (v === ID.TrackEntry && current) tracks.push(current);
        if (v === ID.BlockGroup && group?.data) pushBlock(group.data, group.duration);
        pos = size.unknown ? next : dataEnd;
        continue;
      }
      const data = buf.subarray(dataStart, dataEnd);
      if (v === ID.TimestampScale) timestampScale = readUint(buf, dataStart, dataEnd - dataStart);
      else if (v === ID.Timestamp && parent === ID.Cluster) clusterTs = readUint(buf, dataStart, dataEnd - dataStart);
      else if (current && parent === ID.TrackEntry) {
        if (v === ID.TrackNumber) current.number = readUint(buf, dataStart, dataEnd - dataStart);
        else if (v === ID.TrackType) current.type = readUint(buf, dataStart, dataEnd - dataStart);
        else if (v === ID.CodecID) current.codecId = data.toString("ascii");
        else if (v === ID.CodecPrivate) current.codecPrivate = data.toString("utf8");
        else if (v === ID.Language || v === ID.LanguageBCP47) current.language = data.toString("ascii");
        else if (v === ID.Name) current.name = data.toString("utf8");
        else if (v === ID.FlagDefault) current.flagDefault = readUint(buf, dataStart, dataEnd - dataStart) === 1;
      } else if (v === ID.SimpleBlock) pushBlock(Buffer.from(data), null);
      else if (group && parent === ID.BlockGroup) {
        if (v === ID.Block) group.data = Buffer.from(data);
        else if (v === ID.BlockDuration) group.duration = readUint(buf, dataStart, dataEnd - dataStart);
      }
      pos = dataEnd;
    }
    return pos;
  };

  // 先頭の EBML ヘッダーを飛ばしてから Segment を読む
  const headerId = readVint(buf, 0, true);
  const headerSize = readVint(buf, headerId.length, false);
  walk(headerId.length + headerSize.length + headerSize.value, buf.length, null);
  return { tracks, blocks, timestampScale };
}

/** 字幕トラック（WebVTT）のキュー（時間と文字） */
export function subtitleCuesOf(buf: Buffer): { track: MkvTrack | null; cues: { start: number; end: number; text: string }[] } {
  const { tracks, blocks } = parseMkv(buf);
  const track = tracks.find((t) => t.type === 17) ?? null;
  if (!track) return { track: null, cues: [] };
  const cues = blocks
    .filter((b) => b.track === track.number)
    .map((b) => ({ start: round3(b.start), end: round3(b.start + (b.duration ?? 0)), text: b.data.toString("utf8") }));
  return { track, cues };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
