import type { ToolFaqItem } from "@/lib/seo/tool-content";

export function ToolFaq({ items }: { items: ToolFaqItem[] }) {
  if (items.length === 0) return null;
  return (
    <section className="mt-10">
      <h2 className="mb-4 text-lg font-semibold text-neutral-900 dark:text-white">よくある質問</h2>
      <div className="flex flex-col gap-3">
        {items.map((item) => (
          <details
            key={item.question}
            className="group rounded-lg border border-neutral-200 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900"
          >
            <summary className="cursor-pointer text-sm font-medium text-neutral-800 marker:content-none dark:text-neutral-100">
              {item.question}
            </summary>
            <p className="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">{item.answer}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
