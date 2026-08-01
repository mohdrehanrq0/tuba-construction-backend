import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { products, units } from "../db/schema.js";
import {
  cell,
  emptyToNull,
  importUpload,
  parseImportMode,
  parseSpreadsheetBuffer,
  type ImportSummary,
  type RowResult,
} from "../lib/import-file.js";
import { requireAuth } from "../middleware/auth.js";
import { requireCompany, requirePermission } from "../middleware/company.js";

const router = Router();
router.use(requireAuth, requireCompany);

router.get("/", requirePermission("view"), async (req, res) => {
  const rows = await db.query.units.findMany({
    where: eq(units.companyId, req.companyId!),
    orderBy: (u, { asc }) => [asc(u.name)],
  });
  return res.json(rows);
});

router.post(
  "/import",
  requirePermission("write_catalog"),
  (req, res, next) => {
    importUpload.single("file")(req, res, (err) => {
      if (err) {
        return res.status(400).json({ error: err.message || "File upload failed" });
      }
      return next();
    });
  },
  async (req, res) => {
    if (!req.file?.buffer) {
      return res.status(400).json({ error: "Upload a CSV or Excel file" });
    }

    const mode = parseImportMode(req.body?.mode) ?? "upsert";
    let rows;
    try {
      rows = parseSpreadsheetBuffer(req.file.buffer);
    } catch {
      return res.status(400).json({ error: "Could not parse file. Use CSV or Excel (.xlsx)" });
    }

    if (rows.length === 0) {
      return res.status(400).json({ error: "File has no data rows" });
    }

    const existing = await db.query.units.findMany({
      where: eq(units.companyId, req.companyId!),
    });
    const byId = new Map(existing.map((u) => [u.id, u]));
    const byName = new Map(existing.map((u) => [u.name.trim().toLowerCase(), u]));

    const summary: ImportSummary = {
      created: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
      results: [],
    };

    for (let i = 0; i < rows.length; i++) {
      const rowNum = i + 2; // header is row 1
      const raw = rows[i]!;
      const id = cell(raw, "id");
      const name = cell(raw, "name");
      const symbolRaw = cell(raw, "symbol");
      const symbol = emptyToNull(symbolRaw);
      const result: RowResult = { row: rowNum, action: "error", name: name || undefined };

      try {
        const match =
          (id && byId.get(id)) ||
          (name ? byName.get(name.trim().toLowerCase()) : undefined);

        if (mode === "add") {
          if (match) {
            result.action = "skipped";
            result.message = "Unit already exists";
            summary.skipped++;
            summary.results.push(result);
            continue;
          }
          if (!name) {
            result.message = "name is required";
            summary.errors++;
            summary.results.push(result);
            continue;
          }
          const [created] = await db
            .insert(units)
            .values({
              companyId: req.companyId!,
              name: name.trim(),
              symbol,
            })
            .returning();
          byId.set(created!.id, created!);
          byName.set(created!.name.trim().toLowerCase(), created!);
          result.action = "created";
          result.id = created!.id;
          result.name = created!.name;
          summary.created++;
          summary.results.push(result);
          continue;
        }

        if (mode === "update" || (mode === "upsert" && match)) {
          if (!match) {
            result.message = id
              ? "Unit id not found"
              : "Unit not found (provide id or matching name)";
            summary.errors++;
            summary.results.push(result);
            continue;
          }
          const nextName = name ? name.trim() : match.name;
          const hasSymbolCol = "symbol" in raw;
          const [updated] = await db
            .update(units)
            .set({
              name: nextName,
              ...(hasSymbolCol ? { symbol } : {}),
              updatedAt: new Date(),
            })
            .where(eq(units.id, match.id))
            .returning();
          byId.set(updated!.id, updated!);
          byName.delete(match.name.trim().toLowerCase());
          byName.set(updated!.name.trim().toLowerCase(), updated!);
          result.action = "updated";
          result.id = updated!.id;
          result.name = updated!.name;
          summary.updated++;
          summary.results.push(result);
          continue;
        }

        // upsert create
        if (!name) {
          result.message = "name is required to create a unit";
          summary.errors++;
          summary.results.push(result);
          continue;
        }
        const [created] = await db
          .insert(units)
          .values({
            companyId: req.companyId!,
            name: name.trim(),
            symbol,
          })
          .returning();
        byId.set(created!.id, created!);
        byName.set(created!.name.trim().toLowerCase(), created!);
        result.action = "created";
        result.id = created!.id;
        result.name = created!.name;
        summary.created++;
        summary.results.push(result);
      } catch (err) {
        const msg =
          err instanceof Error && /unique|duplicate/i.test(err.message)
            ? "Unit name already exists for this company"
            : err instanceof Error
              ? err.message
              : "Failed to import row";
        result.action = "error";
        result.message = msg;
        summary.errors++;
        summary.results.push(result);
      }
    }

    return res.json(summary);
  }
);

router.post("/", requirePermission("write_catalog"), async (req, res) => {
  const schema = z.object({
    name: z.string().min(1),
    symbol: z.string().optional().nullable(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request" });
  }

  try {
    const [row] = await db
      .insert(units)
      .values({
        companyId: req.companyId!,
        name: parsed.data.name.trim(),
        symbol: parsed.data.symbol ?? null,
      })
      .returning();
    return res.status(201).json(row);
  } catch {
    return res.status(409).json({ error: "Unit name already exists for this company" });
  }
});

router.patch("/:id", requirePermission("write_catalog"), async (req, res) => {
  const schema = z.object({
    name: z.string().min(1).optional(),
    symbol: z.string().nullable().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request" });
  }

  const existing = await db.query.units.findFirst({
    where: and(eq(units.id, req.params.id!), eq(units.companyId, req.companyId!)),
  });
  if (!existing) {
    return res.status(404).json({ error: "Unit not found" });
  }

  try {
    const [row] = await db
      .update(units)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(units.id, existing.id))
      .returning();
    return res.json(row);
  } catch {
    return res.status(409).json({ error: "Unit name already exists for this company" });
  }
});

router.delete("/:id", requirePermission("write_catalog"), async (req, res) => {
  const existing = await db.query.units.findFirst({
    where: and(eq(units.id, req.params.id!), eq(units.companyId, req.companyId!)),
  });
  if (!existing) {
    return res.status(404).json({ error: "Unit not found" });
  }

  const inUse = await db.query.products.findFirst({
    where: and(eq(products.unitId, existing.id), eq(products.companyId, req.companyId!)),
  });
  if (inUse) {
    return res.status(400).json({
      error: "Cannot delete unit while products reference it. Reassign products first.",
    });
  }

  await db.delete(units).where(eq(units.id, existing.id));
  return res.json({ ok: true });
});

export default router;
