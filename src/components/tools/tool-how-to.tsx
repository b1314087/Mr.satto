export function ToolHowTo({ steps }: { steps: string[] }) {
  if (steps.length === 0) return null;
  return (
    <section className="mt-10">
      <h2 className="mb-4 text-lg font-semibold text-ms-text">使い方</h2>
      <ol className="flex flex-col gap-3">
        {steps.map((step, index) => (
          <li key={index} className="flex gap-3 text-sm text-ms-muted">
            <span
              aria-hidden="true"
              className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-ms-accent/12 text-xs font-semibold text-ms-accent dark:text-ms-focus"
            >
              {index + 1}
            </span>
            <span className="pt-0.5">{step}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
