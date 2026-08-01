import { Router } from "express";
import { and, eq, ilike, or } from "drizzle-orm";
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
  const q = String(req.query.q ?? "").trim();
  const limit = q
    ? Math.min(Math.max(Number(req.query.limit) || 25, 1), 50)
    : undefined;

  const base = db
    .select({
      id: products.id,
      name: products.name,
      description: products.description,
      hsnCode: products.hsnCode,
      price: products.price,
      unitId: products.unitId,
      unitName: units.name,
      unitSymbol: units.symbol,
      createdAt: products.createdAt,
      updatedAt: products.updatedAt,
    })
    .from(products)
    .innerJoin(units, eq(units.id, products.unitId));

  if (q) {
    const pattern = `%${q}%`;
    const rows = await base
      .where(
        and(
          eq(products.companyId, req.companyId!),
          or(
            ilike(products.name, pattern),
            ilike(products.description, pattern),
            ilike(products.hsnCode, pattern)
          )
        )
      )
      .orderBy(products.name)
      .limit(limit!);
    return res.json(rows);
  }

  const rows = await base
    .where(eq(products.companyId, req.companyId!))
    .orderBy(products.name);
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

    const companyUnits = await db.query.units.findMany({
      where: eq(units.companyId, req.companyId!),
    });
    // Product import maps the CSV/Excel "unit" column (unit name) → units.id.
    // Products only store unitId — never the unit name/symbol string.
    const unitByName = new Map(
      companyUnits.map((u) => [u.name.trim().toLowerCase(), u])
    );

    const existingProducts = await db.query.products.findMany({
      where: eq(products.companyId, req.companyId!),
    });
    const productById = new Map(existingProducts.map((p) => [p.id, p]));
    const productsByName = new Map<string, (typeof existingProducts)[0]>();
    for (const p of existingProducts) {
      const key = p.name.trim().toLowerCase();
      if (!productsByName.has(key)) productsByName.set(key, p);
    }

    function resolveUnitIdByName(unitName: string) {
      const key = unitName.trim().toLowerCase();
      if (!key) return undefined;
      return unitByName.get(key);
    }

    const summary: ImportSummary = {
      created: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
      results: [],
    };

    for (let i = 0; i < rows.length; i++) {
      const rowNum = i + 2;
      const raw = rows[i]!;
      const id = cell(raw, "id");
      const name = cell(raw, "name");
      const description = emptyToNull(
        cell(raw, "description", "desc")
      );
      const hsnCode = emptyToNull(
        cell(raw, "hsnCode", "hsn", "hsncode", "hsnsac")
      );
      const priceRaw = cell(raw, "price", "rate");
      // "unit" column must be the unit's name (e.g. Nos, Kg). Backend resolves → unitId.
      const unitNameCell = cell(raw, "unit", "unitName", "unitname");

      const result: RowResult = { row: rowNum, action: "error", name: name || undefined };

      try {
        const match =
          (id && productById.get(id)) ||
          (name ? productsByName.get(name.trim().toLowerCase()) : undefined);

        const parsePrice = (value: string, required: boolean) => {
          if (!value) {
            if (required) throw new Error("price is required");
            return undefined;
          }
          const n = Number(String(value).replace(/,/g, ""));
          if (!Number.isFinite(n) || n < 0) throw new Error("price must be a non-negative number");
          return n.toFixed(2);
        };

        if (mode === "add") {
          if (match) {
            result.action = "skipped";
            result.message = "Product already exists";
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
          const price = parsePrice(priceRaw, true)!;
          if (!unitNameCell) {
            result.message =
              "unit is required — use the exact unit name from your Units list (mapped to unit id on save)";
            summary.errors++;
            summary.results.push(result);
            continue;
          }
          const unit = resolveUnitIdByName(unitNameCell);
          if (!unit) {
            result.message = `No unit named "${unitNameCell}" — create it under Units first, or use the exact unit name`;
            summary.errors++;
            summary.results.push(result);
            continue;
          }
          const [created] = await db
            .insert(products)
            .values({
              companyId: req.companyId!,
              name: name.trim(),
              description,
              hsnCode,
              price,
              unitId: unit.id,
            })
            .returning();
          productById.set(created!.id, created!);
          productsByName.set(created!.name.trim().toLowerCase(), created!);
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
              ? "Product id not found"
              : "Product not found (provide id or matching name)";
            summary.errors++;
            summary.results.push(result);
            continue;
          }

          const nextName = name ? name.trim() : match.name;
          const price =
            priceRaw !== "" ? parsePrice(priceRaw, true) : undefined;
          let nextUnitId: string | undefined;
          if (unitNameCell) {
            const unit = resolveUnitIdByName(unitNameCell);
            if (!unit) {
              result.message = `No unit named "${unitNameCell}" — create it under Units first, or use the exact unit name`;
              summary.errors++;
              summary.results.push(result);
              continue;
            }
            nextUnitId = unit.id;
          }

          const [updated] = await db
            .update(products)
            .set({
              name: nextName,
              ...("description" in raw || "desc" in raw
                ? { description }
                : {}),
              ...("hsncode" in raw || "hsn" in raw || "hsnsac" in raw
                ? { hsnCode }
                : {}),
              ...(price !== undefined ? { price } : {}),
              ...(nextUnitId !== undefined ? { unitId: nextUnitId } : {}),
              updatedAt: new Date(),
            })
            .where(eq(products.id, match.id))
            .returning();

          productById.set(updated!.id, updated!);
          productsByName.delete(match.name.trim().toLowerCase());
          productsByName.set(updated!.name.trim().toLowerCase(), updated!);
          result.action = "updated";
          result.id = updated!.id;
          result.name = updated!.name;
          summary.updated++;
          summary.results.push(result);
          continue;
        }

        // upsert create
        if (!name) {
          result.message = "name is required to create a product";
          summary.errors++;
          summary.results.push(result);
          continue;
        }
        const price = parsePrice(priceRaw, true)!;
        if (!unitNameCell) {
          result.message =
            "unit is required — use the exact unit name from your Units list (mapped to unit id on save)";
          summary.errors++;
          summary.results.push(result);
          continue;
        }
        const unit = resolveUnitIdByName(unitNameCell);
        if (!unit) {
          result.message = `No unit named "${unitNameCell}" — create it under Units first, or use the exact unit name`;
          summary.errors++;
          summary.results.push(result);
          continue;
        }
        const [created] = await db
          .insert(products)
          .values({
            companyId: req.companyId!,
            name: name.trim(),
            description,
            hsnCode,
            price,
            unitId: unit.id,
          })
          .returning();
        productById.set(created!.id, created!);
        productsByName.set(created!.name.trim().toLowerCase(), created!);
        result.action = "created";
        result.id = created!.id;
        result.name = created!.name;
        summary.created++;
        summary.results.push(result);
      } catch (err) {
        result.action = "error";
        result.message = err instanceof Error ? err.message : "Failed to import row";
        summary.errors++;
        summary.results.push(result);
      }
    }

    return res.json(summary);
  }
);

