import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { customers, invoiceItems, invoices, products, units } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { requireCompany, requirePermission } from "../middleware/company.js";
import { calcTotals, money, nextDocumentNumber } from "../lib/helpers.js";

const router = Router();
router.use(requireAuth, requireCompany);

const DEFAULT_TERMS = [
  "1. We trust you will find our offer in line with your requirement and look forward to receive your order at an earlier date",
  "2. Taxes as per Government norms",
].join("\n");

const DEFAULT_PAYMENT =
  "50% Adv. With P.O. & 50% After Compl., of work within 7 days";

const DEFAULT_SUBJECT = "Invoice for";

const itemSchema = z.object({
  productId: z.string().uuid().optional().nullable(),
  description: z.string().min(1),
  hsnCode: z.string().optional().nullable(),
  unit: z.string().min(1),
  quantity: z.coerce.number().positive(),
  unitPrice: z.coerce.number().nonnegative(),
});

const docSchema = z.object({
  customerId: z.string().uuid(),
  status: z.enum(["draft", "sent", "paid", "cancelled"]).optional(),
  subject: z.string().optional().nullable(),
  validity: z.string().optional().nullable(),
  paymentTerms: z.string().optional().nullable(),
  taxRate: z.coerce.number().nonnegative().default(18),
  notes: z.string().optional().nullable(),
  items: z.array(itemSchema).default([]),
});

async function resolveItems(
  companyId: string,
  items: z.infer<typeof itemSchema>[]
) {
  const resolved = [];
  for (const item of items) {
    let description = item.description;
    let hsnCode = item.hsnCode ?? null;
    let unit = item.unit;
    let unitPrice = item.unitPrice;
    let productId = item.productId ?? null;

    if (item.productId) {
      const product = await db
        .select({
          id: products.id,
          name: products.name,
          description: products.description,
          hsnCode: products.hsnCode,
          price: products.price,
          unitName: units.name,
          unitSymbol: units.symbol,
        })
        .from(products)
        .innerJoin(units, eq(units.id, products.unitId))
        .where(and(eq(products.id, item.productId), eq(products.companyId, companyId)));

      if (!product[0]) throw new Error(`Product not found: ${item.productId}`);
      const p = product[0];
      description = item.description || p.description || p.name;
      hsnCode = item.hsnCode ?? p.hsnCode;
      unit = item.unit || p.unitSymbol || p.unitName;
      unitPrice = item.unitPrice ?? Number(p.price);
      productId = p.id;
    }

    const lineTotal = calcTotals([{ quantity: item.quantity, unitPrice }], 0).subtotal;
    resolved.push({
      productId,
      description,
      hsnCode,
      unit,
      quantity: item.quantity.toFixed(3),
      unitPrice: money(unitPrice),
      lineTotal: money(lineTotal),
      _qty: item.quantity,
      _price: unitPrice,
    });
  }
  return resolved;
}

router.get("/", requirePermission("view"), async (req, res) => {
  const rows = await db
    .select({
      id: invoices.id,
      number: invoices.number,
      status: invoices.status,
      taxRate: invoices.taxRate,
      subtotal: invoices.subtotal,
      taxAmount: invoices.taxAmount,
      total: invoices.total,
      notes: invoices.notes,
      subject: invoices.subject,
      validity: invoices.validity,
      paymentTerms: invoices.paymentTerms,
      customerId: invoices.customerId,
      customerName: customers.name,
      quotationId: invoices.quotationId,
      createdAt: invoices.createdAt,
      updatedAt: invoices.updatedAt,
    })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(eq(invoices.companyId, req.companyId!))
    .orderBy(desc(invoices.updatedAt));
  return res.json(rows);
});

router.get("/defaults", requirePermission("view"), async (_req, res) => {
  return res.json({
    subject: DEFAULT_SUBJECT,
    validity: "30 DAYS",
    paymentTerms: DEFAULT_PAYMENT,
    notes: DEFAULT_TERMS,
    taxRate: "18",
  });
});

router.get("/:id", requirePermission("view"), async (req, res) => {
  const row = await db.query.invoices.findFirst({
    where: and(eq(invoices.id, req.params.id!), eq(invoices.companyId, req.companyId!)),
  });
  if (!row) return res.status(404).json({ error: "Invoice not found" });
  const items = await db.query.invoiceItems.findMany({
    where: eq(invoiceItems.invoiceId, row.id),
  });
  const customer = await db.query.customers.findFirst({
    where: eq(customers.id, row.customerId),
  });
  return res.json({ ...row, items, customer });
});

