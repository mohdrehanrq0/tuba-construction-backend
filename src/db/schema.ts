import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  integer,
  date,
  uniqueIndex,
  pgEnum,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const roleEnum = pgEnum("role", ["owner", "admin", "member", "viewer"]);
export const quotationStatusEnum = pgEnum("quotation_status", [
  "draft",
  "sent",
  "accepted",
  "converted",
  "cancelled",
]);
export const invoiceStatusEnum = pgEnum("invoice_status", [
  "draft",
  "sent",
  "paid",
  "cancelled",
]);
export const siteStatusEnum = pgEnum("site_status", ["active", "completed"]);
export const workerTypeEnum = pgEnum("worker_type", [
  "laborer",
  "contract_worker",
  "staff",
]);
export const payTypeEnum = pgEnum("pay_type", ["daily", "monthly", "contract"]);
export const workerStatusEnum = pgEnum("worker_status", ["active", "inactive"]);
export const attendanceStatusEnum = pgEnum("attendance_status", [
  "present",
  "half_day",
  "absent",
  "paid_leave",
]);
export const wagePeriodStatusEnum = pgEnum("wage_period_status", [
  "draft",
  "finalized",
  "paid",
]);

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const companies = pgTable("companies", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  gstin: text("gstin"),
  address: text("address"),
  phone: text("phone"),
  email: text("email"),
  pfCode: text("pf_code"),
  esicCode: text("esic_code"),
  /** Local filename under assets/companies/{id}/ */
  logoFile: text("logo_file"),
  /** Local filename under assets/companies/{id}/ */
  signatureFile: text("signature_file"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const companyMemberships = pgTable(
  "company_memberships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: roleEnum("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("company_memberships_company_user_idx").on(t.companyId, t.userId)]
);

export const companyInvites = pgTable("company_invites", {
  id: uuid("id").defaultRandom().primaryKey(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: roleEnum("role").notNull().default("member"),
  token: text("token").notNull().unique(),
  invitedByUserId: uuid("invited_by_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const units = pgTable(
  "units",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    symbol: text("symbol"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("units_company_name_idx").on(t.companyId, t.name)]
);

export const customers = pgTable("customers", {
  id: uuid("id").defaultRandom().primaryKey(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone"),
  address: text("address"),
  gstin: text("gstin"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const products = pgTable("products", {
  id: uuid("id").defaultRandom().primaryKey(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  hsnCode: text("hsn_code"),
  price: numeric("price", { precision: 14, scale: 2 }).notNull(),
  unitId: uuid("unit_id")
    .notNull()
    .references(() => units.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const quotations = pgTable("quotations", {
  id: uuid("id").defaultRandom().primaryKey(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  number: text("number").notNull(),
  customerId: uuid("customer_id")
    .notNull()
    .references(() => customers.id, { onDelete: "restrict" }),
  status: quotationStatusEnum("status").notNull().default("draft"),
  subject: text("subject"),
  validity: text("validity").default("30 DAYS"),
  paymentTerms: text("payment_terms"),
  taxRate: numeric("tax_rate", { precision: 6, scale: 2 }).notNull().default("0"),
  notes: text("notes"),
  subtotal: numeric("subtotal", { precision: 14, scale: 2 }).notNull().default("0"),
  taxAmount: numeric("tax_amount", { precision: 14, scale: 2 }).notNull().default("0"),
  total: numeric("total", { precision: 14, scale: 2 }).notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const quotationItems = pgTable("quotation_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  quotationId: uuid("quotation_id")
    .notNull()
    .references(() => quotations.id, { onDelete: "cascade" }),
  productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
  description: text("description").notNull(),
  hsnCode: text("hsn_code"),
  unit: text("unit").notNull(),
  quantity: numeric("quantity", { precision: 14, scale: 3 }).notNull(),
  unitPrice: numeric("unit_price", { precision: 14, scale: 2 }).notNull(),
  lineTotal: numeric("line_total", { precision: 14, scale: 2 }).notNull(),
});

export const invoices = pgTable("invoices", {
  id: uuid("id").defaultRandom().primaryKey(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  number: text("number").notNull(),
  quotationId: uuid("quotation_id").references(() => quotations.id, { onDelete: "set null" }),
  customerId: uuid("customer_id")
    .notNull()
    .references(() => customers.id, { onDelete: "restrict" }),
  status: invoiceStatusEnum("status").notNull().default("draft"),
  subject: text("subject"),
  validity: text("validity").default("30 DAYS"),
  paymentTerms: text("payment_terms"),
  taxRate: numeric("tax_rate", { precision: 6, scale: 2 }).notNull().default("0"),
  notes: text("notes"),
  subtotal: numeric("subtotal", { precision: 14, scale: 2 }).notNull().default("0"),
  taxAmount: numeric("tax_amount", { precision: 14, scale: 2 }).notNull().default("0"),
  total: numeric("total", { precision: 14, scale: 2 }).notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const invoiceItems = pgTable("invoice_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  invoiceId: uuid("invoice_id")
    .notNull()
    .references(() => invoices.id, { onDelete: "cascade" }),
  productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
  description: text("description").notNull(),
  hsnCode: text("hsn_code"),
  unit: text("unit").notNull(),
  quantity: numeric("quantity", { precision: 14, scale: 3 }).notNull(),
  unitPrice: numeric("unit_price", { precision: 14, scale: 2 }).notNull(),
  lineTotal: numeric("line_total", { precision: 14, scale: 2 }).notNull(),
});

export const documentCounters = pgTable(
  "document_counters",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    nextNumber: integer("next_number").notNull().default(1),
  },
  (t) => [uniqueIndex("document_counters_company_type_idx").on(t.companyId, t.type)]
);

export const sites = pgTable("sites", {
  id: uuid("id").defaultRandom().primaryKey(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  code: text("code"),
  address: text("address"),
  status: siteStatusEnum("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const workers = pgTable("workers", {
  id: uuid("id").defaultRandom().primaryKey(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  phone: text("phone"),
  trade: text("trade"),
  workerType: workerTypeEnum("worker_type").notNull().default("laborer"),
  payType: payTypeEnum("pay_type").notNull().default("daily"),
  dailyWage: numeric("daily_wage", { precision: 14, scale: 2 }),
  monthlySalary: numeric("monthly_salary", { precision: 14, scale: 2 }),
  contractAmount: numeric("contract_amount", { precision: 14, scale: 2 }),
  otRate: numeric("ot_rate", { precision: 14, scale: 2 }),
  joinDate: date("join_date"),
  status: workerStatusEnum("status").notNull().default("active"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const siteWorkers = pgTable(
  "site_workers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    startDate: date("start_date"),
    endDate: date("end_date"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("site_workers_site_worker_idx").on(t.siteId, t.workerId)]
);

export const attendanceRecords = pgTable(
  "attendance_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    status: attendanceStatusEnum("status").notNull().default("present"),
    otHours: numeric("ot_hours", { precision: 6, scale: 2 }).notNull().default("0"),
    markedByUserId: uuid("marked_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("attendance_site_worker_date_idx").on(t.siteId, t.workerId, t.date),
  ]
);

export const wageAdvances = pgTable("wage_advances", {
  id: uuid("id").defaultRandom().primaryKey(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  workerId: uuid("worker_id")
    .notNull()
    .references(() => workers.id, { onDelete: "cascade" }),
  amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
  date: date("date").notNull(),
  notes: text("notes"),
  createdByUserId: uuid("created_by_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const wagePeriods = pgTable("wage_periods", {
  id: uuid("id").defaultRandom().primaryKey(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  status: wagePeriodStatusEnum("status").notNull().default("draft"),
  notes: text("notes"),
  createdByUserId: uuid("created_by_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const wagePeriodLines = pgTable(
  "wage_period_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    wagePeriodId: uuid("wage_period_id")
      .notNull()
      .references(() => wagePeriods.id, { onDelete: "cascade" }),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "restrict" }),
    payType: payTypeEnum("pay_type").notNull(),
    fullDays: numeric("full_days", { precision: 8, scale: 2 }).notNull().default("0"),
    halfDays: numeric("half_days", { precision: 8, scale: 2 }).notNull().default("0"),
    otHours: numeric("ot_hours", { precision: 8, scale: 2 }).notNull().default("0"),
    rateSnapshot: numeric("rate_snapshot", { precision: 14, scale: 2 }),
    contractAmountSnapshot: numeric("contract_amount_snapshot", {
      precision: 14,
      scale: 2,
    }),
    gross: numeric("gross", { precision: 14, scale: 2 }).notNull().default("0"),
    advancesDeducted: numeric("advances_deducted", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    adjustment: numeric("adjustment", { precision: 14, scale: 2 }).notNull().default("0"),
    net: numeric("net", { precision: 14, scale: 2 }).notNull().default("0"),
    notes: text("notes"),
  },
  (t) => [
    uniqueIndex("wage_period_lines_period_worker_idx").on(t.wagePeriodId, t.workerId),
  ]
);

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(companyMemberships),
}));

export const companiesRelations = relations(companies, ({ many }) => ({
  memberships: many(companyMemberships),
  units: many(units),
  products: many(products),
  customers: many(customers),
  sites: many(sites),
  workers: many(workers),
}));

export const sitesRelations = relations(sites, ({ one, many }) => ({
  company: one(companies, {
    fields: [sites.companyId],
    references: [companies.id],
  }),
  siteWorkers: many(siteWorkers),
  attendanceRecords: many(attendanceRecords),
}));

export const workersRelations = relations(workers, ({ one, many }) => ({
  company: one(companies, {
    fields: [workers.companyId],
    references: [companies.id],
  }),
  siteWorkers: many(siteWorkers),
  attendanceRecords: many(attendanceRecords),
  advances: many(wageAdvances),
}));

export const siteWorkersRelations = relations(siteWorkers, ({ one }) => ({
  site: one(sites, {
    fields: [siteWorkers.siteId],
    references: [sites.id],
  }),
  worker: one(workers, {
    fields: [siteWorkers.workerId],
    references: [workers.id],
  }),
}));

export const attendanceRecordsRelations = relations(attendanceRecords, ({ one }) => ({
  site: one(sites, {
    fields: [attendanceRecords.siteId],
    references: [sites.id],
  }),
  worker: one(workers, {
    fields: [attendanceRecords.workerId],
    references: [workers.id],
  }),
  markedBy: one(users, {
    fields: [attendanceRecords.markedByUserId],
    references: [users.id],
  }),
}));

export const wagePeriodsRelations = relations(wagePeriods, ({ one, many }) => ({
  site: one(sites, {
    fields: [wagePeriods.siteId],
    references: [sites.id],
  }),
  lines: many(wagePeriodLines),
  createdBy: one(users, {
    fields: [wagePeriods.createdByUserId],
    references: [users.id],
  }),
}));

export const wagePeriodLinesRelations = relations(wagePeriodLines, ({ one }) => ({
  period: one(wagePeriods, {
    fields: [wagePeriodLines.wagePeriodId],
    references: [wagePeriods.id],
  }),
  worker: one(workers, {
    fields: [wagePeriodLines.workerId],
    references: [workers.id],
  }),
}));

export type Role = "owner" | "admin" | "member" | "viewer";
export type SiteStatus = "active" | "completed";
export type WorkerType = "laborer" | "contract_worker" | "staff";
export type PayType = "daily" | "monthly" | "contract";
export type WorkerStatus = "active" | "inactive";
export type AttendanceStatus = "present" | "half_day" | "absent" | "paid_leave";
export type WagePeriodStatus = "draft" | "finalized" | "paid";
