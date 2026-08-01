import { Router } from "express";
import { and, asc, count, eq, gte, lte, sql, sum } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  attendanceRecords,
  customers,
  invoices,
  products,
  quotations,
  siteWorkers,
  sites,
  units,
  wagePeriodLines,
  wagePeriods,
  workers,
} from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { requireCompany, requirePermission } from "../middleware/company.js";

const router = Router();
router.use(requireAuth, requireCompany, requirePermission("view"));

function monthBounds(year: number, month: number) {
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const endDate = new Date(Date.UTC(year, month, 0));
  const end = endDate.toISOString().slice(0, 10);
  return { start, end };
}

function previousMonth(year: number, month: number) {
  if (month <= 1) return { year: year - 1, month: 12 };
  return { year, month: month - 1 };
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

router.get("/", async (req, res) => {
  const companyId = req.companyId!;
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  // Discover years that actually have activity (plus current year)
  const [qYears, iYears, aYears, wYears] = await Promise.all([
    db
      .select({
        year: sql<number>`extract(year from ${quotations.createdAt})::int`,
      })
      .from(quotations)
      .where(eq(quotations.companyId, companyId))
      .groupBy(sql`extract(year from ${quotations.createdAt})`),
    db
      .select({
        year: sql<number>`extract(year from ${invoices.createdAt})::int`,
      })
      .from(invoices)
      .where(eq(invoices.companyId, companyId))
      .groupBy(sql`extract(year from ${invoices.createdAt})`),
    db
      .select({
        year: sql<number>`extract(year from ${attendanceRecords.date}::timestamp)::int`,
      })
      .from(attendanceRecords)
      .where(eq(attendanceRecords.companyId, companyId))
      .groupBy(sql`extract(year from ${attendanceRecords.date}::timestamp)`),
    db
      .select({
        year: sql<number>`extract(year from ${wagePeriods.startDate}::timestamp)::int`,
      })
      .from(wagePeriods)
      .where(eq(wagePeriods.companyId, companyId))
      .groupBy(sql`extract(year from ${wagePeriods.startDate}::timestamp)`),
  ]);

  const yearSet = new Set<number>([currentYear]);
  for (const rows of [qYears, iYears, aYears, wYears]) {
    for (const r of rows) {
      const y = Number(r.year);
      if (Number.isFinite(y) && y >= 2000 && y <= 2100) yearSet.add(y);
    }
  }
  const availableYears = Array.from(yearSet).sort((a, b) => b - a);

  const yearRaw = typeof req.query.year === "string" ? Number(req.query.year) : currentYear;
  const year =
    Number.isFinite(yearRaw) && availableYears.includes(yearRaw)
      ? yearRaw
      : availableYears[0] ?? currentYear;

  // Optional month: used for attendance snapshot / period totals only — not catalog
  const monthRaw =
    typeof req.query.month === "string" && req.query.month !== ""
      ? Number(req.query.month)
      : null;
  const month =
    monthRaw != null && Number.isFinite(monthRaw) && monthRaw >= 1 && monthRaw <= 12
      ? monthRaw
      : null;

  const range = month
    ? monthBounds(year, month)
    : { start: `${year}-01-01`, end: `${year}-12-31` };

  const wageRef =
    month != null
      ? previousMonth(year, month)
      : year === currentYear
        ? previousMonth(currentYear, currentMonth)
        : { year, month: 12 };
  const wageRange = monthBounds(wageRef.year, wageRef.month);

  const yearStart = new Date(`${year}-01-01T00:00:00.000Z`);
  const yearEnd = new Date(`${year}-12-31T23:59:59.999Z`);
  const yearDateStart = `${year}-01-01`;
  const yearDateEnd = `${year}-12-31`;

  const [
    productCount,
    unitCount,
    customerCount,
    workerCount,
    siteRows,
    attendanceAgg,
    quotationPeriod,
    invoicePeriod,
    wageLines,
    wagePeriodRows,
    qSeries,
    iSeries,
    attendanceMonthSeries,
    wageMonthSeries,
  ] = await Promise.all([
    // Catalog — always current company totals (not date-filtered)
    db
      .select({ value: count() })
      .from(products)
      .where(eq(products.companyId, companyId))
      .then((r) => r[0]?.value ?? 0),
    db
      .select({ value: count() })
      .from(units)
      .where(eq(units.companyId, companyId))
      .then((r) => r[0]?.value ?? 0),
    db
      .select({ value: count() })
      .from(customers)
      .where(eq(customers.companyId, companyId))
      .then((r) => r[0]?.value ?? 0),
    db
      .select({ value: count() })
      .from(workers)
      .where(and(eq(workers.companyId, companyId), eq(workers.status, "active")))
      .then((r) => r[0]?.value ?? 0),
    db
      .select({
        id: sites.id,
        name: sites.name,
        code: sites.code,
        status: sites.status,
        address: sites.address,
        workerCount: sql<number>`coalesce(count(${siteWorkers.id}), 0)::int`,
      })
      .from(sites)
      .leftJoin(siteWorkers, eq(siteWorkers.siteId, sites.id))
      .where(eq(sites.companyId, companyId))
      .groupBy(sites.id)
      .orderBy(asc(sites.name)),
    db
      .select({
        status: attendanceRecords.status,
        value: count(),
      })
      .from(attendanceRecords)
      .where(
        and(
          eq(attendanceRecords.companyId, companyId),
          gte(attendanceRecords.date, range.start),
          lte(attendanceRecords.date, range.end)
        )
      )
      .groupBy(attendanceRecords.status),
    db
      .select({
        value: count(),
        total: sum(quotations.total),
      })
      .from(quotations)
      .where(
        and(
          eq(quotations.companyId, companyId),
          gte(quotations.createdAt, new Date(`${range.start}T00:00:00.000Z`)),
          lte(quotations.createdAt, new Date(`${range.end}T23:59:59.999Z`))
        )
      )
      .then((r) => r[0]),
    db
      .select({
        value: count(),
        total: sum(invoices.total),
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.companyId, companyId),
          gte(invoices.createdAt, new Date(`${range.start}T00:00:00.000Z`)),
          lte(invoices.createdAt, new Date(`${range.end}T23:59:59.999Z`))
        )
      )
      .then((r) => r[0]),
    db
      .select({
        gross: sum(wagePeriodLines.gross),
        advances: sum(wagePeriodLines.advancesDeducted),
        net: sum(wagePeriodLines.net),
      })
      .from(wagePeriodLines)
      .innerJoin(wagePeriods, eq(wagePeriodLines.wagePeriodId, wagePeriods.id))
      .where(
        and(
          eq(wagePeriods.companyId, companyId),
          gte(wagePeriods.startDate, wageRange.start),
          lte(wagePeriods.startDate, wageRange.end)
        )
      )
      .then((r) => r[0]),
    db
      .select({
        status: wagePeriods.status,
        value: count(),
      })
      .from(wagePeriods)
      .where(
        and(
          eq(wagePeriods.companyId, companyId),
          gte(wagePeriods.startDate, wageRange.start),
          lte(wagePeriods.startDate, wageRange.end)
        )
      )
      .groupBy(wagePeriods.status),
    // Year chart series
    db
      .select({
        month: sql<number>`extract(month from ${quotations.createdAt})::int`,
        count: count(),
        total: sum(quotations.total),
      })
      .from(quotations)
      .where(
        and(
          eq(quotations.companyId, companyId),
          gte(quotations.createdAt, yearStart),
          lte(quotations.createdAt, yearEnd)
        )
      )
      .groupBy(sql`extract(month from ${quotations.createdAt})`),
    db
      .select({
        month: sql<number>`extract(month from ${invoices.createdAt})::int`,
        count: count(),
        total: sum(invoices.total),
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.companyId, companyId),
          gte(invoices.createdAt, yearStart),
          lte(invoices.createdAt, yearEnd)
        )
      )
      .groupBy(sql`extract(month from ${invoices.createdAt})`),
    db
      .select({
        month: sql<number>`extract(month from ${attendanceRecords.date}::timestamp)::int`,
        status: attendanceRecords.status,
        value: count(),
      })
      .from(attendanceRecords)
      .where(
        and(
          eq(attendanceRecords.companyId, companyId),
          gte(attendanceRecords.date, yearDateStart),
          lte(attendanceRecords.date, yearDateEnd)
        )
      )
      .groupBy(
        sql`extract(month from ${attendanceRecords.date}::timestamp)`,
        attendanceRecords.status
      ),
    db
      .select({
        month: sql<number>`extract(month from ${wagePeriods.startDate}::timestamp)::int`,
        gross: sum(wagePeriodLines.gross),
        advances: sum(wagePeriodLines.advancesDeducted),
        net: sum(wagePeriodLines.net),
      })
      .from(wagePeriodLines)
      .innerJoin(wagePeriods, eq(wagePeriodLines.wagePeriodId, wagePeriods.id))
      .where(
        and(
          eq(wagePeriods.companyId, companyId),
          gte(wagePeriods.startDate, yearDateStart),
          lte(wagePeriods.startDate, yearDateEnd)
        )
      )
      .groupBy(sql`extract(month from ${wagePeriods.startDate}::timestamp)`),
  ]);

  const att = {
    present: 0,
    halfDay: 0,
    absent: 0,
    paidLeave: 0,
  };
  for (const row of attendanceAgg) {
    const n = Number(row.value);
    if (row.status === "present") att.present = n;
    else if (row.status === "half_day") att.halfDay = n;
    else if (row.status === "absent") att.absent = n;
    else if (row.status === "paid_leave") att.paidLeave = n;
  }
  const totalMarks = att.present + att.halfDay + att.absent + att.paidLeave;
  const workedMarks = att.present + att.halfDay * 0.5 + att.paidLeave;
  const presentRate = totalMarks > 0 ? Math.round((workedMarks / totalMarks) * 1000) / 10 : 0;

  const qMap = new Map(qSeries.map((r) => [Number(r.month), r]));
  const iMap = new Map(iSeries.map((r) => [Number(r.month), r]));
  const documentsMonthly = Array.from({ length: 12 }, (_, i) => {
    const m = i + 1;
    const q = qMap.get(m);
    const inv = iMap.get(m);
    return {
      month: m,
      label: MONTH_NAMES[i]!.slice(0, 3),
      quotations: Number(q?.count ?? 0),
      quotationTotal: Number(q?.total ?? 0),
      invoices: Number(inv?.count ?? 0),
      invoiceTotal: Number(inv?.total ?? 0),
    };
  });

  const attMonthMap = new Map<
    number,
    { present: number; halfDay: number; absent: number; paidLeave: number }
  >();
  for (const row of attendanceMonthSeries) {
    const m = Number(row.month);
    const cur = attMonthMap.get(m) ?? {
      present: 0,
      halfDay: 0,
      absent: 0,
      paidLeave: 0,
    };
    const n = Number(row.value);
    if (row.status === "present") cur.present = n;
    else if (row.status === "half_day") cur.halfDay = n;
    else if (row.status === "absent") cur.absent = n;
    else if (row.status === "paid_leave") cur.paidLeave = n;
    attMonthMap.set(m, cur);
  }
  const attendanceMonthly = Array.from({ length: 12 }, (_, i) => {
    const m = i + 1;
    const cur = attMonthMap.get(m) ?? {
      present: 0,
      halfDay: 0,
      absent: 0,
      paidLeave: 0,
    };
    return {
      month: m,
      label: MONTH_NAMES[i]!.slice(0, 3),
      ...cur,
      total: cur.present + cur.halfDay + cur.absent + cur.paidLeave,
    };
  });

  const wageMonthMap = new Map(
    wageMonthSeries.map((r) => [
      Number(r.month),
      {
        gross: Number(r.gross ?? 0),
        advances: Number(r.advances ?? 0),
        net: Number(r.net ?? 0),
      },
    ])
  );
  const wagesMonthly = Array.from({ length: 12 }, (_, i) => {
    const m = i + 1;
    const cur = wageMonthMap.get(m) ?? { gross: 0, advances: 0, net: 0 };
    return {
      month: m,
      label: MONTH_NAMES[i]!.slice(0, 3),
      ...cur,
    };
  });

  const wageByStatus: Record<string, number> = {};
  for (const row of wagePeriodRows) {
    wageByStatus[row.status] = Number(row.value);
  }

  // Months in the selected year that have any chart activity
  const monthsWithData = Array.from({ length: 12 }, (_, i) => i + 1).filter((m) => {
    const d = documentsMonthly[m - 1]!;
    const a = attendanceMonthly[m - 1]!;
    const w = wagesMonthly[m - 1]!;
    return (
      d.quotations > 0 ||
      d.invoices > 0 ||
      a.total > 0 ||
      w.gross > 0 ||
      w.net > 0
    );
  });

  return res.json({
    filter: { year, month },
    availableYears,
    monthsWithData,
    range,
    catalog: {
      products: Number(productCount),
      units: Number(unitCount),
      customers: Number(customerCount),
      workers: Number(workerCount),
    },
    sites: siteRows.map((s) => ({
      id: s.id,
      name: s.name,
      code: s.code,
      status: s.status,
      address: s.address,
      workerCount: Number(s.workerCount ?? 0),
    })),
    attendance: {
      ...att,
      totalMarks,
      presentRate,
    },
    previousMonthWages: {
      year: wageRef.year,
      month: wageRef.month,
      label: `${MONTH_NAMES[wageRef.month - 1]} ${wageRef.year}`,
      range: wageRange,
      periodCount: Object.values(wageByStatus).reduce((a, b) => a + b, 0),
      byStatus: {
        draft: wageByStatus.draft ?? 0,
        finalized: wageByStatus.finalized ?? 0,
        paid: wageByStatus.paid ?? 0,
      },
      gross: Number(wageLines?.gross ?? 0),
      advances: Number(wageLines?.advances ?? 0),
      net: Number(wageLines?.net ?? 0),
    },
    documents: {
      quotations: {
        count: Number(quotationPeriod?.value ?? 0),
        total: Number(quotationPeriod?.total ?? 0),
      },
      invoices: {
        count: Number(invoicePeriod?.value ?? 0),
        total: Number(invoicePeriod?.total ?? 0),
      },
      monthly: documentsMonthly,
    },
    charts: {
      documentsMonthly,
      attendanceMonthly,
      wagesMonthly,
    },
  });
});

export default router;
