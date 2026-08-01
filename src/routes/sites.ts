import { Router } from "express";
import { and, eq, asc } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { sites, siteWorkers, workers } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { requireCompany, requirePermission } from "../middleware/company.js";

const router = Router();
router.use(requireAuth, requireCompany);

router.get("/", requirePermission("view"), async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const rows = await db.query.sites.findMany({
    where: status
      ? and(eq(sites.companyId, req.companyId!), eq(sites.status, status as "active" | "completed"))
      : eq(sites.companyId, req.companyId!),
    orderBy: (s, { asc: a }) => [a(s.name)],
  });
  return res.json(rows);
});

router.get("/:id", requirePermission("view"), async (req, res) => {
  const row = await db.query.sites.findFirst({
    where: and(eq(sites.id, req.params.id!), eq(sites.companyId, req.companyId!)),
  });
  if (!row) return res.status(404).json({ error: "Site not found" });

  const assignments = await db
    .select({
      id: siteWorkers.id,
      workerId: siteWorkers.workerId,
      startDate: siteWorkers.startDate,
      endDate: siteWorkers.endDate,
      workerName: workers.name,
      trade: workers.trade,
      workerType: workers.workerType,
      payType: workers.payType,
      workerStatus: workers.status,
    })
    .from(siteWorkers)
    .innerJoin(workers, eq(siteWorkers.workerId, workers.id))
    .where(eq(siteWorkers.siteId, row.id))
    .orderBy(asc(workers.name));

  return res.json({ ...row, workers: assignments });
});

router.post("/", requirePermission("manage_labor"), async (req, res) => {
  const schema = z.object({
    name: z.string().min(1),
    code: z.string().optional().nullable(),
    address: z.string().optional().nullable(),
    status: z.enum(["active", "completed"]).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request" });

  const [row] = await db
    .insert(sites)
    .values({
      companyId: req.companyId!,
      name: parsed.data.name,
      code: parsed.data.code ?? null,
      address: parsed.data.address ?? null,
      status: parsed.data.status ?? "active",
    })
    .returning();
  return res.status(201).json(row);
});

router.patch("/:id", requirePermission("manage_labor"), async (req, res) => {
  const schema = z.object({
    name: z.string().min(1).optional(),
    code: z.string().nullable().optional(),
    address: z.string().nullable().optional(),
    status: z.enum(["active", "completed"]).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request" });

  const existing = await db.query.sites.findFirst({
    where: and(eq(sites.id, req.params.id!), eq(sites.companyId, req.companyId!)),
  });
  if (!existing) return res.status(404).json({ error: "Site not found" });

  const [row] = await db
    .update(sites)
    .set({
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.code !== undefined ? { code: parsed.data.code } : {}),
      ...(parsed.data.address !== undefined ? { address: parsed.data.address } : {}),
      ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
      updatedAt: new Date(),
    })
    .where(eq(sites.id, existing.id))
    .returning();
  return res.json(row);
});

router.delete("/:id", requirePermission("manage_labor"), async (req, res) => {
  const existing = await db.query.sites.findFirst({
    where: and(eq(sites.id, req.params.id!), eq(sites.companyId, req.companyId!)),
  });
  if (!existing) return res.status(404).json({ error: "Site not found" });
  await db.delete(sites).where(eq(sites.id, existing.id));
  return res.json({ ok: true });
});

router.post("/:id/workers", requirePermission("manage_labor"), async (req, res) => {
  const schema = z.object({
    workerId: z.string().uuid(),
    startDate: z.string().optional().nullable(),
    endDate: z.string().optional().nullable(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request" });

  const site = await db.query.sites.findFirst({
    where: and(eq(sites.id, req.params.id!), eq(sites.companyId, req.companyId!)),
  });
  if (!site) return res.status(404).json({ error: "Site not found" });

  const worker = await db.query.workers.findFirst({
    where: and(
      eq(workers.id, parsed.data.workerId),
      eq(workers.companyId, req.companyId!)
    ),
  });
  if (!worker) return res.status(404).json({ error: "Worker not found" });

  const existing = await db.query.siteWorkers.findFirst({
    where: and(
      eq(siteWorkers.siteId, site.id),
      eq(siteWorkers.workerId, worker.id)
    ),
  });
  if (existing) return res.status(409).json({ error: "Worker already assigned to this site" });

  const [row] = await db
    .insert(siteWorkers)
    .values({
      siteId: site.id,
      workerId: worker.id,
      startDate: parsed.data.startDate || null,
      endDate: parsed.data.endDate || null,
    })
    .returning();
  return res.status(201).json(row);
});

router.delete(
  "/:id/workers/:workerId",
  requirePermission("manage_labor"),
  async (req, res) => {
    const site = await db.query.sites.findFirst({
      where: and(eq(sites.id, req.params.id!), eq(sites.companyId, req.companyId!)),
    });
    if (!site) return res.status(404).json({ error: "Site not found" });

    const assignment = await db.query.siteWorkers.findFirst({
      where: and(
        eq(siteWorkers.siteId, site.id),
        eq(siteWorkers.workerId, req.params.workerId!)
      ),
    });
    if (!assignment) return res.status(404).json({ error: "Assignment not found" });

    await db.delete(siteWorkers).where(eq(siteWorkers.id, assignment.id));
    return res.json({ ok: true });
  }
);

export default router;
