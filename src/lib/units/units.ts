/**
 * 単位変換のデータと計算。
 *
 * 温度以外は「基準単位に対する倍率(factor)」で表し、
 * 値(基準単位) = 入力値 × 変換元のfactor、出力値 = 値(基準単位) ÷ 変換先のfactor で換算する。
 * 温度だけは倍率では表せないため、いったん摂氏(℃)へ直す専用の式を持つ。
 *
 * 換算係数は国際的な定義値、または日本の法令・慣習で定義されている値を使う
 * (例: 1インチ=25.4mm、1ポンド=0.45359237kg、1坪=400/121㎡、1畳(江戸間以外の一般的な不動産表示基準)=1.62㎡)。
 * 畳は部屋の規格(京間・江戸間・団地間)で大きさが異なるため、不動産公正取引協議会の表示基準
 * (1畳=1.62㎡以上)に合わせた「目安」の値であることを画面にも明記する。
 */

export interface UnitDef {
  id: string;
  label: string;
  /** 例: "km"、"㎡"。ラベルの補足として表示する */
  symbol: string;
  /** 基準単位に対する倍率。温度では使わない */
  factor: number;
}

export type UnitCategoryId =
  | "length"
  | "mass"
  | "temperature"
  | "area"
  | "volume"
  | "speed"
  | "time"
  | "data";

export interface UnitCategory {
  id: UnitCategoryId;
  label: string;
  /** 基準単位の説明 */
  baseLabel: string;
  units: UnitDef[];
  /** 補足(画面に表示) */
  note?: string;
}

export const UNIT_CATEGORIES: UnitCategory[] = [
  {
    id: "length",
    label: "長さ",
    baseLabel: "メートル(m)",
    units: [
      { id: "mm", label: "ミリメートル", symbol: "mm", factor: 0.001 },
      { id: "cm", label: "センチメートル", symbol: "cm", factor: 0.01 },
      { id: "m", label: "メートル", symbol: "m", factor: 1 },
      { id: "km", label: "キロメートル", symbol: "km", factor: 1000 },
      { id: "in", label: "インチ", symbol: "in", factor: 0.0254 },
      { id: "ft", label: "フィート", symbol: "ft", factor: 0.3048 },
      { id: "yd", label: "ヤード", symbol: "yd", factor: 0.9144 },
      { id: "mi", label: "マイル", symbol: "mi", factor: 1609.344 },
      { id: "nmi", label: "海里", symbol: "nmi", factor: 1852 },
      { id: "shaku", label: "尺", symbol: "尺", factor: 10 / 33 },
      { id: "ken", label: "間", symbol: "間", factor: 20 / 11 },
      { id: "ri", label: "里", symbol: "里", factor: 36 * 60 * (20 / 11) /* 1里=36町=2160間 */ },
    ],
  },
  {
    id: "mass",
    label: "重さ",
    baseLabel: "キログラム(kg)",
    units: [
      { id: "mg", label: "ミリグラム", symbol: "mg", factor: 0.000001 },
      { id: "g", label: "グラム", symbol: "g", factor: 0.001 },
      { id: "kg", label: "キログラム", symbol: "kg", factor: 1 },
      { id: "t", label: "トン", symbol: "t", factor: 1000 },
      { id: "oz", label: "オンス", symbol: "oz", factor: 0.028349523125 },
      { id: "lb", label: "ポンド", symbol: "lb", factor: 0.45359237 },
      { id: "momme", label: "匁(もんめ)", symbol: "匁", factor: 0.00375 },
      { id: "kan", label: "貫", symbol: "貫", factor: 3.75 },
    ],
  },
  {
    id: "temperature",
    label: "温度",
    baseLabel: "摂氏(℃)",
    units: [
      { id: "c", label: "摂氏", symbol: "℃", factor: 1 },
      { id: "f", label: "華氏", symbol: "℉", factor: 1 },
      { id: "k", label: "ケルビン", symbol: "K", factor: 1 },
    ],
    note: "温度は倍率ではなく式で換算します(華氏=摂氏×9/5+32、ケルビン=摂氏+273.15)。",
  },
  {
    id: "area",
    label: "面積",
    baseLabel: "平方メートル(㎡)",
    units: [
      { id: "mm2", label: "平方ミリメートル", symbol: "mm²", factor: 0.000001 },
      { id: "cm2", label: "平方センチメートル", symbol: "cm²", factor: 0.0001 },
      { id: "m2", label: "平方メートル", symbol: "㎡", factor: 1 },
      { id: "a", label: "アール", symbol: "a", factor: 100 },
      { id: "ha", label: "ヘクタール", symbol: "ha", factor: 10000 },
      { id: "km2", label: "平方キロメートル", symbol: "km²", factor: 1000000 },
      { id: "tsubo", label: "坪", symbol: "坪", factor: 400 / 121 },
      { id: "jo", label: "畳(目安1.62㎡)", symbol: "畳", factor: 1.62 },
      { id: "acre", label: "エーカー", symbol: "ac", factor: 4046.8564224 },
      { id: "ft2", label: "平方フィート", symbol: "ft²", factor: 0.09290304 },
    ],
    note: "畳は部屋の規格(京間・江戸間など)で大きさが異なります。ここでは不動産表示の目安である1畳=1.62㎡で換算します。",
  },
  {
    id: "volume",
    label: "体積",
    baseLabel: "リットル(L)",
    units: [
      { id: "ml", label: "ミリリットル", symbol: "mL", factor: 0.001 },
      { id: "l", label: "リットル", symbol: "L", factor: 1 },
      { id: "m3", label: "立方メートル", symbol: "m³", factor: 1000 },
      { id: "cm3", label: "立方センチメートル", symbol: "cm³", factor: 0.001 },
      { id: "tsp", label: "小さじ(日本)", symbol: "tsp", factor: 0.005 },
      { id: "tbsp", label: "大さじ(日本)", symbol: "tbsp", factor: 0.015 },
      { id: "cup", label: "カップ(日本の計量カップ)", symbol: "cup", factor: 0.2 },
      { id: "go", label: "合", symbol: "合", factor: 0.18039 },
      { id: "sho", label: "升", symbol: "升", factor: 1.8039 },
      { id: "galus", label: "ガロン(米)", symbol: "gal", factor: 3.785411784 },
      { id: "floz", label: "液量オンス(米)", symbol: "fl oz", factor: 0.0295735295625 },
    ],
  },
  {
    id: "speed",
    label: "速度",
    baseLabel: "メートル毎秒(m/s)",
    units: [
      { id: "ms", label: "メートル毎秒", symbol: "m/s", factor: 1 },
      { id: "kmh", label: "キロメートル毎時", symbol: "km/h", factor: 1000 / 3600 },
      { id: "mph", label: "マイル毎時", symbol: "mph", factor: 1609.344 / 3600 },
      { id: "kn", label: "ノット", symbol: "kn", factor: 1852 / 3600 },
      { id: "mach", label: "マッハ(海面・15℃)", symbol: "Ma", factor: 340.3 },
    ],
  },
  {
    id: "time",
    label: "時間",
    baseLabel: "秒(s)",
    units: [
      { id: "ms", label: "ミリ秒", symbol: "ms", factor: 0.001 },
      { id: "s", label: "秒", symbol: "s", factor: 1 },
      { id: "min", label: "分", symbol: "min", factor: 60 },
      { id: "h", label: "時間", symbol: "h", factor: 3600 },
      { id: "d", label: "日", symbol: "日", factor: 86400 },
      { id: "w", label: "週", symbol: "週", factor: 604800 },
    ],
    note: "月・年は日数が一定でないため含めていません。",
  },
  {
    id: "data",
    label: "データ容量",
    baseLabel: "バイト(B)",
    units: [
      { id: "b", label: "バイト", symbol: "B", factor: 1 },
      { id: "kb", label: "キロバイト(1000)", symbol: "KB", factor: 1000 },
      { id: "mb", label: "メガバイト(1000²)", symbol: "MB", factor: 1000 ** 2 },
      { id: "gb", label: "ギガバイト(1000³)", symbol: "GB", factor: 1000 ** 3 },
      { id: "tb", label: "テラバイト(1000⁴)", symbol: "TB", factor: 1000 ** 4 },
      { id: "kib", label: "キビバイト(1024)", symbol: "KiB", factor: 1024 },
      { id: "mib", label: "メビバイト(1024²)", symbol: "MiB", factor: 1024 ** 2 },
      { id: "gib", label: "ギビバイト(1024³)", symbol: "GiB", factor: 1024 ** 3 },
      { id: "tib", label: "テビバイト(1024⁴)", symbol: "TiB", factor: 1024 ** 4 },
      { id: "bit", label: "ビット", symbol: "bit", factor: 1 / 8 },
    ],
    note: "KB・MB・GBは1000倍、KiB・MiB・GiBは1024倍の単位です(OSやストレージ表記の違いの原因です)。",
  },
];