router.post("/", requirePermission("write_documents"), async (req, res) => {
  const parsed = docSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  }

  const status = parsed.data.status ?? "draft";
  if (status !== "draft" && parsed.data.items.length === 0) {
    return res.status(400).json({ error: "Add at least one line item before changing status" });
  }

  const customer = await db.query.customers.findFirst({
    where: and(
      eq(customers.id, parsed.data.customerId),
      eq(customers.companyId, req.companyId!)
    ),
  });
  if (!customer) return res.status(400).json({ error: "Invalid customer" });

  try {
    const resolved = await resolveItems(req.companyId!, parsed.data.items);
    const totals = calcTotals(
      resolved.map((i) => ({ quantity: i._qty, unitPrice: i._price })),
      parsed.data.taxRate
    );
    const number = await nextDocumentNumber(req.companyId!, "INV");

    const [row] = await db
      .insert(invoices)
      .values({
        companyId: req.companyId!,
        number,
        customerId: parsed.data.customerId,
        status,
        subject: parsed.data.subject ?? null,
        validity: parsed.data.validity ?? "30 DAYS",
        paymentTerms: parsed.data.paymentTerms ?? null,
        taxRate: money(parsed.data.taxRate),
        notes: parsed.data.notes ?? null,
        subtotal: money(totals.subtotal),
        taxAmount: money(totals.taxAmount),
        total: money(totals.total),
      })
      .returning();

    if (resolved.length) {
      await db.insert(invoiceItems).values(
        resolved.map((i) => ({
          invoiceId: row.id,
          productId: i.productId,
          description: i.description,
          hsnCode: i.hsnCode,
          unit: i.unit,
          quantity: i.quantity,
          unitPrice: i.unitPrice,
          lineTotal: i.lineTotal,
        }))
      );
    }

    const items = await db.query.invoiceItems.findMany({
      where: eq(invoiceItems.invoiceId, row.id),
    });
    return res.status(201).json({ ...row, items, customer });
  } catch (e) {
    return res.status(400).json({ error: e instanceof Error ? e.message : "Failed" });
  }
});

router.patch("/:id", requirePermission("write_documents"), async (req, res) => {
  const existing = await db.query.invoices.findFirst({
    where: and(eq(invoices.id, req.params.id!), eq(invoices.companyId, req.companyId!)),
  });
  if (!existing) return res.status(404).json({ error: "Invoice not found" });

  const parsed = docSchema
    .partial()
    .extend({
      items: z.array(itemSchema).optional(),
      status: z.enum(["draft", "sent", "paid", "cancelled"]).optional(),
    })
    .safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request" });
  }

  const nextStatus = parsed.data.status ?? existing.status;
  if (
    nextStatus !== "draft" &&
    parsed.data.items !== undefined &&
    parsed.data.items.length === 0
  ) {
    return res.status(400).json({ error: "Add at least one line item before changing status" });
  }

  try {
    let totals = {
      subtotal: Number(existing.subtotal),
      taxAmount: Number(existing.taxAmount),
      total: Number(existing.total),
    };
    const taxRate = parsed.data.taxRate ?? Number(existing.taxRate);

    if (parsed.data.items !== undefined) {
      const resolved = await resolveItems(req.companyId!, parsed.data.items);
      totals = calcTotals(
        resolved.map((i) => ({ quantity: i._qty, unitPrice: i._price })),
        taxRate
      );
      await db.delete(invoiceItems).where(eq(invoiceItems.invoiceId, existing.id));
      if (resolved.length) {
        await db.insert(invoiceItems).values(
          resolved.map((i) => ({
            invoiceId: existing.id,
            productId: i.productId,
            description: i.description,
            hsnCode: i.hsnCode,
            unit: i.unit,
            quantity: i.quantity,
            unitPrice: i.unitPrice,
            lineTotal: i.lineTotal,
          }))
        );
      }
    } else if (parsed.data.taxRate !== undefined) {
      const items = await db.query.invoiceItems.findMany({
        where: eq(invoiceItems.invoiceId, existing.id),
      });
      totals = calcTotals(
        items.map((i) => ({ quantity: Number(i.quantity), unitPrice: Number(i.unitPrice) })),
        taxRate
      );
    }

    if (parsed.data.customerId) {
      const customer = await db.query.customers.findFirst({
        where: and(
          eq(customers.id, parsed.data.customerId),
          eq(customers.companyId, req.companyId!)
        ),
      });
      if (!customer) return res.status(400).json({ error: "Invalid customer" });
    }

    const [row] = await db
      .update(invoices)
      .set({
        ...(parsed.data.customerId ? { customerId: parsed.data.customerId } : {}),
        ...(parsed.data.status ? { status: parsed.data.status } : {}),
        ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
        ...(parsed.data.subject !== undefined ? { subject: parsed.data.subject } : {}),
        ...(parsed.data.validity !== undefined ? { validity: parsed.data.validity } : {}),
        ...(parsed.data.paymentTerms !== undefined
          ? { paymentTerms: parsed.data.paymentTerms }
          : {}),
        taxRate: money(taxRate),
        subtotal: money(totals.subtotal),
        taxAmount: money(totals.taxAmount),
        total: money(totals.total),
        updatedAt: new Date(),
      })
      .where(eq(invoices.id, existing.id))
      .returning();

    const items = await db.query.invoiceItems.findMany({
      where: eq(invoiceItems.invoiceId, existing.id),
    });
    const customer = await db.query.customers.findFirst({
      where: eq(customers.id, row.customerId),
    });
    return res.json({ ...row, items, customer });
  } catch (e) {
    return res.status(400).json({ error: e instanceof Error ? e.message : "Failed" });
  }
});

router.delete("/:id", requirePermission("write_documents"), async (req, res) => {
  const existing = await db.query.invoices.findFirst({
    where: and(eq(invoices.id, req.params.id!), eq(invoices.companyId, req.companyId!)),
  });
  if (!existing) return res.status(404).json({ error: "Invoice not found" });
  await db.delete(invoices).where(eq(invoices.id, existing.id));
  return res.json({ ok: true });
});

export default router;
