import { Router } from "express";
import { and, eq, gte, lte, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import {
  attendanceRecords,
  siteWorkers,
  sites,
  wageAdvances,
  wagePeriodLines,
  wagePeriods,
  workers,
  type AttendanceStatus,
  type PayType,
} from "../db/schema.js";
import {
  computeWageLine,
  daysInclusive,
} from "../lib/wages.js";
import { requireAuth } from "../middleware/auth.js";
import { requireCompany, requirePermission } from "../middleware/company.js";

const router = Router();
router.use(requireAuth, requireCompany);

type WorkerRow = {
  id: string;
  payType: PayType;
  dailyWage: string | null;
  monthlySalary: string | null;
  contractAmount: string | null;
  otRate: string | null;
  status: string;
};

async function loadPeriod(companyId: string, id: string) {
  return db.query.wagePeriods.findFirst({
    where: and(eq(wagePeriods.id, id), eq(wagePeriods.companyId, companyId)),
    with: {
      site: true,
      lines: {
        with: { worker: true },
      },
    },
  });
}

function serializePeriod(period: NonNullable<Awaited<ReturnType<typeof loadPeriod>>>) {
  const lines = [...period.lines].sort((a, b) =>
    a.worker.name.localeCompare(b.worker.name)
  );
  return {
    id: period.id,
    companyId: period.companyId,
    siteId: period.siteId,
    siteName: period.site?.name ?? null,
    startDate: period.startDate,
    endDate: period.endDate,
    status: period.status,
    notes: period.notes,
    createdByUserId: period.createdByUserId,
    createdAt: period.createdAt,
    updatedAt: period.updatedAt,
    lines: lines.map((line) => ({
      id: line.id,
      workerId: line.workerId,
      workerName: line.worker.name,
      trade: line.worker.trade,
      workerType: line.worker.workerType,
      payType: line.payType,
      fullDays: line.fullDays,
      halfDays: line.halfDays,
      otHours: line.otHours,
      rateSnapshot: line.rateSnapshot,
      contractAmountSnapshot: line.contractAmountSnapshot,
      gross: line.gross,
      advancesDeducted: line.advancesDeducted,
      adjustment: line.adjustment,
      net: line.net,
      notes: line.notes,
    })),
    totals: {
      gross: lines.reduce((s, l) => s + Number(l.gross), 0),
      advances: lines.reduce((s, l) => s + Number(l.advancesDeducted), 0),
      net: lines.reduce((s, l) => s + Number(l.net), 0),
    },
  };
}

async function resolveWorkersInScope(
  companyId: string,
  siteId: string | null,
  startDate: string,
  endDate: string
): Promise<WorkerRow[]> {
  const selectCols = {
    id: workers.id,
    payType: workers.payType,
    dailyWage: workers.dailyWage,
    monthlySalary: workers.monthlySalary,
    contractAmount: workers.contractAmount,
    otRate: workers.otRate,
    status: workers.status,
  };

  let workerRows: WorkerRow[];

  if (siteId) {
    // Assigned to site OR had attendance at this site in the period
    const assigned = await db
      .select(selectCols)
      .from(siteWorkers)
      .innerJoin(workers, eq(siteWorkers.workerId, workers.id))
      .where(and(eq(siteWorkers.siteId, siteId), eq(workers.status, "active")));

    const fromAttendance = await db
      .select(selectCols)
      .from(attendanceRecords)
      .innerJoin(workers, eq(attendanceRecords.workerId, workers.id))
      .where(
        and(
          eq(attendanceRecords.companyId, companyId),
          eq(attendanceRecords.siteId, siteId),
          gte(attendanceRecords.date, startDate),
          lte(attendanceRecords.date, endDate),
          eq(workers.status, "active")
        )
      );

    workerRows = [...assigned, ...fromAttendance];
  } else {
    workerRows = await db
      .select(selectCols)
      .from(workers)
      .where(and(eq(workers.companyId, companyId), eq(workers.status, "active")));
  }

  return Array.from(new Map(workerRows.map((w) => [w.id, w])).values());
}

async function buildLineValues(opts: {
  companyId: string;
  wagePeriodId: string;
  siteId: string | null;
  startDate: string;
  endDate: string;
  /** Preserve prior adjustments by workerId when recalculating */
  previousAdjustments?: Map<string, { adjustment: string; notes: string | null }>;
}) {
  const uniqueWorkers = await resolveWorkersInScope(
    opts.companyId,
    opts.siteId,
    opts.startDate,
    opts.endDate
  );

  const attendanceConditions = [
    eq(attendanceRecords.companyId, opts.companyId),
    gte(attendanceRecords.date, opts.startDate),
    lte(attendanceRecords.date, opts.endDate),
  ];
  if (opts.siteId) {
    attendanceConditions.push(eq(attendanceRecords.siteId, opts.siteId));
  }

  const attendance = uniqueWorkers.length
    ? await db
        .select()
        .from(attendanceRecords)
        .where(and(...attendanceConditions))
    : [];

  const advances = uniqueWorkers.length
    ? await db
        .select()
        .from(wageAdvances)
        .where(
          and(
            eq(wageAdvances.companyId, opts.companyId),
            gte(wageAdvances.date, opts.startDate),
            lte(wageAdvances.date, opts.endDate),
            inArray(
              wageAdvances.workerId,
              uniqueWorkers.map((w) => w.id)
            )
          )
        )
    : [];

  const calendarDays = daysInclusive(opts.startDate, opts.endDate);

  return uniqueWorkers.map((w) => {
    const workerAtt = attendance.filter((a) => a.workerId === w.id);
    const byDate = new Map<string, { status: AttendanceStatus; ot: number }>();
    for (const a of workerAtt) {
      const prev = byDate.get(a.date);
      const ot = Number(a.otHours);
      if (!prev) {
        byDate.set(a.date, { status: a.status, ot });
      } else {
        const rank = { present: 4, paid_leave: 3, half_day: 2, absent: 1 };
        if (rank[a.status] > rank[prev.status]) prev.status = a.status;
        prev.ot += ot;
      }
    }

    let fullDays = 0;
    let halfDays = 0;
    let otHours = 0;
    for (const day of byDate.values()) {
      if (day.status === "present" || day.status === "paid_leave") fullDays += 1;
      else if (day.status === "half_day") halfDays += 1;
      otHours += day.ot;
    }

    const advSum = advances
      .filter((a) => a.workerId === w.id)
      .reduce((s, a) => s + Number(a.amount), 0);

    const prevAdj = opts.previousAdjustments?.get(w.id);
    const adjustment = prevAdj ? Number(prevAdj.adjustment) : 0;

    const computed = computeWageLine({
      payType: w.payType as PayType,
      fullDays,
      halfDays,
      otHours,
      dailyWage: Number(w.dailyWage ?? 0),
      monthlySalary: Number(w.monthlySalary ?? 0),
      otRate: Number(w.otRate ?? 0),
      contractAmount: Number(w.contractAmount ?? 0),
      calendarDays,
      advances: advSum,
      adjustment,
    });

    return {
      wagePeriodId: opts.wagePeriodId,
      workerId: w.id,
      payType: w.payType,
      fullDays: String(fullDays),
      halfDays: String(halfDays),
      otHours: String(otHours),
      rateSnapshot: computed.rateSnapshot != null ? String(computed.rateSnapshot) : null,
      contractAmountSnapshot:
        computed.contractAmountSnapshot != null
          ? String(computed.contractAmountSnapshot)
          : null,
      gross: String(computed.gross),
      advancesDeducted: String(computed.advancesDeducted),
      adjustment: String(adjustment),
      net: String(computed.net),
      notes: prevAdj?.notes ?? null,
    };
  });
}

router.get("/", requirePermission("view"), async (req, res) => {
  const rows = await db.query.wagePeriods.findMany({
    where: eq(wagePeriods.companyId, req.companyId!),
    orderBy: (p, { desc: d }) => [d(p.startDate)],
    with: { site: true, lines: true },
  });

  return res.json(
    rows.map((p) => ({
      id: p.id,
      siteId: p.siteId,
      siteName: p.site?.name ?? null,
      startDate: p.startDate,
      endDate: p.endDate,
      status: p.status,
      notes: p.notes,
      lineCount: p.lines.length,
      totalNet: p.lines.reduce((s, l) => s + Number(l.net), 0),
      createdAt: p.createdAt,
    }))
  );
});

router.get("/:id", requirePermission("view"), async (req, res) => {
  const period = await loadPeriod(req.companyId!, req.params.id!);
  if (!period) return res.status(404).json({ error: "Wage period not found" });
  return res.json(serializePeriod(period));
});

router.post("/", requirePermission("manage_labor"), async (req, res) => {
  const schema = z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    siteId: z.string().uuid().optional().nullable(),
    notes: z.string().optional().nullable(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request" });
  if (parsed.data.endDate < parsed.data.startDate) {
    return res.status(400).json({ error: "endDate must be on or after startDate" });
  }

  let siteId: string | null = parsed.data.siteId ?? null;
  if (siteId) {
    const site = await db.query.sites.findFirst({
      where: and(eq(sites.id, siteId), eq(sites.companyId, req.companyId!)),
    });
    if (!site) return res.status(404).json({ error: "Site not found" });
  }

  const [period] = await db
    .insert(wagePeriods)
    .values({
      companyId: req.companyId!,
      siteId,
      startDate: parsed.data.startDate,
      endDate: parsed.data.endDate,
      notes: parsed.data.notes ?? null,
      createdByUserId: req.user!.id,
      status: "draft",
    })
    .returning();

  const lineValues = await buildLineValues({
    companyId: req.companyId!,
    wagePeriodId: period!.id,
    siteId,
    startDate: parsed.data.startDate,
    endDate: parsed.data.endDate,
  });

  if (lineValues.length) {
    await db.insert(wagePeriodLines).values(lineValues);
  }

  const full = await loadPeriod(req.companyId!, period!.id);
  return res.status(201).json(serializePeriod(full!));
});

/** Recompute lines from latest attendance + advances (draft only). */
router.post("/:id/recalculate", requirePermission("manage_labor"), async (req, res) => {
  const schema = z.object({
    /** Keep manual adjustments / contract milestones (default true) */
    preserveAdjustments: z.boolean().optional().default(true),
    /** Reopen a finalized period back to draft before recalculating */
    reopen: z.boolean().optional().default(false),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Invalid request" });

  const period = await db.query.wagePeriods.findFirst({
    where: and(
      eq(wagePeriods.id, req.params.id!),
      eq(wagePeriods.companyId, req.companyId!)
    ),
    with: { lines: true },
  });
  if (!period) return res.status(404).json({ error: "Wage period not found" });

  if (period.status === "paid") {
    return res.status(400).json({ error: "Paid periods cannot be recalculated" });
  }

  if (period.status === "finalized") {
    if (!parsed.data.reopen) {
      return res.status(400).json({
        error: "Period is finalized. Pass reopen: true to unlock and recalculate.",
      });
    }
    await db
      .update(wagePeriods)
      .set({ status: "draft", updatedAt: new Date() })
      .where(eq(wagePeriods.id, period.id));
  } else if (period.status !== "draft") {
    return res.status(400).json({ error: "Only draft (or reopenable finalized) periods can be recalculated" });
  }

  const previousAdjustments = parsed.data.preserveAdjustments
    ? new Map(
        period.lines.map((l) => [
          l.workerId,
          { adjustment: l.adjustment, notes: l.notes },
        ])
      )
    : undefined;

  await db.delete(wagePeriodLines).where(eq(wagePeriodLines.wagePeriodId, period.id));

  const lineValues = await buildLineValues({
    companyId: req.companyId!,
    wagePeriodId: period.id,
    siteId: period.siteId,
    startDate: period.startDate,
    endDate: period.endDate,
    previousAdjustments,
  });

  if (lineValues.length) {
    await db.insert(wagePeriodLines).values(lineValues);
  }

  await db
    .update(wagePeriods)
    .set({ updatedAt: new Date() })
    .where(eq(wagePeriods.id, period.id));

  const full = await loadPeriod(req.companyId!, period.id);
  return res.json(serializePeriod(full!));
});

router.patch("/:id/lines/:lineId", requirePermission("manage_labor"), async (req, res) => {
  const schema = z.object({
    adjustment: z.union([z.string(), z.number()]).optional(),
    advancesDeducted: z.union([z.string(), z.number()]).optional(),
    notes: z.string().nullable().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request" });

  const period = await db.query.wagePeriods.findFirst({
    where: and(
      eq(wagePeriods.id, req.params.id!),
      eq(wagePeriods.companyId, req.companyId!)
    ),
  });
  if (!period) return res.status(404).json({ error: "Wage period not found" });
  if (period.status !== "draft") {
    return res.status(400).json({ error: "Only draft periods can be edited" });
  }

  const line = await db.query.wagePeriodLines.findFirst({
    where: and(
      eq(wagePeriodLines.id, req.params.lineId!),
      eq(wagePeriodLines.wagePeriodId, period.id)
    ),
  });
  if (!line) return res.status(404).json({ error: "Line not found" });

  const adjustment =
    parsed.data.adjustment !== undefined
      ? Number(parsed.data.adjustment)
      : Number(line.adjustment);
  const advancesDeducted =
    parsed.data.advancesDeducted !== undefined
      ? Number(parsed.data.advancesDeducted)
      : Number(line.advancesDeducted);
  const gross = Number(line.gross);
  const net = Math.round((gross - advancesDeducted + adjustment) * 100) / 100;

  const [updated] = await db
    .update(wagePeriodLines)
    .set({
      adjustment: String(adjustment),
      advancesDeducted: String(advancesDeducted),
      net: String(net),
      ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
    })
    .where(eq(wagePeriodLines.id, line.id))
    .returning();

  await db
    .update(wagePeriods)
    .set({ updatedAt: new Date() })
    .where(eq(wagePeriods.id, period.id));

  return res.json(updated);
});

router.post("/:id/finalize", requirePermission("manage_labor"), async (req, res) => {
  const period = await db.query.wagePeriods.findFirst({
    where: and(
      eq(wagePeriods.id, req.params.id!),
      eq(wagePeriods.companyId, req.companyId!)
    ),
  });
  if (!period) return res.status(404).json({ error: "Wage period not found" });
  if (period.status !== "draft") {
    return res.status(400).json({ error: "Only draft periods can be finalized" });
  }

  await db
    .update(wagePeriods)
    .set({ status: "finalized", updatedAt: new Date() })
    .where(eq(wagePeriods.id, period.id));

  const full = await loadPeriod(req.companyId!, period.id);
  return res.json(serializePeriod(full!));
});

router.post("/:id/paid", requirePermission("manage_labor"), async (req, res) => {
  const period = await db.query.wagePeriods.findFirst({
    where: and(
      eq(wagePeriods.id, req.params.id!),
      eq(wagePeriods.companyId, req.companyId!)
    ),
  });
  if (!period) return res.status(404).json({ error: "Wage period not found" });
  if (period.status !== "finalized") {
    return res.status(400).json({ error: "Only finalized periods can be marked paid" });
  }

  await db
    .update(wagePeriods)
    .set({ status: "paid", updatedAt: new Date() })
    .where(eq(wagePeriods.id, period.id));

  const full = await loadPeriod(req.companyId!, period.id);
  return res.json(serializePeriod(full!));
});

router.delete("/:id", requirePermission("manage_labor"), async (req, res) => {
  const period = await db.query.wagePeriods.findFirst({
    where: and(
      eq(wagePeriods.id, req.params.id!),
      eq(wagePeriods.companyId, req.companyId!)
    ),
  });
  if (!period) return res.status(404).json({ error: "Wage period not found" });
  if (period.status !== "draft") {
    return res.status(400).json({ error: "Only draft periods can be deleted" });
  }
  await db.delete(wagePeriods).where(eq(wagePeriods.id, period.id));
  return res.json({ ok: true });
});

export default router;
