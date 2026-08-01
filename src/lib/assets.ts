import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Root local assets folder (never cloud). */
export const ASSETS_DIR = path.resolve(__dirname, "../../assets");
export const DEFAULTS_DIR = path.join(ASSETS_DIR, "defaults");
export const COMPANIES_DIR = path.join(ASSETS_DIR, "companies");

export type AssetKind = "logo" | "signature";

const DEFAULT_FILES: Record<AssetKind, string> = {
  logo: "logo.jpeg",
  signature: "signature.png",
};

export function ensureAssetDirs() {
  fs.mkdirSync(DEFAULTS_DIR, { recursive: true });
  fs.mkdirSync(COMPANIES_DIR, { recursive: true });
}

export function companyAssetDir(companyId: string) {
  return path.join(COMPANIES_DIR, companyId);
}

export function ensureCompanyAssetDir(companyId: string) {
  const dir = companyAssetDir(companyId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function defaultAssetPath(kind: AssetKind) {
  return path.join(DEFAULTS_DIR, DEFAULT_FILES[kind]);
}

/** Absolute path for a company asset file, or null if missing. */
export function companyStoredPath(companyId: string, filename: string | null | undefined) {
  if (!filename) return null;
  const full = path.join(companyAssetDir(companyId), path.basename(filename));
  return fs.existsSync(full) ? full : null;
}

/**
 * Resolve logo/signature for PDF and HTTP serve.
 * Prefer company file; fall back to defaults.
 */
export function resolveCompanyAsset(
  companyId: string,
  kind: AssetKind,
  storedFilename: string | null | undefined
) {
  const companyPath = companyStoredPath(companyId, storedFilename);
  if (companyPath) return companyPath;
  const fallback = defaultAssetPath(kind);
  return fs.existsSync(fallback) ? fallback : null;
}

export function companyAssetPublicUrl(companyId: string, kind: AssetKind) {
  return `/assets/companies/${companyId}/${kind}`;
}

export function extFromUpload(originalname: string, mimetype: string, kind: AssetKind) {
  const lower = originalname.toLowerCase();
  if (lower.endsWith(".png") || mimetype === "image/png") return "png";
  if (lower.endsWith(".webp") || mimetype === "image/webp") return "webp";
  if (lower.endsWith(".gif") || mimetype === "image/gif") return "gif";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg") || mimetype === "image/jpeg") {
    return "jpeg";
  }
  return kind === "signature" ? "png" : "jpeg";
}
