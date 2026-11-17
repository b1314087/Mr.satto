import Link from "next/link";
import { FormSubmitButton } from "@/components/ui/form-submit-button";
import { acceptCurrentTermsAction } from "@/lib/legal/consent-actions";
import { TOOL_CONSENT_MESSAGE } from "@/lib/legal/consent";
import { LEGAL_VERSIONS, formatLegalVersion } from "@/lib/legal/versions";

/**
 * ログイン中で、現在の利用規約・プライバシーポリシーへの同意がまだの人に、ツールの代わりに出す同意の画面（2026-11-17）。
 * 同意すると、記録してから同じツールのページへ戻る（src/lib/legal/consent-actions.ts）。ログインしていない人には出さない。
 */
export function ToolConsentGate({ next }: { next: string }) {
  return (
    <form action={acceptCurrentTermsAction} className="flex flex-col gap-3" data-testid="tool-consent-gate">
      <input type="hidden" name="next" value={next} />
      <p className="text-base font-semibold text-ms-text">利用規約・プライバシーポリシーへの同意</p>
      <p className="text-sm leading-relaxed text-ms-muted">{TOOL_CONSENT_MESSAGE}</p>
      <label className="flex items-start gap-2 text-sm leading-relaxed text-ms-muted">
        <input type="checkbox" name="consent" required className="mt-1 h-4 w-4 shrink-0 rounded accent-[var(--ms-accent)]" data-testid="tool-consent-check" />
        <span>
          <Link href="/terms" target="_blank" rel="noopener noreferrer" className="text-ms-accent hover:underline dark:text-ms-focus">
            利用規約
          </Link>
          （{formatLegalVersion(LEGAL_VERSIONS.terms)}版）と
          <Link href="/privacy" target="_blank" rel="noopener noreferrer" className="text-ms-accent hover:underline dark:text-ms-focus">
            プライバシーポリシー
          </Link>
          （{formatLegalVersion(LEGAL_VERSIONS.privacy)}版）（どちらも新しいタブで開きます）を確認し、同意します。
        </span>
      </label>
      <FormSubmitButton className="ms-btn ms-btn-primary self-start" pendingLabel="記録しています...">
        同意してツールを使う
      </FormSubmitButton>
      <p className="text-xs text-ms-muted">同意は1回だけで大丈夫です。規約を改定したときは、あらためて同意をお願いします。</p>
    </form>
  );
}
