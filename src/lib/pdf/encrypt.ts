/**
 * PDFのパスワード保護(暗号化)。ブラウザ内のWeb Crypto APIだけで行い、ファイルは外部へ送信されない。
 *
 * 方式: PDF 2.0 の標準セキュリティハンドラ V5 / R6(AES-256)。
 *   - 現在もっとも強力な標準方式で、Acrobat X以降・macOSプレビュー・主要ブラウザ・PDF.js・qpdfなどで開ける。
 *   - 非常に古いビューア(Acrobat 8以前など)では開けない場合がある。
 * pdf-libには暗号化の書き込み機能がないため、pdf-libでオブジェクトを読み込み、
 * 文字列とストリームをAES-256-CBCで暗号化してから、暗号化辞書(/Encrypt)を付けて保存する。
 * AES-256(V5)ではオブジェクトごとの鍵を作る必要がなく、すべてのオブジェクトを同じファイル鍵で暗号化する。
 */
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFDocument,
} from "pdf-lib";

export interface PdfPermissions {
  /** 印刷を許可 */
  print: boolean;
  /** 文字・画像のコピー(抽出)を許可 */
  copy: boolean;
  /** 内容の編集・注釈・フォーム入力・ページ操作を許可 */
  modify: boolean;
}

export interface EncryptOptions {
  /** 開くときに必要なパスワード */
  userPassword: string;
  /** 権限(印刷・コピー・編集の制限)を変更するためのパスワード。空ならランダムに作る(=制限の解除はできなくなる) */
  ownerPassword?: string;
  permissions: PdfPermissions;
}

const subtle = (): SubtleCrypto => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("この環境では暗号化機能(Web Crypto)が使えません。HTTPSのページで開き直してください。");
  return s;
};

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** BufferSourceとして渡すための型調整(TypeScriptのUint8Array<ArrayBufferLike>対策) */
const buf = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

async function sha(bits: 256 | 384 | 512, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest(`SHA-${bits}`, buf(data)));
}

/** パディングなしのAES-CBC暗号化(入力は16バイトの倍数)。Web CryptoはPKCS#7を必ず付けるため、末尾の1ブロックを捨てる */
async function aesCbcNoPadding(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await subtle().importKey("raw", buf(key), "AES-CBC", false, ["encrypt"]);
  const out = new Uint8Array(await subtle().encrypt({ name: "AES-CBC", iv: buf(iv) }, k, buf(data)));
  return out.slice(0, data.length);
}

/** パスワードをUTF-8にし、127バイトまでに切る(PDF 2.0の規定) */
export function encodePassword(password: string): Uint8Array {
  return new TextEncoder().encode(password.normalize("NFC")).slice(0, 127);
}

/** PDF 2.0 Algorithm 2.B(ISO 32000-2): R6のパスワードハッシュ */
export async function hashR6(password: Uint8Array, salt: Uint8Array, udata: Uint8Array): Promise<Uint8Array> {
  let k = await sha(256, concat(password, salt, udata));
  let e: Uint8Array = new Uint8Array(0);
  let round = 0;
  while (round < 64 || e[e.length - 1] > round - 32) {
    const unit = concat(password, k, udata);
    const k1 = new Uint8Array(unit.length * 64);
    for (let i = 0; i < 64; i++) k1.set(unit, i * unit.length);
    e = await aesCbcNoPadding(k.slice(0, 16), k.slice(16, 32), k1);
    // 先頭16バイトを128ビットの整数とみなして3で割った余り(256≡1 mod 3 なのでバイトの総和の余りと等しい)
    let mod = 0;
    for (let i = 0; i < 16; i++) mod += e[i];
    mod %= 3;
    k = await sha(mod === 0 ? 256 : mod === 1 ? 384 : 512, e);
    round++;
  }
  return k.slice(0, 32);
}

/** 権限ビット(P)。上位ビットと予約ビットは1にする。符号付き32ビット整数で返す */
export function permissionBits(p: PdfPermissions): number {
  let bits = 0xfffff0c0;
  if (p.print) bits |= 4 | 2048; // 印刷・高品質印刷
  if (p.modify) bits |= 8 | 32 | 256 | 1024; // 編集・注釈・フォーム入力・ページの挿入削除
  if (p.copy) bits |= 16; // コピー
  bits |= 512; // 支援技術(読み上げ)のための抽出は常に許可する(アクセシビリティ)
  return bits | 0;
}

export interface EncryptionParams {
  fileKey: Uint8Array;
  O: Uint8Array;
  U: Uint8Array;
  OE: Uint8Array;
  UE: Uint8Array;
  Perms: Uint8Array;
  P: number;
}

