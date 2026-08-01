import { Router } from "express";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import {
  attendanceRecords,
  siteWorkers,
  sites,
  users,
  workers,
  type AttendanceStatus,
} from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { requireCompany, requirePermission } from "../middleware/company.js";

const router = Router();
router.use(requireAuth, requireCompany);

const statusEnum = z.enum(["present", "half_day", "absent", "paid_leave"]);

router.get("/board", requirePermission("view"), async (req, res) => {
  const siteId = typeof req.query.siteId === "string" ? req.query.siteId : "";
  const date = typeof req.query.date === "string" ? req.query.date : "";
  if (!siteId || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "siteId and date (YYYY-MM-DD) are required" });
  }

  const site = await db.query.sites.findFirst({
    where: and(eq(sites.id, siteId), eq(sites.companyId, req.companyId!)),
  });
  if (!site) return res.status(404).json({ error: "Site not found" });

  // Show all active company workers so small teams appear without site assignment.
  // Prefer assigned workers first when both exist; still include unassigned actives.
  const assignedRows = await db
    .select({ workerId: siteWorkers.workerId })
    .from(siteWorkers)
    .where(eq(siteWorkers.siteId, site.id));
  const assignedIds = new Set(assignedRows.map((r) => r.workerId));

  const roster = await db
    .select({
      workerId: workers.id,
      name: workers.name,
      phone: workers.phone,
      trade: workers.trade,
      workerType: workers.workerType,
      payType: workers.payType,
      status: workers.status,
    })
    .from(workers)
    .where(and(eq(workers.companyId, req.companyId!), eq(workers.status, "active")))
    .orderBy(asc(workers.name));

  const records = await db
    .select({
      id: attendanceRecords.id,
      workerId: attendanceRecords.workerId,
      status: attendanceRecords.status,
      otHours: attendanceRecords.otHours,
      notes: attendanceRecords.notes,
      markedByUserId: attendanceRecords.markedByUserId,
      markedByName: users.name,
      updatedAt: attendanceRecords.updatedAt,
    })
    .from(attendanceRecords)
    .innerJoin(users, eq(attendanceRecords.markedByUserId, users.id))
    .where(
      and(
        eq(attendanceRecords.siteId, site.id),
        eq(attendanceRecords.date, date),
        eq(attendanceRecords.companyId, req.companyId!)
      )
    );

  const byWorker = new Map(records.map((r) => [r.workerId, r]));

  // Assigned workers first, then the rest of the active roster
  const ordered = [
    ...roster.filter((w) => assignedIds.has(w.workerId)),
    ...roster.filter((w) => !assignedIds.has(w.workerId)),
  ];

  const board = ordered.map((w) => {
    const rec = byWorker.get(w.workerId);
    return {
      workerId: w.workerId,
      name: w.name,
      phone: w.phone,
      trade: w.trade,
      workerType: w.workerType,
      payType: w.payType,
      assignedToSite: assignedIds.has(w.workerId),
      attendance: rec
        ? {
            id: rec.id,
            status: rec.status,
            otHours: rec.otHours,
            notes: rec.notes,
            markedByUserId: rec.markedByUserId,
            markedByName: rec.markedByName,
            updatedAt: rec.updatedAt,
          }
        : null,
    };
  });

  const summary = {
    total: board.length,
    present: board.filter((b) => b.attendance?.status === "present").length,
    halfDay: board.filter((b) => b.attendance?.status === "half_day").length,
    absent: board.filter((b) => b.attendance?.status === "absent").length,
    paidLeave: board.filter((b) => b.attendance?.status === "paid_leave").length,
    unmarked: board.filter((b) => !b.attendance).length,
  };

  return res.json({ site, date, workers: board, summary });
});

