import type { Request, Response, NextFunction } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { companies, companyMemberships, users } from "../db/schema.js";
import { hasPermission, type Permission } from "../lib/permissions.js";

export async function requireCompany(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const headerCompanyId = req.header("X-Company-Id");
  const companyId = headerCompanyId || req.companyId;
  if (!companyId) {
    return res.status(400).json({ error: "X-Company-Id header is required" });
  }

  const membership = await db.query.companyMemberships.findFirst({
    where: and(
      eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.userId, req.user.id)
    ),
  });

  if (!membership) {
    return res.status(403).json({ error: "Not a member of this company" });
  }

  const user = await db.query.users.findFirst({ where: eq(users.id, req.user.id) });
  if (user) {
    req.user.name = user.name;
  }

  req.companyId = companyId;
  req.membershipRole = membership.role;
  return next();
}

export function requirePermission(...permissions: Permission[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.membershipRole) {
      return res.status(403).json({ error: "No company context" });
    }
    const ok = permissions.every((p) => hasPermission(req.membershipRole!, p));
    if (!ok) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    return next();
  };
}

export async function getCompanyOr404(companyId: string) {
  return db.query.companies.findFirst({ where: eq(companies.id, companyId) });
}
