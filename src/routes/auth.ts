import { Router } from "express";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import {
  companies,
  companyInvites,
  companyMemberships,
  passwordResetTokens,
  users,
} from "../db/schema.js";
import {
  clearAuthCookie,
  requireAuth,
  setAuthCookie,
  signToken,
  COOKIE_NAME,
} from "../middleware/auth.js";
import { sendInviteEmail, sendPasswordResetEmail } from "../lib/mail.js";
import { seedDefaultUnits } from "../lib/helpers.js";
import jwt from "jsonwebtoken";
import { env } from "../lib/env.js";
import type { JwtPayload } from "../middleware/auth.js";

const router = Router();

const signupSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  companyName: z.string().min(1),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post("/signup", async (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { name, email, password, companyName } = parsed.data;
  const existing = await db.query.users.findFirst({
    where: eq(users.email, email.toLowerCase()),
  });
  if (existing) {
    return res.status(409).json({ error: "Email already registered" });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const [user] = await db
    .insert(users)
    .values({ name, email: email.toLowerCase(), passwordHash })
    .returning();

  const [company] = await db.insert(companies).values({ name: companyName }).returning();
  await db.insert(companyMemberships).values({
    companyId: company.id,
    userId: user.id,
    role: "owner",
  });
  await seedDefaultUnits(company.id);

  const token = signToken({
    userId: user.id,
    email: user.email,
    activeCompanyId: company.id,
  });
  setAuthCookie(res, token);

  return res.status(201).json({
    user: { id: user.id, name: user.name, email: user.email },
    activeCompanyId: company.id,
  });
});

router.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid credentials" });
  }
  const email = parsed.data.email.toLowerCase();
  const user = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (!user) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
  if (!ok) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const memberships = await db.query.companyMemberships.findMany({
    where: eq(companyMemberships.userId, user.id),
  });
  const activeCompanyId = memberships[0]?.companyId;

  const token = signToken({
    userId: user.id,
    email: user.email,
    activeCompanyId,
  });
  setAuthCookie(res, token);

  return res.json({
    user: { id: user.id, name: user.name, email: user.email },
    activeCompanyId: activeCompanyId ?? null,
  });
});

router.post("/logout", (_req, res) => {
  clearAuthCookie(res);
  return res.json({ ok: true });
});

router.get("/me", requireAuth, async (req, res) => {
  const user = await db.query.users.findFirst({ where: eq(users.id, req.user!.id) });
  if (!user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const memberships = await db
    .select({
      id: companyMemberships.id,
      role: companyMemberships.role,
      companyId: companies.id,
      companyName: companies.name,
      gstin: companies.gstin,
      address: companies.address,
      phone: companies.phone,
      email: companies.email,
      pfCode: companies.pfCode,
      esicCode: companies.esicCode,
      logoFile: companies.logoFile,
      signatureFile: companies.signatureFile,
    })
    .from(companyMemberships)
    .innerJoin(companies, eq(companies.id, companyMemberships.companyId))
    .where(eq(companyMemberships.userId, user.id));

  let activeCompanyId = req.companyId ?? null;
  if (!activeCompanyId || !memberships.some((m) => m.companyId === activeCompanyId)) {
    activeCompanyId = memberships[0]?.companyId ?? null;
  }

  return res.json({
    user: { id: user.id, name: user.name, email: user.email },
    memberships: memberships.map((m) => ({
      ...m,
      logoUrl: `/assets/companies/${m.companyId}/logo`,
      signatureUrl: `/assets/companies/${m.companyId}/signature`,
    })),
    activeCompanyId,
  });
});

router.post("/forgot-password", async (req, res) => {
  const email = z.string().email().safeParse(req.body?.email);
  if (!email.success) {
    return res.status(400).json({ error: "Valid email required" });
  }
  const user = await db.query.users.findFirst({
    where: eq(users.email, email.data.toLowerCase()),
  });

  // Always return success to avoid email enumeration
  if (!user) {
    return res.json({ ok: true });
  }

  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  await db.insert(passwordResetTokens).values({
    userId: user.id,
    token,
    expiresAt,
  });
  await sendPasswordResetEmail(user.email, token);
  return res.json({ ok: true });
});

router.post("/reset-password", async (req, res) => {
  const schema = z.object({
    token: z.string().min(1),
    password: z.string().min(8),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request" });
  }

  const record = await db.query.passwordResetTokens.findFirst({
    where: and(
      eq(passwordResetTokens.token, parsed.data.token),
      isNull(passwordResetTokens.usedAt)
    ),
  });
  if (!record || record.expiresAt < new Date()) {
    return res.status(400).json({ error: "Invalid or expired token" });
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 10);
  await db.update(users).set({ passwordHash }).where(eq(users.id, record.userId));
  await db
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(eq(passwordResetTokens.id, record.id));

  return res.json({ ok: true });
});

router.get("/invite/:token", async (req, res) => {
  const invite = await db.query.companyInvites.findFirst({
    where: and(eq(companyInvites.token, req.params.token!), isNull(companyInvites.acceptedAt)),
  });
  if (!invite || invite.expiresAt < new Date()) {
    return res.status(400).json({ error: "Invalid or expired invite" });
  }
  const company = await db.query.companies.findFirst({
    where: eq(companies.id, invite.companyId),
  });
  return res.json({
    email: invite.email,
    role: invite.role,
    companyName: company?.name ?? "Company",
    expiresAt: invite.expiresAt,
  });
});

router.post("/accept-invite", async (req, res) => {
  const schema = z.object({
    token: z.string().min(1),
    name: z.string().min(1),
    password: z.string().min(8),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request" });
  }

  const invite = await db.query.companyInvites.findFirst({
    where: and(eq(companyInvites.token, parsed.data.token), isNull(companyInvites.acceptedAt)),
  });
  if (!invite || invite.expiresAt < new Date()) {
    return res.status(400).json({ error: "Invalid or expired invite" });
  }

  const existing = await db.query.users.findFirst({
    where: eq(users.email, invite.email.toLowerCase()),
  });
  if (existing) {
    return res.status(409).json({
      error: "An account with this email already exists. Please log in instead.",
    });
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 10);
  const [user] = await db
    .insert(users)
    .values({
      name: parsed.data.name,
      email: invite.email.toLowerCase(),
      passwordHash,
    })
    .returning();

  await db.insert(companyMemberships).values({
    companyId: invite.companyId,
    userId: user.id,
    role: invite.role,
  });
  await db
    .update(companyInvites)
    .set({ acceptedAt: new Date() })
    .where(eq(companyInvites.id, invite.id));

  const token = signToken({
    userId: user.id,
    email: user.email,
    activeCompanyId: invite.companyId,
  });
  setAuthCookie(res, token);

  return res.status(201).json({
    user: { id: user.id, name: user.name, email: user.email },
    activeCompanyId: invite.companyId,
  });
});

export function readActiveCompanyFromCookie(req: { cookies?: Record<string, string> }) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, env.jwtSecret) as JwtPayload;
    return decoded.activeCompanyId ?? null;
  } catch {
    return null;
  }
}

export default router;