export function getUnitCategory(id: UnitCategoryId): UnitCategory {
  const found = UNIT_CATEGORIES.find((c) => c.id === id);
  if (!found) throw new Error(`未対応の単位の種類です: ${id}`);
  return found;
}

function toCelsius(value: number, unitId: string): number {
  if (unitId === "f") return ((value - 32) * 5) / 9;
  if (unitId === "k") return value - 273.15;
  return value;
}

function fromCelsius(value: number, unitId: string): number {
  if (unitId === "f") return (value * 9) / 5 + 32;
  if (unitId === "k") return value + 273.15;
  return value;
}

/** 値を変換する。単位が見つからない・値が数値でない場合は例外 */
export function convertUnit(category: UnitCategoryId, fromId: string, toId: string, value: number): number {
  if (!Number.isFinite(value)) throw new Error("数値を入力してください");
  const cat = getUnitCategory(category);
  const from = cat.units.find((u) => u.id === fromId);
  const to = cat.units.find((u) => u.id === toId);
  if (!from || !to) throw new Error("単位が見つかりません");
  if (category === "temperature") {
    const celsius = toCelsius(value, fromId);
    if (celsius < -273.15 - 1e-9) throw new Error("絶対零度(-273.15℃)より低い温度は指定できません");
    return fromCelsius(celsius, toId);
  }
  return (value * from.factor) / to.factor;
}

/**
 * 数値を読みやすい文字列にする。極端に大きい・小さい値は指数表記、
 * それ以外は有効数字10桁程度に丸めて末尾の0を取り除く(0.1+0.2のような浮動小数点の誤差を見せない)。
 */
export function formatUnitNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs >= 1e15 || abs < 1e-6) return value.toExponential(6).replace(/\.?0+e/, "e");
  const rounded = Number(value.toPrecision(10));
  return rounded.toLocaleString("ja-JP", { maximumFractionDigits: 10 });
}