export async function createEncryptionParams(options: EncryptOptions): Promise<EncryptionParams> {
  if (options.userPassword === "") throw new Error("パスワードを入力してください");
  const ownerPassword = options.ownerPassword && options.ownerPassword !== "" ? options.ownerPassword : bytesToHex(randomBytes(16));
  const user = encodePassword(options.userPassword);
  const owner = encodePassword(ownerPassword);
  const fileKey = randomBytes(32);
  const P = permissionBits(options.permissions);
  const empty = new Uint8Array(0);
  const zeroIv = new Uint8Array(16);

  // ユーザーパスワード: U(48バイト) と UE(ファイル鍵を暗号化したもの)
  const uValidation = randomBytes(8);
  const uKeySalt = randomBytes(8);
  const U = concat(await hashR6(user, uValidation, empty), uValidation, uKeySalt);
  const UE = await aesCbcNoPadding(await hashR6(user, uKeySalt, empty), zeroIv, fileKey);

  // オーナーパスワード: O と OE(Uを含めてハッシュする)
  const oValidation = randomBytes(8);
  const oKeySalt = randomBytes(8);
  const O = concat(await hashR6(owner, oValidation, U), oValidation, oKeySalt);
  const OE = await aesCbcNoPadding(await hashR6(owner, oKeySalt, U), zeroIv, fileKey);

  // Perms: 権限の改ざん検出用(AES-256-ECBの1ブロック。CBC・IVゼロの先頭ブロックと同じ)
  const block = new Uint8Array(16);
  new DataView(block.buffer).setInt32(0, P, true);
  block.set([0xff, 0xff, 0xff, 0xff], 4);
  block[8] = 0x54; // 'T' = メタデータも暗号化する
  block.set([0x61, 0x64, 0x62], 9); // 'adb'
  block.set(randomBytes(4), 12);
  const Perms = (await aesCbcNoPadding(fileKey, zeroIv, block)).slice(0, 16);

  return { fileKey, O, U, OE, UE, Perms, P };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 1つのデータをAES-256-CBCで暗号化する(先頭にランダムなIVを付ける) */
async function encryptBytes(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const iv = randomBytes(16);
  const cipher = new Uint8Array(await subtle().encrypt({ name: "AES-CBC", iv: buf(iv) }, key, buf(data)));
  return concat(iv, cipher);
}

/**
 * PDFDocumentを暗号化して保存したバイト列を返す。
 * 入力のdocは暗号化されていないPDFであること(暗号化済みPDFはあらかじめ拒否される)。
 * 呼び出し後のdocは暗号化済みの状態になるため、再利用しないこと。
 */
export async function encryptPdfDocument(doc: PDFDocument, options: EncryptOptions): Promise<Uint8Array> {
  const context = doc.context;
  if (context.trailerInfo.Encrypt) throw new Error("すでにパスワード保護されているPDFです");
  const params = await createEncryptionParams(options);
  const key = await subtle().importKey("raw", buf(params.fileKey), "AES-CBC", false, ["encrypt"]);

  async function encryptObject(obj: PDFObject): Promise<PDFObject> {
    if (obj instanceof PDFString || obj instanceof PDFHexString) {
      return PDFHexString.of(bytesToHex(await encryptBytes(key, obj.asBytes())));
    }
    if (obj instanceof PDFDict) {
      for (const [name, value] of obj.entries()) {
        if (value instanceof PDFRef) continue;
        const next = await encryptObject(value);
        if (next !== value) obj.set(name, next);
      }
      return obj;
    }
    if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) {
        const value = obj.get(i);
        if (value instanceof PDFRef) continue;
        const next = await encryptObject(value);
        if (next !== value) obj.set(i, next);
      }
      return obj;
    }
    return obj;
  }

  // オブジェクトストリーム・相互参照ストリームは、保存時にpdf-libが作り直す(平文のまま残さない)
  const entries = context.enumerateIndirectObjects();
  for (const [ref, obj] of entries) {
    if (obj instanceof PDFStream) {
      const type = obj.dict.get(PDFName.of("Type"));
      if (type === PDFName.of("ObjStm") || type === PDFName.of("XRef")) {
        context.delete(ref);
      }
    }
  }

  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (obj instanceof PDFStream) {
      await encryptObject(obj.dict);
      const contents = obj.getContents();
      const encrypted = await encryptBytes(key, contents);
      context.assign(ref, PDFRawStream.of(obj.dict, encrypted));
    } else {
      await encryptObject(obj);
    }
  }

  const encryptDict = context.obj({
    Filter: "Standard",
    V: 5,
    R: 6,
    Length: 256,
    CF: { StdCF: { AuthEvent: "DocOpen", CFM: "AESV3", Length: 32 } },
    StmF: "StdCF",
    StrF: "StdCF",
    O: PDFHexString.of(bytesToHex(params.O)),
    U: PDFHexString.of(bytesToHex(params.U)),
    OE: PDFHexString.of(bytesToHex(params.OE)),
    UE: PDFHexString.of(bytesToHex(params.UE)),
    Perms: PDFHexString.of(bytesToHex(params.Perms)),
    P: PDFNumber.of(params.P),
  });
  context.trailerInfo.Encrypt = context.register(encryptDict);
  if (!context.trailerInfo.ID) {
    context.trailerInfo.ID = context.obj([PDFHexString.of(bytesToHex(randomBytes(16))), PDFHexString.of(bytesToHex(randomBytes(16)))]);
  }

  return doc.save({ useObjectStreams: false, updateFieldAppearances: false, addDefaultPage: false });
}
