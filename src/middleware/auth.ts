import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../lib/env.js";
import type { Role } from "../db/schema.js";

export const COOKIE_NAME = "tuba_token";

export type JwtPayload = {
  userId: string;
  email: string;
  activeCompanyId?: string;
};

export type AuthUser = {
  id: string;
  email: string;
  name: string;
};

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      companyId?: string;
      membershipRole?: Role;
    }
  }
}

export function signToken(payload: JwtPayload) {
  return jwt.sign(payload, env.jwtSecret, { expiresIn: "7d" });
}

export function setAuthCookie(res: Response, token: string) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.cookieSecure,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
  });
}

export function clearAuthCookie(res: Response) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.cookieSecure,
    path: "/",
  });
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[COOKIE_NAME] as string | undefined;
  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const decoded = jwt.verify(token, env.jwtSecret) as JwtPayload;
    req.user = { id: decoded.userId, email: decoded.email, name: "" };
    if (decoded.activeCompanyId) {
      req.companyId = decoded.activeCompanyId;
    }
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[COOKIE_NAME] as string | undefined;
  if (token) {
    try {
      const decoded = jwt.verify(token, env.jwtSecret) as JwtPayload;
      req.user = { id: decoded.userId, email: decoded.email, name: "" };
      if (decoded.activeCompanyId) {
        req.companyId = decoded.activeCompanyId;
      }
    } catch {
      // ignore
    }
  }
  next();
}
