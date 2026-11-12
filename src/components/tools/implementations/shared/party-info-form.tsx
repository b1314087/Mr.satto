"use client";

import type { PartyInfo } from "@/lib/documents/types";

const inputClass =
  "rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-neutral-700 dark:bg-neutral-900";

/**
 * 入力欄1つ分（項目名のラベルを常に上に出す。入力すると消える見本の文字だけにしない）。
 * label で入力欄を囲んで、読み上げソフトにも項目名が伝わるようにする。
 */
export function LabeledField({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  autoComplete,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: "text" | "tel" | "email";
  autoComplete?: string;
  inputMode?: "numeric" | "text";
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-neutral-600 dark:text-neutral-300">
      {label}
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        inputMode={inputMode}
        className={`${inputClass} font-normal text-neutral-900 dark:text-neutral-100`}
      />
    </label>
  );
}

/**
 * 帳票共通: 発行者・宛先情報フォーム。
 * 発行者/宛先のどちらでも同じ項目構成のため、1つのコンポーネントを
 * label（見出し）を変えて2回使い回す。
 */
export function PartyInfoForm({
  label,
  party,
  onChange,
}: {
  label: string;
  party: PartyInfo;
  onChange: (party: PartyInfo) => void;
}) {
  function set<K extends keyof PartyInfo>(key: K, value: string) {
    onChange({ ...party, [key]: value });
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
      {/* 見出し（「② 宛先」など）と同じ内容なので、画面には出さず、読み上げだけに残す */}
      <p className="sr-only">{label}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <LabeledField label="会社名・屋号" value={party.companyName} onChange={(v) => set("companyName", v)} placeholder="例: 株式会社サンプル" autoComplete="organization" />
        <LabeledField label="担当者名" value={party.contactName} onChange={(v) => set("contactName", v)} placeholder="例: 山田 太郎" autoComplete="name" />
        <LabeledField label="郵便番号" value={party.postalCode} onChange={(v) => set("postalCode", v)} placeholder="例: 123-4567" autoComplete="postal-code" inputMode="numeric" />
        <LabeledField label="電話番号" value={party.tel} onChange={(v) => set("tel", v)} placeholder="例: 03-1234-5678" autoComplete="tel" type="tel" />
      </div>
      <LabeledField label="住所" value={party.address} onChange={(v) => set("address", v)} placeholder="例: 東京都千代田区丸の内1-1-1" autoComplete="street-address" />
      <LabeledField label="メールアドレス" value={party.email} onChange={(v) => set("email", v)} placeholder="例: info@example.com" autoComplete="email" type="email" />
    </div>
  );
}
