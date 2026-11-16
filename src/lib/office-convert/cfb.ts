/**
 * 古い形式のOffice文書（.xls・.doc）の入れ物（複合ファイル形式。Compound File Binary / OLE2）を読む。
 *
 * .xls・.doc は、1つのファイルの中に、いくつかの「ストリーム」（Excelなら Workbook、Wordなら WordDocument・1Table・Data）が
 * 入った形になっている。ここでは、その中から名前でストリームを取り出すだけを行う（中身の解釈は xls-reader.ts・doc-reader.ts）。
 * 仕様：[MS-CFB]。ブラウザの中だけで動き、外部のライブラリは使わない。
 */

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const MAX_CHAIN = 1 << 22;

export class CfbError extends Error {}

export interface CfbEntry {
  name: string;
  type: number;
  start: number;
  size: number;
}

export class CfbFile {
  private readonly view: DataView;
  private readonly sectorSize: number;
  private readonly miniSectorSize: number;
  private readonly miniCutoff: number;
  private readonly fat: Uint32Array;
  private readonly miniFat: Uint32Array;
  readonly entries: CfbEntry[];
  private miniStream: Uint8Array | null = null;

  constructor(private readonly bytes: Uint8Array) {
    if (bytes.length < 512 || !SIGNATURE.every((b, i) => bytes[i] === b)) {
      throw new CfbError("古い形式のOffice文書（.xls・.doc）ではありません。");
    }
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const sectorShift = this.view.getUint16(0x1e, true);
    const miniShift = this.view.getUint16(0x20, true);
    if (sectorShift !== 9 && sectorShift !== 12) throw new CfbError("ファイルが壊れています（ヘッダーが正しくありません）。");
    this.sectorSize = 1 << sectorShift;
    this.miniSectorSize = 1 << miniShift;
    this.miniCutoff = this.view.getUint32(0x38, true) || 4096;
    const numFatSectors = this.view.getUint32(0x2c, true);
    const firstDirSector = this.view.getUint32(0x30, true);
    const firstMiniFat = this.view.getUint32(0x3c, true);
    const numMiniFat = this.view.getUint32(0x40, true);
    let difatSector = this.view.getUint32(0x44, true);
    const numDifat = this.view.getUint32(0x48, true);

    // FAT（どのセクターの次がどのセクターか）の場所の一覧を集める
    const fatSectors: number[] = [];
    for (let i = 0; i < 109 && fatSectors.length < numFatSectors; i++) {
      const s = this.view.getUint32(0x4c + i * 4, true);
      if (s !== FREESECT) fatSectors.push(s);
    }
    for (let n = 0; n < numDifat && difatSector !== ENDOFCHAIN && difatSector !== FREESECT; n++) {
      const off = this.sectorOffset(difatSector);
      const perSector = this.sectorSize / 4 - 1;
      for (let i = 0; i < perSector && fatSectors.length < numFatSectors; i++) {
        const s = this.view.getUint32(off + i * 4, true);
        if (s !== FREESECT) fatSectors.push(s);
      }
      difatSector = this.view.getUint32(off + perSector * 4, true);
    }
    const perFat = this.sectorSize / 4;
    this.fat = new Uint32Array(fatSectors.length * perFat);
    fatSectors.forEach((s, i) => {
      const off = this.sectorOffset(s);
      for (let j = 0; j < perFat; j++) this.fat[i * perFat + j] = this.view.getUint32(off + j * 4, true);
    });

    const miniFatBytes = numMiniFat > 0 && firstMiniFat !== ENDOFCHAIN ? this.readChain(firstMiniFat) : new Uint8Array(0);
    this.miniFat = new Uint32Array(Math.floor(miniFatBytes.length / 4));
    const mv = new DataView(miniFatBytes.buffer, miniFatBytes.byteOffset, miniFatBytes.byteLength);
    for (let i = 0; i < this.miniFat.length; i++) this.miniFat[i] = mv.getUint32(i * 4, true);

    const dir = this.readChain(firstDirSector);
    const dv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
    this.entries = [];
    for (let off = 0; off + 128 <= dir.length; off += 128) {
      const nameLen = dv.getUint16(off + 0x40, true);
      let name = "";
      for (let i = 0; i + 2 < nameLen && i < 64; i += 2) name += String.fromCharCode(dv.getUint16(off + i, true));
      const type = dir[off + 0x42];
      const start = dv.getUint32(off + 0x74, true);
      const size = dv.getUint32(off + 0x78, true);
      this.entries.push({ name, type, start, size });
    }
  }

  private sectorOffset(sector: number): number {
    const off = (sector + 1) * this.sectorSize;
    if (off >= this.bytes.length) throw new CfbError("ファイルが壊れています（途中で切れています）。");
    return off;
  }

  private readChain(start: number, size?: number): Uint8Array {
    const parts: number[] = [];
    const seen = new Set<number>();
    for (let s = start; s !== ENDOFCHAIN && s !== FREESECT; s = this.fat[s]) {
      if (s >= this.fat.length || seen.has(s) || parts.length > MAX_CHAIN) throw new CfbError("ファイルが壊れています（中の構造が正しくありません）。");
      seen.add(s);
      parts.push(s);
    }
    const out = new Uint8Array(parts.length * this.sectorSize);
    parts.forEach((s, i) => {
      const off = this.sectorOffset(s);
      out.set(this.bytes.subarray(off, Math.min(off + this.sectorSize, this.bytes.length)), i * this.sectorSize);
    });
    return size !== undefined ? out.subarray(0, Math.min(size, out.length)) : out;
  }

  private readMini(start: number, size: number): Uint8Array {
    if (!this.miniStream) {
      const root = this.entries[0];
      this.miniStream = root ? this.readChain(root.start, root.size) : new Uint8Array(0);
    }
    const out = new Uint8Array(size);
    let pos = 0;
    const seen = new Set<number>();
    for (let s = start; s !== ENDOFCHAIN && s !== FREESECT && pos < size; s = this.miniFat[s]) {
      if (s >= this.miniFat.length || seen.has(s)) throw new CfbError("ファイルが壊れています（中の構造が正しくありません）。");
      seen.add(s);
      const off = s * this.miniSectorSize;
      const n = Math.min(this.miniSectorSize, size - pos);
      out.set(this.miniStream.subarray(off, off + n), pos);
      pos += n;
    }
    return out;
  }

  /** 名前（大文字小文字を区別しない）でストリームを取り出す。無ければ null */
  stream(name: string): Uint8Array | null {
    const entry = this.entries.find((e) => e.type === 2 && e.name.toLowerCase() === name.toLowerCase());
    if (!entry) return null;
    return entry.size < this.miniCutoff ? this.readMini(entry.start, entry.size) : this.readChain(entry.start, entry.size);
  }

  has(name: string): boolean {
    return this.entries.some((e) => e.name.toLowerCase() === name.toLowerCase());
  }
}

export function isCfb(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && SIGNATURE.every((b, i) => bytes[i] === b);
}