router.get("/:id", requirePermission("view"), async (req, res) => {
  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      description: products.description,
      hsnCode: products.hsnCode,
      price: products.price,
      unitId: products.unitId,
      unitName: units.name,
      unitSymbol: units.symbol,
      createdAt: products.createdAt,
      updatedAt: products.updatedAt,
    })
    .from(products)
    .innerJoin(units, eq(units.id, products.unitId))
    .where(and(eq(products.id, req.params.id!), eq(products.companyId, req.companyId!)));
  if (!rows[0]) {
    return res.status(404).json({ error: "Product not found" });
  }
  return res.json(rows[0]);
});

router.post("/", requirePermission("write_catalog"), async (req, res) => {
  const schema = z.object({
    name: z.string().min(1),
    description: z.string().optional().nullable(),
    hsnCode: z.string().optional().nullable(),
    price: z.coerce.number().nonnegative(),
    unitId: z.string().uuid(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request" });
  }

  const unit = await db.query.units.findFirst({
    where: and(eq(units.id, parsed.data.unitId), eq(units.companyId, req.companyId!)),
  });
  if (!unit) {
    return res.status(400).json({ error: "Invalid unit for this company" });
  }

  const [row] = await db
    .insert(products)
    .values({
      companyId: req.companyId!,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      hsnCode: parsed.data.hsnCode ?? null,
      price: parsed.data.price.toFixed(2),
      unitId: parsed.data.unitId,
    })
    .returning();
  return res.status(201).json({ ...row, unitName: unit.name, unitSymbol: unit.symbol });
});

router.patch("/:id", requirePermission("write_catalog"), async (req, res) => {
  const schema = z.object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    hsnCode: z.string().nullable().optional(),
    price: z.coerce.number().nonnegative().optional(),
    unitId: z.string().uuid().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request" });
  }

  const existing = await db.query.products.findFirst({
    where: and(eq(products.id, req.params.id!), eq(products.companyId, req.companyId!)),
  });
  if (!existing) {
    return res.status(404).json({ error: "Product not found" });
  }

  if (parsed.data.unitId) {
    const unit = await db.query.units.findFirst({
      where: and(eq(units.id, parsed.data.unitId), eq(units.companyId, req.companyId!)),
    });
    if (!unit) {
      return res.status(400).json({ error: "Invalid unit for this company" });
    }
  }

  const [row] = await db
    .update(products)
    .set({
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      ...(parsed.data.hsnCode !== undefined ? { hsnCode: parsed.data.hsnCode } : {}),
      ...(parsed.data.price !== undefined ? { price: parsed.data.price.toFixed(2) } : {}),
      ...(parsed.data.unitId !== undefined ? { unitId: parsed.data.unitId } : {}),
      updatedAt: new Date(),
    })
    .where(eq(products.id, existing.id))
    .returning();

  return res.json(row);
});

router.delete("/:id", requirePermission("write_catalog"), async (req, res) => {
  const existing = await db.query.products.findFirst({
    where: and(eq(products.id, req.params.id!), eq(products.companyId, req.companyId!)),
  });
  if (!existing) {
    return res.status(404).json({ error: "Product not found" });
  }
  await db.delete(products).where(eq(products.id, existing.id));
  return res.json({ ok: true });
});

export default router;
