"use client";

import type { BankAccountInfo } from "@/lib/documents/types";
import { Segmented } from "@/components/ui/segmented";
import { LabeledField } from "./party-info-form";

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
        <LabeledField label="金融機関名" value={bankAccount.bankName} onChange={(v) => set("bankName", v)} placeholder="例: サンプル銀行" />
        <LabeledField label="支店名" value={bankAccount.branchName} onChange={(v) => set("branchName", v)} placeholder="例: 本店営業部" />
        <div className="flex min-w-0 flex-col gap-1 text-xs font-medium text-neutral-600 dark:text-neutral-300">
          <span aria-hidden="true">口座の種類</span>
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
        </div>
        <LabeledField label="口座番号" value={bankAccount.accountNumber} onChange={(v) => set("accountNumber", v)} placeholder="例: 1234567" inputMode="numeric" />
      </div>
      <LabeledField label="口座名義" value={bankAccount.accountHolder} onChange={(v) => set("accountHolder", v)} placeholder="例: カ）サンプル" />
    </div>
  );
}
