"use client";

import type { PartyInfo } from "@/lib/documents/types";

const inputClass =
  "rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-neutral-700 dark:bg-neutral-900";

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
      <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">{label}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <input
          value={party.companyName}
          onChange={(e) => set("companyName", e.target.value)}
          placeholder="会社名・屋号"
          className={inputClass}
        />
        <input
          value={party.contactName}
          onChange={(e) => set("contactName", e.target.value)}
          placeholder="担当者名"
          className={inputClass}
        />
        <input
          value={party.postalCode}
          onChange={(e) => set("postalCode", e.target.value)}
          placeholder="郵便番号（例: 123-4567）"
          className={inputClass}
        />
        <input
          value={party.tel}
          onChange={(e) => set("tel", e.target.value)}
          placeholder="電話番号"
          className={inputClass}
        />
      </div>
      <input
        value={party.address}
        onChange={(e) => set("address", e.target.value)}
        placeholder="住所"
        className={inputClass}
      />
      <input
        value={party.email}
        onChange={(e) => set("email", e.target.value)}
        placeholder="メールアドレス"
        type="email"
        className={inputClass}
      />
    </div>
  );
}
