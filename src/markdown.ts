// Small Markdown builders for the report.

const MAX_ROWS = 25;

/** Renders at most MAX_ROWS rows and says how many more are in report.json. */
export function capped<T>(rows: T[], render: (rows: T[]) => string): string {
  const more = rows.length - MAX_ROWS;
  return render(rows.slice(0, MAX_ROWS)).trimEnd() + (more > 0 ? `\n\n${more} more in report.json.` : "");
}

export function table(headers: string[], rows: string[][]): string {
  const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const line = (cells: string[]) => `| ${cells.map(cell).join(" | ")} |`;
  return [line(headers), line(headers.map(() => "---")), ...rows.map(line)].join("\n");
}

export function list(items: string[], max: number): string {
  const shown = items.slice(0, max).join(", ");
  return items.length > max ? `${shown}, and ${items.length - max} more` : shown;
}

export function yesNo(value: boolean): string {
  return value ? "Yes" : "No";
}

export function kb(bytes: number): string {
  return bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}
