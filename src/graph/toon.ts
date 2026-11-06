/**
 * Token-Oriented Object Notation for query results: one header per table naming
 * its columns once, then one comma-separated line per row. Roughly half the
 * tokens of the same rows as JSON, and still unambiguous to read back.
 *
 *   files[2]{file,role,prompts}:
 *     src/a.ts,behavior,S1 S4
 *     README.md,docs,""
 *
 * Lists inside a cell are space-separated; strings that could be misread
 * (commas, quotes, leading spaces, number-like text) are quoted; colons are
 * not structural inside a row, so diff refs and timestamps stay bare.
 */
import type { Section } from './queries.ts';

function cell(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint')
    return String(v);
  if (Array.isArray(v))
    return str(v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  if (typeof v === 'object') return str(JSON.stringify(v));
  return str(String(v));
}

function str(s: string): string {
  const risky =
    s === '' ||
    /^[\s]|[\s]$/.test(s) ||
    /[,"\\\n\r\t]/.test(s) ||
    /^(true|false|null|-?\d+(\.\d+)?([eE][+-]?\d+)?)$/.test(s);
  if (!risky) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
}

export function toToon(sections: Section[], opts: { rowCap?: number } = {}): string {
  const cap = opts.rowCap ?? Infinity;
  const out: string[] = [];
  for (const s of sections) {
    const rows = s.rows.slice(0, cap);
    out.push(`${s.title}[${s.rows.length}]{${s.columns.join(',')}}:`);
    for (const r of rows) out.push(`  ${s.columns.map((c) => cell(r[c])).join(',')}`);
    if (s.rows.length > rows.length)
      out.push(
        `  # ${s.rows.length - rows.length} more rows not shown (rowCap ${cap}); narrow the query or pass --all`,
      );
  }
  return out.join('\n') + '\n';
}
