"use client";

import type { BankAccountInfo } from "@/lib/documents/types";
import { Segmented } from "@/components/ui/segmented";

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
    <div className="flex flex-col gap-3">
      <p className="sr-only">振込先情報（任意）</p>
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
        <Segmented
          ariaLabel="口座の種類"
          wide
          value={bankAccount.accountType === "当座" ? "当座" : "普通"}
          onChange={(v) => set("accountType", v)}
          options={[
            { value: "普通", label: "普通" },
            { value: "当座", label: "当座" },
          ]}
        />
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
