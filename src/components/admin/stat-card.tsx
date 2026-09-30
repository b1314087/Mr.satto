export function StatCard({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <p className="text-xs text-neutral-400 dark:text-neutral-500">{label}</p>
      <p className="mt-1 text-2xl font-bold text-neutral-900 dark:text-white">{value}</p>
      {note && <p className="mt-1 text-[11px] text-neutral-400 dark:text-neutral-500">{note}</p>}
    </div>
  );
}
