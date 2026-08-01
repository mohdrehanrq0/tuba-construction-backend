import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { users, wageAdvances, workers } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { requireCompany, requirePermission } from "../middleware/company.js";

const router = Router();
router.use(requireAuth, requireCompany);

router.get("/", requirePermission("view"), async (req, res) => {
  const workerId =
    typeof req.query.workerId === "string" ? req.query.workerId : undefined;

  const conditions = [eq(wageAdvances.companyId, req.companyId!)];
  if (workerId) conditions.push(eq(wageAdvances.workerId, workerId));

  const rows = await db
    .select({
      id: wageAdvances.id,
      workerId: wageAdvances.workerId,
      workerName: workers.name,
      amount: wageAdvances.amount,
      date: wageAdvances.date,
      notes: wageAdvances.notes,
      createdByUserId: wageAdvances.createdByUserId,
      createdByName: users.name,
      createdAt: wageAdvances.createdAt,
    })
    .from(wageAdvances)
    .innerJoin(workers, eq(wageAdvances.workerId, workers.id))
    .innerJoin(users, eq(wageAdvances.createdByUserId, users.id))
    .where(and(...conditions))
    .orderBy(desc(wageAdvances.date));

  return res.json(rows);
});

router.post("/", requirePermission("manage_labor"), async (req, res) => {
  const schema = z.object({
    workerId: z.string().uuid(),
    amount: z.union([z.string(), z.number()]),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    notes: z.string().optional().nullable(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request" });

  const amount = Number(parsed.data.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: "Amount must be positive" });
  }

  const worker = await db.query.workers.findFirst({
    where: and(
      eq(workers.id, parsed.data.workerId),
      eq(workers.companyId, req.companyId!)
    ),
  });
  if (!worker) return res.status(404).json({ error: "Worker not found" });

  const [row] = await db
    .insert(wageAdvances)
    .values({
      companyId: req.companyId!,
      workerId: worker.id,
      amount: String(amount),
      date: parsed.data.date,
      notes: parsed.data.notes ?? null,
      createdByUserId: req.user!.id,
    })
    .returning();

  return res.status(201).json(row);
});

router.delete("/:id", requirePermission("manage_labor"), async (req, res) => {
  const existing = await db.query.wageAdvances.findFirst({
    where: and(
      eq(wageAdvances.id, req.params.id!),
      eq(wageAdvances.companyId, req.companyId!)
    ),
  });
  if (!existing) return res.status(404).json({ error: "Advance not found" });
  await db.delete(wageAdvances).where(eq(wageAdvances.id, existing.id));
  return res.json({ ok: true });
});

export default router;
