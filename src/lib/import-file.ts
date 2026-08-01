import multer from "multer";
import * as XLSX from "xlsx";

export const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const name = file.originalname.toLowerCase();
    const ok =
      name.endsWith(".csv") ||
      name.endsWith(".xlsx") ||
      name.endsWith(".xls") ||
      file.mimetype === "text/csv" ||
      file.mimetype === "application/vnd.ms-excel" ||
      file.mimetype ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    if (!ok) {
      cb(new Error("Only CSV and Excel files (.csv, .xlsx, .xls) are supported"));
      return;
    }
    cb(null, true);
  },
});

export type ImportMode = "add" | "update" | "upsert";

export function parseImportMode(value: unknown): ImportMode | null {
  if (value === "add" || value === "update" || value === "upsert") return value;
  return null;
}

/** Normalize header keys: trim, lower-case, strip non-alphanumeric. */
export function normalizeHeader(key: string): string {
  return String(key ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_\-]+/g, "")
    .replace(/[^a-z0-9]/g, "");
}

export type RawImportRow = Record<string, string>;

export function parseSpreadsheetBuffer(buffer: Buffer): RawImportRow[] {
  const workbook = XLSX.read(buffer, { type: "buffer", raw: false, cellDates: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return [];

  const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: false,
  });

  return json.map((row) => {
    const out: RawImportRow = {};
    for (const [key, value] of Object.entries(row)) {
      const norm = normalizeHeader(key);
      if (!norm) continue;
      out[norm] = value == null ? "" : String(value).trim();
    }
    return out;
  });
}

export function cell(row: RawImportRow, ...aliases: string[]): string {
  for (const alias of aliases) {
    const v = row[normalizeHeader(alias)];
    if (v !== undefined && v !== "") return v;
  }
  return "";
}

export function emptyToNull(value: string): string | null {
  const t = value.trim();
  return t === "" ? null : t;
}

export type RowResult = {
  row: number;
  action: "created" | "updated" | "skipped" | "error";
  message?: string;
  id?: string;
  name?: string;
};

export type ImportSummary = {
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  results: RowResult[];
};