router.put("/board", requirePermission("mark_attendance"), async (req, res) => {
  const schema = z.object({
    siteId: z.string().uuid(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    marks: z
      .array(
        z.object({
          workerId: z.string().uuid(),
          status: statusEnum,
          otHours: z.union([z.string(), z.number()]).optional().nullable(),
          notes: z.string().optional().nullable(),
        })
      )
      .min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request" });

  const site = await db.query.sites.findFirst({
    where: and(
      eq(sites.id, parsed.data.siteId),
      eq(sites.companyId, req.companyId!)
    ),
  });
  if (!site) return res.status(404).json({ error: "Site not found" });

  const companyWorkers = await db
    .select({ id: workers.id })
    .from(workers)
    .where(and(eq(workers.companyId, req.companyId!), eq(workers.status, "active")));
  const companyWorkerIds = new Set(companyWorkers.map((w) => w.id));

  const assigned = await db.query.siteWorkers.findMany({
    where: eq(siteWorkers.siteId, site.id),
  });
  const assignedIds = new Set(assigned.map((a) => a.workerId));

  const userId = req.user!.id;
  const now = new Date();
  const results = [];

  for (const mark of parsed.data.marks) {
    if (!companyWorkerIds.has(mark.workerId)) {
      return res.status(400).json({
        error: "Worker not found or inactive in this company",
      });
    }

    // Auto-assign to site when marking so wage periods by site stay consistent
    if (!assignedIds.has(mark.workerId)) {
      await db.insert(siteWorkers).values({
        siteId: site.id,
        workerId: mark.workerId,
      });
      assignedIds.add(mark.workerId);
    }

    const otHours = String(mark.otHours ?? "0");
    const existing = await db.query.attendanceRecords.findFirst({
      where: and(
        eq(attendanceRecords.siteId, site.id),
        eq(attendanceRecords.workerId, mark.workerId),
        eq(attendanceRecords.date, parsed.data.date)
      ),
    });

    if (existing) {
      const [row] = await db
        .update(attendanceRecords)
        .set({
          status: mark.status as AttendanceStatus,
          otHours,
          notes: mark.notes ?? null,
          markedByUserId: userId,
          updatedAt: now,
        })
        .where(eq(attendanceRecords.id, existing.id))
        .returning();
      results.push(row);
    } else {
      const [row] = await db
        .insert(attendanceRecords)
        .values({
          companyId: req.companyId!,
          siteId: site.id,
          workerId: mark.workerId,
          date: parsed.data.date,
          status: mark.status as AttendanceStatus,
          otHours,
          notes: mark.notes ?? null,
          markedByUserId: userId,
        })
        .returning();
      results.push(row);
    }
  }

  return res.json({ ok: true, records: results });
});

router.get("/history", requirePermission("view"), async (req, res) => {
  const siteId = typeof req.query.siteId === "string" ? req.query.siteId : undefined;
  const from = typeof req.query.from === "string" ? req.query.from : undefined;
  const to = typeof req.query.to === "string" ? req.query.to : undefined;

  const conditions = [eq(attendanceRecords.companyId, req.companyId!)];
  if (siteId) conditions.push(eq(attendanceRecords.siteId, siteId));
  if (from) conditions.push(gte(attendanceRecords.date, from));
  if (to) conditions.push(lte(attendanceRecords.date, to));

  const rows = await db
    .select({
      id: attendanceRecords.id,
      date: attendanceRecords.date,
      status: attendanceRecords.status,
      otHours: attendanceRecords.otHours,
      notes: attendanceRecords.notes,
      siteId: attendanceRecords.siteId,
      siteName: sites.name,
      workerId: attendanceRecords.workerId,
      workerName: workers.name,
      markedByName: users.name,
    })
    .from(attendanceRecords)
    .innerJoin(sites, eq(attendanceRecords.siteId, sites.id))
    .innerJoin(workers, eq(attendanceRecords.workerId, workers.id))
    .innerJoin(users, eq(attendanceRecords.markedByUserId, users.id))
    .where(and(...conditions))
    .orderBy(asc(attendanceRecords.date));

  return res.json(rows);
});

export default router;
