import type { ToolFaqItem } from "@/lib/seo/tool-content";

export function ToolFaq({ items }: { items: ToolFaqItem[] }) {
  if (items.length === 0) return null;
  return (
    <section className="mt-10">
      <h2 className="mb-4 text-lg font-semibold text-ms-text">よくある質問</h2>
      <div className="flex flex-col gap-3">
        {items.map((item) => (
          <details
            key={item.question}
            className="ms-glass group px-4 py-3"
          >
            <summary className="cursor-pointer text-sm font-medium text-ms-text marker:content-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ms-focus">
              {item.question}
            </summary>
            <p className="mt-2 text-sm leading-relaxed text-ms-muted">{item.answer}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
