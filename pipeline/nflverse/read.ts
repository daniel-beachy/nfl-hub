import { parquetMetadata, parquetReadObjects, parquetSchema } from "hyparquet";

// Reading nflverse parquet with hyparquet (proved in M0-8 on the 2025 files: play-by-play,
// 48,771 rows by 372 columns, reads 14 columns in well under a second).

export type Row = Record<string, string | number | boolean | null>;

export class DatasetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatasetError";
  }
}

export interface ParquetInfo {
  rows: number;
  columns: string[];
}

/** Row count and top-level column names, from the footer only. */
export function parquetInfo(file: ArrayBuffer): ParquetInfo {
  const meta = parquetMetadata(file);
  return { rows: Number(meta.num_rows), columns: parquetSchema(meta).children.map((c) => c.element.name) };
}

/** The required columns a file lacks. Pure. */
export function missingColumns(have: readonly string[], required: readonly string[]): string[] {
  const set = new Set(have);
  return required.filter((c) => !set.has(c));
}

/**
 * Read `columns` of a parquet file as plain rows. Throws DatasetError naming every missing
 * column before reading anything. 64-bit integers become numbers; dates become ISO strings.
 */
export async function readRows(file: ArrayBuffer, columns: readonly string[], label: string): Promise<Row[]> {
  const info = parquetInfo(file);
  const missing = missingColumns(info.columns, columns);
  if (missing.length > 0) throw new DatasetError(`${label} is missing column(s): ${missing.join(", ")}`);
  const rows = (await parquetReadObjects({ file, columns: [...columns] })) as Record<string, unknown>[];
  return rows.map((r) => {
    const out: Row = {};
    for (const c of columns) out[c] = plain(r[c]);
    return out;
  });
}

function plain(v: unknown): Row[string] {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  return String(v);
}
