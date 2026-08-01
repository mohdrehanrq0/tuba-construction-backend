import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { customers } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { requireCompany, requirePermission } from "../middleware/company.js";

const router = Router();
router.use(requireAuth, requireCompany);

router.get("/", requirePermission("view"), async (req, res) => {
  const rows = await db.query.customers.findMany({
    where: eq(customers.companyId, req.companyId!),
    orderBy: (c, { asc }) => [asc(c.name)],
  });
  return res.json(rows);
});

router.get("/:id", requirePermission("view"), async (req, res) => {
  const row = await db.query.customers.findFirst({
    where: and(eq(customers.id, req.params.id!), eq(customers.companyId, req.companyId!)),
  });
  if (!row) return res.status(404).json({ error: "Customer not found" });
  return res.json(row);
});

router.post("/", requirePermission("write_catalog"), async (req, res) => {
  const schema = z.object({
    name: z.string().min(1),
    email: z.string().email().optional().nullable().or(z.literal("")),
    phone: z.string().optional().nullable(),
    address: z.string().optional().nullable(),
    gstin: z.string().optional().nullable(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request" });
  }
  const [row] = await db
    .insert(customers)
    .values({
      companyId: req.companyId!,
      name: parsed.data.name,
      email: parsed.data.email || null,
      phone: parsed.data.phone ?? null,
      address: parsed.data.address ?? null,
      gstin: parsed.data.gstin ?? null,
    })
    .returning();
  return res.status(201).json(row);
});

router.patch("/:id", requirePermission("write_catalog"), async (req, res) => {
  const schema = z.object({
    name: z.string().min(1).optional(),
    email: z.string().email().nullable().optional().or(z.literal("")),
    phone: z.string().nullable().optional(),
    address: z.string().nullable().optional(),
    gstin: z.string().nullable().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request" });
  }
  const existing = await db.query.customers.findFirst({
    where: and(eq(customers.id, req.params.id!), eq(customers.companyId, req.companyId!)),
  });
  if (!existing) return res.status(404).json({ error: "Customer not found" });

  const [row] = await db
    .update(customers)
    .set({
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.email !== undefined ? { email: parsed.data.email || null } : {}),
      ...(parsed.data.phone !== undefined ? { phone: parsed.data.phone } : {}),
      ...(parsed.data.address !== undefined ? { address: parsed.data.address } : {}),
      ...(parsed.data.gstin !== undefined ? { gstin: parsed.data.gstin } : {}),
    })
    .where(eq(customers.id, existing.id))
    .returning();
  return res.json(row);
});

router.delete("/:id", requirePermission("write_catalog"), async (req, res) => {
  const existing = await db.query.customers.findFirst({
    where: and(eq(customers.id, req.params.id!), eq(customers.companyId, req.companyId!)),
  });
  if (!existing) return res.status(404).json({ error: "Customer not found" });
  await db.delete(customers).where(eq(customers.id, existing.id));
  return res.json({ ok: true });
});

export default router;
