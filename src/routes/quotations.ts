import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import {
  customers,
  invoiceItems,
  invoices,
  products,
  quotationItems,
  quotations,
  units,
} from "../db/schema.js";
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

const DEFAULT_SUBJECT = "Quotation for";

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
  status: z.enum(["draft", "sent", "accepted", "converted", "cancelled"]).optional(),
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

      if (!product[0]) {
        throw new Error(`Product not found: ${item.productId}`);
      }
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
      id: quotations.id,
      number: quotations.number,
      status: quotations.status,
      taxRate: quotations.taxRate,
      subtotal: quotations.subtotal,
      taxAmount: quotations.taxAmount,
      total: quotations.total,
      notes: quotations.notes,
      subject: quotations.subject,
      validity: quotations.validity,
      paymentTerms: quotations.paymentTerms,
      customerId: quotations.customerId,
      customerName: customers.name,
      createdAt: quotations.createdAt,
      updatedAt: quotations.updatedAt,
    })
    .from(quotations)
    .innerJoin(customers, eq(customers.id, quotations.customerId))
    .where(eq(quotations.companyId, req.companyId!))
    .orderBy(desc(quotations.updatedAt));
  return res.json(rows);
});

/** Fixed prefills for every new quotation. */
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
  const row = await db.query.quotations.findFirst({
    where: and(eq(quotations.id, req.params.id!), eq(quotations.companyId, req.companyId!)),
  });
  if (!row) return res.status(404).json({ error: "Quotation not found" });
  const items = await db.query.quotationItems.findMany({
    where: eq(quotationItems.quotationId, row.id),
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
    const number = await nextDocumentNumber(req.companyId!, "QT");

    const [row] = await db
      .insert(quotations)
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
      await db.insert(quotationItems).values(
        resolved.map((i) => ({
          quotationId: row.id,
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

    const items = await db.query.quotationItems.findMany({
      where: eq(quotationItems.quotationId, row.id),
    });
    return res.status(201).json({ ...row, items, customer });
  } catch (e) {
    return res.status(400).json({ error: e instanceof Error ? e.message : "Failed" });
  }
});

router.patch("/:id", requirePermission("write_documents"), async (req, res) => {
  const existing = await db.query.quotations.findFirst({
    where: and(eq(quotations.id, req.params.id!), eq(quotations.companyId, req.companyId!)),
  });
  if (!existing) return res.status(404).json({ error: "Quotation not found" });
  if (existing.status === "converted") {
    return res.status(400).json({ error: "Converted quotations cannot be edited" });
  }

  const parsed = docSchema
    .partial()
    .extend({
      items: z.array(itemSchema).optional(),
      status: z.enum(["draft", "sent", "accepted", "cancelled"]).optional(),
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
      await db.delete(quotationItems).where(eq(quotationItems.quotationId, existing.id));
      if (resolved.length) {
        await db.insert(quotationItems).values(
          resolved.map((i) => ({
            quotationId: existing.id,
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
      const items = await db.query.quotationItems.findMany({
        where: eq(quotationItems.quotationId, existing.id),
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
      .update(quotations)
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
      .where(eq(quotations.id, existing.id))
      .returning();

    const items = await db.query.quotationItems.findMany({
      where: eq(quotationItems.quotationId, existing.id),
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
  const existing = await db.query.quotations.findFirst({
    where: and(eq(quotations.id, req.params.id!), eq(quotations.companyId, req.companyId!)),
  });
  if (!existing) return res.status(404).json({ error: "Quotation not found" });
  if (existing.status === "converted") {
    return res.status(400).json({ error: "Cannot delete a converted quotation" });
  }
  await db.delete(quotations).where(eq(quotations.id, existing.id));
  return res.json({ ok: true });
});

router.post("/:id/convert", requirePermission("convert_quotation"), async (req, res) => {
  const existing = await db.query.quotations.findFirst({
    where: and(eq(quotations.id, req.params.id!), eq(quotations.companyId, req.companyId!)),
  });
  if (!existing) return res.status(404).json({ error: "Quotation not found" });
  if (existing.status === "converted") {
    return res.status(400).json({ error: "Already converted" });
  }
  if (existing.status === "cancelled") {
    return res.status(400).json({ error: "Cannot convert a cancelled quotation" });
  }

  const items = await db.query.quotationItems.findMany({
    where: eq(quotationItems.quotationId, existing.id),
  });
  if (!items.length) {
    return res.status(400).json({ error: "Add line items before converting" });
  }
  const number = await nextDocumentNumber(req.companyId!, "INV");

  const [invoice] = await db
    .insert(invoices)
    .values({
      companyId: req.companyId!,
      number,
      quotationId: existing.id,
      customerId: existing.customerId,
      status: "draft",
      subject: existing.subject,
      validity: existing.validity,
      paymentTerms: existing.paymentTerms,
      taxRate: existing.taxRate,
      notes: existing.notes,
      subtotal: existing.subtotal,
      taxAmount: existing.taxAmount,
      total: existing.total,
    })
    .returning();

  await db.insert(invoiceItems).values(
    items.map((i) => ({
      invoiceId: invoice.id,
      productId: i.productId,
      description: i.description,
      hsnCode: i.hsnCode,
      unit: i.unit,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      lineTotal: i.lineTotal,
    }))
  );

  await db
    .update(quotations)
    .set({ status: "converted", updatedAt: new Date() })
    .where(eq(quotations.id, existing.id));

  return res.status(201).json(invoice);
});

export default router;
