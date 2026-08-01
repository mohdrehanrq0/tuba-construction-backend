import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { siteWorkers, sites, workers } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { requireCompany, requirePermission } from "../middleware/company.js";

const router = Router();
router.use(requireAuth, requireCompany);

const workerBody = z.object({
  name: z.string().min(1),
  phone: z.string().optional().nullable(),
  trade: z.string().optional().nullable(),
  workerType: z.enum(["laborer", "contract_worker", "staff"]).optional(),
  payType: z.enum(["daily", "monthly", "contract"]).optional(),
  dailyWage: z.union([z.string(), z.number()]).optional().nullable(),
  monthlySalary: z.union([z.string(), z.number()]).optional().nullable(),
  contractAmount: z.union([z.string(), z.number()]).optional().nullable(),
  otRate: z.union([z.string(), z.number()]).optional().nullable(),
  joinDate: z.string().optional().nullable(),
  status: z.enum(["active", "inactive"]).optional(),
  notes: z.string().optional().nullable(),
  siteIds: z.array(z.string().uuid()).optional(),
});

function money(v: string | number | null | undefined) {
  if (v === null || v === undefined || v === "") return null;
  return String(v);
}

router.get("/", requirePermission("view"), async (req, res) => {
  const companyId = req.companyId!;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const payType = typeof req.query.payType === "string" ? req.query.payType : undefined;
  const workerType =
    typeof req.query.workerType === "string" ? req.query.workerType : undefined;

  const conditions = [eq(workers.companyId, companyId)];
  if (status === "active" || status === "inactive") {
    conditions.push(eq(workers.status, status));
  }
  if (payType === "daily" || payType === "monthly" || payType === "contract") {
    conditions.push(eq(workers.payType, payType));
  }
  if (
    workerType === "laborer" ||
    workerType === "contract_worker" ||
    workerType === "staff"
  ) {
    conditions.push(eq(workers.workerType, workerType));
  }

  const rows = await db.query.workers.findMany({
    where: and(...conditions),
    orderBy: (w, { asc: a }) => [a(w.name)],
    with: {
      siteWorkers: {
        with: {
          site: true,
        },
      },
    },
  });

  return res.json(
    rows.map((w) => ({
      ...w,
      sites: w.siteWorkers.map((sw) => ({
        id: sw.site.id,
        name: sw.site.name,
        code: sw.site.code,
        status: sw.site.status,
        assignmentId: sw.id,
      })),
      siteWorkers: undefined,
    }))
  );
});

router.get("/:id", requirePermission("view"), async (req, res) => {
  const row = await db.query.workers.findFirst({
    where: and(eq(workers.id, req.params.id!), eq(workers.companyId, req.companyId!)),
    with: {
      siteWorkers: {
        with: { site: true },
      },
    },
  });
  if (!row) return res.status(404).json({ error: "Worker not found" });
  return res.json({
    ...row,
    sites: row.siteWorkers.map((sw) => ({
      id: sw.site.id,
      name: sw.site.name,
      code: sw.site.code,
      status: sw.site.status,
      assignmentId: sw.id,
      startDate: sw.startDate,
      endDate: sw.endDate,
    })),
    siteWorkers: undefined,
  });
});

router.post("/", requirePermission("manage_labor"), async (req, res) => {
  const parsed = workerBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request" });

  const data = parsed.data;
  const [row] = await db
    .insert(workers)
    .values({
      companyId: req.companyId!,
      name: data.name,
      phone: data.phone ?? null,
      trade: data.trade ?? null,
      workerType: data.workerType ?? "laborer",
      payType: data.payType ?? "daily",
      dailyWage: money(data.dailyWage),
      monthlySalary: money(data.monthlySalary),
      contractAmount: money(data.contractAmount),
      otRate: money(data.otRate),
      joinDate: data.joinDate || null,
      status: data.status ?? "active",
      notes: data.notes ?? null,
    })
    .returning();

  if (data.siteIds?.length) {
    const companySites = await db.query.sites.findMany({
      where: eq(sites.companyId, req.companyId!),
    });
    const allowed = new Set(companySites.map((s) => s.id));
    const toInsert = data.siteIds
      .filter((id) => allowed.has(id))
      .map((siteId) => ({ siteId, workerId: row!.id }));
    if (toInsert.length) await db.insert(siteWorkers).values(toInsert);
  }

  return res.status(201).json(row);
});

router.patch("/:id", requirePermission("manage_labor"), async (req, res) => {
  const parsed = workerBody.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request" });

  const existing = await db.query.workers.findFirst({
    where: and(eq(workers.id, req.params.id!), eq(workers.companyId, req.companyId!)),
  });
  if (!existing) return res.status(404).json({ error: "Worker not found" });

  const data = parsed.data;
  const [row] = await db
    .update(workers)
    .set({
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.phone !== undefined ? { phone: data.phone } : {}),
      ...(data.trade !== undefined ? { trade: data.trade } : {}),
      ...(data.workerType !== undefined ? { workerType: data.workerType } : {}),
      ...(data.payType !== undefined ? { payType: data.payType } : {}),
      ...(data.dailyWage !== undefined ? { dailyWage: money(data.dailyWage) } : {}),
      ...(data.monthlySalary !== undefined
        ? { monthlySalary: money(data.monthlySalary) }
        : {}),
      ...(data.contractAmount !== undefined
        ? { contractAmount: money(data.contractAmount) }
        : {}),
      ...(data.otRate !== undefined ? { otRate: money(data.otRate) } : {}),
      ...(data.joinDate !== undefined ? { joinDate: data.joinDate || null } : {}),
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.notes !== undefined ? { notes: data.notes } : {}),
      updatedAt: new Date(),
    })
    .where(eq(workers.id, existing.id))
    .returning();

  if (data.siteIds) {
    await db.delete(siteWorkers).where(eq(siteWorkers.workerId, existing.id));
    const companySites = await db.query.sites.findMany({
      where: eq(sites.companyId, req.companyId!),
    });
    const allowed = new Set(companySites.map((s) => s.id));
    const toInsert = data.siteIds
      .filter((id) => allowed.has(id))
      .map((siteId) => ({ siteId, workerId: existing.id }));
    if (toInsert.length) await db.insert(siteWorkers).values(toInsert);
  }

  return res.json(row);
});

router.delete("/:id", requirePermission("manage_labor"), async (req, res) => {
  const existing = await db.query.workers.findFirst({
    where: and(eq(workers.id, req.params.id!), eq(workers.companyId, req.companyId!)),
  });
  if (!existing) return res.status(404).json({ error: "Worker not found" });
  await db.delete(workers).where(eq(workers.id, existing.id));
  return res.json({ ok: true });
});

export default router;
