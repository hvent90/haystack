import type { ReactNode } from "react";

export function StatGrid({ rows }: { rows: Array<[string, string]> }): ReactNode {
  return (
    <dl className="stat-grid">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
