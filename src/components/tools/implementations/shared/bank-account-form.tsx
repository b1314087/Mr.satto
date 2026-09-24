"use client";

import type { BankAccountInfo } from "@/lib/documents/types";

const inputClass =
  "rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-neutral-700 dark:bg-neutral-900";

/**
 * 請求書専用: 振込先情報フォーム。
 * 請求書以外では表示しない（DOCUMENT_TYPE_META.showBankAccount で制御）。
 */
export function BankAccountForm({
  bankAccount,
  onChange,
}: {
  bankAccount: BankAccountInfo;
  onChange: (bankAccount: BankAccountInfo) => void;
}) {
  function set<K extends keyof BankAccountInfo>(key: K, value: string) {
    onChange({ ...bankAccount, [key]: value });
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
      <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">振込先情報（任意）</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <input
          value={bankAccount.bankName}
          onChange={(e) => set("bankName", e.target.value)}
          placeholder="金融機関名"
          className={inputClass}
        />
        <input
          value={bankAccount.branchName}
          onChange={(e) => set("branchName", e.target.value)}
          placeholder="支店名"
          className={inputClass}
        />
        <select
          value={bankAccount.accountType}
          onChange={(e) => set("accountType", e.target.value)}
          className={inputClass}
        >
          <option value="普通">普通</option>
          <option value="当座">当座</option>
        </select>
        <input
          value={bankAccount.accountNumber}
          onChange={(e) => set("accountNumber", e.target.value)}
          placeholder="口座番号"
          className={inputClass}
        />
      </div>
      <input
        value={bankAccount.accountHolder}
        onChange={(e) => set("accountHolder", e.target.value)}
        placeholder="口座名義"
        className={inputClass}
      />
    </div>
  );
}
