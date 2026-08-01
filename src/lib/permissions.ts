import type { Role } from "../db/schema.js";

export type Permission =
  | "manage_company"
  | "manage_members"
  | "write_catalog"
  | "write_documents"
  | "convert_quotation"
  | "download_pdf"
  | "view"
  | "delete_company"
  | "manage_labor"
  | "mark_attendance";

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  owner: [
    "manage_company",
    "manage_members",
    "write_catalog",
    "write_documents",
    "convert_quotation",
    "download_pdf",
    "view",
    "delete_company",
    "manage_labor",
    "mark_attendance",
  ],
  admin: [
    "manage_company",
    "manage_members",
    "write_catalog",
    "write_documents",
    "convert_quotation",
    "download_pdf",
    "view",
    "manage_labor",
    "mark_attendance",
  ],
  member: [
    "write_catalog",
    "write_documents",
    "convert_quotation",
    "download_pdf",
    "view",
    "mark_attendance",
  ],
  viewer: ["download_pdf", "view"],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export const DEFAULT_UNITS = [
  { name: "Nos", symbol: "Nos" },
  { name: "Kg", symbol: "Kg" },
  { name: "Meter", symbol: "m" },
  { name: "Sq.ft", symbol: "sq.ft" },
];
