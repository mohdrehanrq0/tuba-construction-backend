import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { documentCounters, units } from "../db/schema.js";
import { DEFAULT_UNITS } from "./permissions.js";

export async function seedDefaultUnits(companyId: string) {
  await db.insert(units).values(
    DEFAULT_UNITS.map((u) => ({
      companyId,
      name: u.name,
      symbol: u.symbol,
    }))
  );
}

/** Indian FY label, e.g. 25-26 (Apr–Mar). */
export function financialYearLabel(date = new Date()) {
  const year = date.getFullYear();
  const month = date.getMonth(); // 0-based
  const start = month >= 3 ? year : year - 1;
  const a = String(start).slice(-2);
  const b = String(start + 1).slice(-2);
  return `${a}-${b}`;
}

export async function nextDocumentNumber(companyId: string, type: "QT" | "INV") {
  const existing = await db.query.documentCounters.findFirst({
    where: and(eq(documentCounters.companyId, companyId), eq(documentCounters.type, type)),
  });

  let current: number;
  if (!existing) {
    await db.insert(documentCounters).values({
      companyId,
      type,
      nextNumber: 2,
    });
    current = 1;
  } else {
    current = existing.nextNumber;
    await db
      .update(documentCounters)
      .set({ nextNumber: sql`${documentCounters.nextNumber} + 1` })
      .where(eq(documentCounters.id, existing.id));
  }

  const fy = financialYearLabel();
  if (type === "QT") {
    return `TC/${current}/${fy}`;
  }
  return `INV/${String(current).padStart(4, "0")}/${fy}`;
}

export function calcTotals(
  items: { quantity: number; unitPrice: number }[],
  taxRate: number
) {
  const subtotal = items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);
  const taxAmount = (subtotal * taxRate) / 100;
  const total = subtotal + taxAmount;
  return {
    subtotal: round2(subtotal),
    taxAmount: round2(taxAmount),
    total: round2(total),
  };
}

export function round2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function money(n: number | string) {
  return Number(n).toFixed(2);
}

export function formatDateIndian(date: Date | string) {
  const d = typeof date === "string" ? new Date(date) : date;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

const ONES = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
];
const TENS = [
  "",
  "",
  "Twenty",
  "Thirty",
  "Forty",
  "Fifty",
  "Sixty",
  "Seventy",
  "Eighty",
  "Ninety",
];

function twoDigits(n: number): string {
  if (n < 20) return ONES[n] ?? "";
  const t = Math.floor(n / 10);
  const o = n % 10;
  return `${TENS[t]}${o ? ` ${ONES[o]}` : ""}`.trim();
}

function threeDigits(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (h) parts.push(`${ONES[h]} Hundred`);
  if (rest) parts.push(twoDigits(rest));
  return parts.join(" ");
}

/** Amount in Indian words, matching Tuba Excel style. */
export function amountInWordsInr(amount: number): string {
  const rounded = round2(Math.abs(amount));
  const rupees = Math.floor(rounded);
  const paise = Math.round((rounded - rupees) * 100);

  if (rupees === 0 && paise === 0) {
    return "INR:- Zero Only";
  }

  const crore = Math.floor(rupees / 10000000);
  const lakh = Math.floor((rupees % 10000000) / 100000);
  const thousand = Math.floor((rupees % 100000) / 1000);
  const hundred = rupees % 1000;

  const parts: string[] = [];
  if (crore) parts.push(`${threeDigits(crore)} Crore${crore > 1 ? "s" : ""}`);
  if (lakh) parts.push(`${threeDigits(lakh)} Lakh${lakh > 1 ? "s" : ""}`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (hundred) parts.push(threeDigits(hundred));

  let words = parts.join(" ").replace(/\s+/g, " ").trim();
  if (paise) {
    words = `${words} and ${twoDigits(paise)} Paisa`;
  }

  return `INR:- ${words} Only`;
}
