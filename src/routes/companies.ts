import { Router } from "express";
import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";
import multer from "multer";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import {
  companies,
  companyInvites,
  companyMemberships,
  users,
  type Role,
} from "../db/schema.js";
import { requireAuth, setAuthCookie, signToken } from "../middleware/auth.js";
import { requireCompany, requirePermission } from "../middleware/company.js";
import { sendAddedToCompanyEmail, sendInviteEmail } from "../lib/mail.js";
import { seedDefaultUnits } from "../lib/helpers.js";
import {
  companyAssetPublicUrl,
  ensureCompanyAssetDir,
  extFromUpload,
  type AssetKind,
} from "../lib/assets.js";

const router = Router();

router.use(requireAuth);

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok =
      file.mimetype.startsWith("image/") ||
      /\.(jpe?g|png|webp|gif)$/i.test(file.originalname);
    if (!ok) {
      cb(new Error("Only image files are allowed (jpeg, png, webp, gif)"));
      return;
    }
    cb(null, true);
  },
});

function withAssetUrls<T extends { id: string; logoFile?: string | null; signatureFile?: string | null }>(
  company: T
) {
  return {
    ...company,
    logoUrl: companyAssetPublicUrl(company.id, "logo"),
    signatureUrl: companyAssetPublicUrl(company.id, "signature"),
  };
}

router.get("/", async (req, res) => {
  const rows = await db
    .select({
      id: companies.id,
      name: companies.name,
      gstin: companies.gstin,
      address: companies.address,
      phone: companies.phone,
      email: companies.email,
      pfCode: companies.pfCode,
      esicCode: companies.esicCode,
      logoFile: companies.logoFile,
      signatureFile: companies.signatureFile,
      role: companyMemberships.role,
      createdAt: companies.createdAt,
    })
    .from(companyMemberships)
    .innerJoin(companies, eq(companies.id, companyMemberships.companyId))
    .where(eq(companyMemberships.userId, req.user!.id));
  return res.json(rows.map((r) => withAssetUrls(r)));
});

router.post("/", async (req, res) => {
  const schema = z.object({
    name: z.string().min(1),
    gstin: z.string().optional(),
    address: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request" });
  }

  const [company] = await db
    .insert(companies)
    .values({
      name: parsed.data.name,
      gstin: parsed.data.gstin,
      address: parsed.data.address,
    })
    .returning();

  await db.insert(companyMemberships).values({
    companyId: company.id,
    userId: req.user!.id,
    role: "owner",
  });
  await seedDefaultUnits(company.id);

  const token = signToken({
    userId: req.user!.id,
    email: req.user!.email,
    activeCompanyId: company.id,
  });
  setAuthCookie(res, token);

  return res.status(201).json(company);
});

router.post("/:id/switch", async (req, res) => {
  const companyId = req.params.id!;
  const membership = await db.query.companyMemberships.findFirst({
    where: and(
      eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.userId, req.user!.id)
    ),
  });
  if (!membership) {
    return res.status(403).json({ error: "Not a member of this company" });
  }
  const token = signToken({
    userId: req.user!.id,
    email: req.user!.email,
    activeCompanyId: companyId,
  });
  setAuthCookie(res, token);
  return res.json({ activeCompanyId: companyId });
});

router.patch(
  "/:id",
  async (req, res, next) => {
    req.headers["x-company-id"] = req.params.id!;
    return requireCompany(req, res, next);
  },
  requirePermission("manage_company"),
  async (req, res) => {
    const schema = z.object({
      name: z.string().min(1).optional(),
      gstin: z.string().nullable().optional(),
      address: z.string().nullable().optional(),
      phone: z.string().nullable().optional(),
      email: z.string().nullable().optional(),
      pfCode: z.string().nullable().optional(),
      esicCode: z.string().nullable().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }
    const [updated] = await db
      .update(companies)
      .set(parsed.data)
      .where(eq(companies.id, req.params.id!))
      .returning();
    return res.json(withAssetUrls(updated));
  }
);

router.post(
  "/:id/assets/:kind",
  async (req, res, next) => {
    req.headers["x-company-id"] = req.params.id!;
    return requireCompany(req, res, next);
  },
  requirePermission("manage_company"),
  (req, res, next) => {
    imageUpload.single("file")(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message || "Upload failed" });
      return next();
    });
  },
  async (req, res) => {
    const kind = req.params.kind as AssetKind;
    if (kind !== "logo" && kind !== "signature") {
      return res.status(400).json({ error: "kind must be logo or signature" });
    }
    if (!req.file?.buffer) {
      return res.status(400).json({ error: "Upload an image file" });
    }

    const companyId = req.params.id!;
    const company = await db.query.companies.findFirst({
      where: eq(companies.id, companyId),
    });
    if (!company) return res.status(404).json({ error: "Company not found" });

    const dir = ensureCompanyAssetDir(companyId);
    const ext = extFromUpload(req.file.originalname, req.file.mimetype, kind);
    const filename = `${kind}.${ext}`;
    const fullPath = path.join(dir, filename);

    // Remove previous variants for this kind
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(`${kind}.`)) {
        try {
          fs.unlinkSync(path.join(dir, f));
        } catch {
          /* ignore */
        }
      }
    }
    fs.writeFileSync(fullPath, req.file.buffer);

    const [updated] = await db
      .update(companies)
      .set(kind === "logo" ? { logoFile: filename } : { signatureFile: filename })
      .where(eq(companies.id, companyId))
      .returning();

    return res.json(withAssetUrls(updated));
  }
);

router.delete(
  "/:id/assets/:kind",
  async (req, res, next) => {
    req.headers["x-company-id"] = req.params.id!;
    return requireCompany(req, res, next);
  },
  requirePermission("manage_company"),
  async (req, res) => {
    const kind = req.params.kind as AssetKind;
    if (kind !== "logo" && kind !== "signature") {
      return res.status(400).json({ error: "kind must be logo or signature" });
    }
    const companyId = req.params.id!;
    const company = await db.query.companies.findFirst({
      where: eq(companies.id, companyId),
    });
    if (!company) return res.status(404).json({ error: "Company not found" });

    const dir = ensureCompanyAssetDir(companyId);
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(`${kind}.`)) {
        try {
          fs.unlinkSync(path.join(dir, f));
        } catch {
          /* ignore */
        }
      }
    }

    const [updated] = await db
      .update(companies)
      .set(kind === "logo" ? { logoFile: null } : { signatureFile: null })
      .where(eq(companies.id, companyId))
      .returning();

    return res.json(withAssetUrls(updated));
  }
);

router.get(
  "/:id/members",
  async (req, res, next) => {
    req.headers["x-company-id"] = req.params.id!;
    return requireCompany(req, res, next);
  },
  requirePermission("view"),
  async (req, res) => {
    const rows = await db
      .select({
        membershipId: companyMemberships.id,
        userId: users.id,
        name: users.name,
        email: users.email,
        role: companyMemberships.role,
        createdAt: companyMemberships.createdAt,
      })
      .from(companyMemberships)
      .innerJoin(users, eq(users.id, companyMemberships.userId))
      .where(eq(companyMemberships.companyId, req.params.id!));
    return res.json(rows);
  }
);

router.patch(
  "/:id/members/:userId",
  async (req, res, next) => {
    req.headers["x-company-id"] = req.params.id!;
    return requireCompany(req, res, next);
  },
  requirePermission("manage_members"),
  async (req, res) => {
    const role = z.enum(["owner", "admin", "member", "viewer"]).safeParse(req.body?.role);
    if (!role.success) {
      return res.status(400).json({ error: "Invalid role" });
    }
    if (role.data !== "owner" && req.params.userId === req.user!.id) {
      // allow demoting self only if another owner exists — keep simple: block self demotion from owner
    }
    if (req.membershipRole !== "owner" && role.data === "owner") {
      return res.status(403).json({ error: "Only owners can assign owner role" });
    }

    const [updated] = await db
      .update(companyMemberships)
      .set({ role: role.data as Role })
      .where(
        and(
          eq(companyMemberships.companyId, req.params.id!),
          eq(companyMemberships.userId, req.params.userId!)
        )
      )
      .returning();
    if (!updated) {
      return res.status(404).json({ error: "Member not found" });
    }
    return res.json(updated);
  }
);

router.delete(
  "/:id/members/:userId",
  async (req, res, next) => {
    req.headers["x-company-id"] = req.params.id!;
    return requireCompany(req, res, next);
  },
  requirePermission("manage_members"),
  async (req, res) => {
    if (req.params.userId === req.user!.id) {
      return res.status(400).json({ error: "Cannot remove yourself" });
    }
    const target = await db.query.companyMemberships.findFirst({
      where: and(
        eq(companyMemberships.companyId, req.params.id!),
        eq(companyMemberships.userId, req.params.userId!)
      ),
    });
    if (!target) {
      return res.status(404).json({ error: "Member not found" });
    }
    if (target.role === "owner" && req.membershipRole !== "owner") {
      return res.status(403).json({ error: "Cannot remove an owner" });
    }
    await db
      .delete(companyMemberships)
      .where(eq(companyMemberships.id, target.id));
    return res.json({ ok: true });
  }
);

router.get(
  "/:id/invites",
  async (req, res, next) => {
    req.headers["x-company-id"] = req.params.id!;
    return requireCompany(req, res, next);
  },
  requirePermission("manage_members"),
  async (req, res) => {
    const rows = await db.query.companyInvites.findMany({
      where: and(
        eq(companyInvites.companyId, req.params.id!),
        isNull(companyInvites.acceptedAt)
      ),
    });
    return res.json(rows);
  }
);

router.post(
  "/:id/invites",
  async (req, res, next) => {
    req.headers["x-company-id"] = req.params.id!;
    return requireCompany(req, res, next);
  },
  requirePermission("manage_members"),
  async (req, res) => {
    const schema = z.object({
      email: z.string().email(),
      role: z.enum(["admin", "member", "viewer"]).default("member"),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }

    const email = parsed.data.email.toLowerCase();
    const company = await db.query.companies.findFirst({
      where: eq(companies.id, req.params.id!),
    });
    if (!company) {
      return res.status(404).json({ error: "Company not found" });
    }

    const existingUser = await db.query.users.findFirst({
      where: eq(users.email, email),
    });
    if (existingUser) {
      const already = await db.query.companyMemberships.findFirst({
        where: and(
          eq(companyMemberships.companyId, company.id),
          eq(companyMemberships.userId, existingUser.id)
        ),
      });
      if (already) {
        return res.status(409).json({ error: "User is already a member" });
      }
      await db.insert(companyMemberships).values({
        companyId: company.id,
        userId: existingUser.id,
        role: parsed.data.role,
      });
      await sendAddedToCompanyEmail({
        to: email,
        companyName: company.name,
        role: parsed.data.role,
      });
      return res.status(201).json({ type: "added_existing", email, role: parsed.data.role });
    }

    const pending = await db.query.companyInvites.findFirst({
      where: and(
        eq(companyInvites.companyId, company.id),
        eq(companyInvites.email, email),
        isNull(companyInvites.acceptedAt)
      ),
    });

    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    if (pending) {
      const [updated] = await db
        .update(companyInvites)
        .set({
          token,
          role: parsed.data.role,
          expiresAt,
          invitedByUserId: req.user!.id,
        })
        .where(eq(companyInvites.id, pending.id))
        .returning();
      await sendInviteEmail({
        to: email,
        companyName: company.name,
        role: parsed.data.role,
        token,
      });
      return res.json({ type: "invite_resent", invite: { ...updated, token: undefined } });
    }

    const [invite] = await db
      .insert(companyInvites)
      .values({
        companyId: company.id,
        email,
        role: parsed.data.role,
        token,
        invitedByUserId: req.user!.id,
        expiresAt,
      })
      .returning();

    await sendInviteEmail({
      to: email,
      companyName: company.name,
      role: parsed.data.role,
      token,
    });

    return res.status(201).json({
      type: "invite_created",
      invite: { id: invite.id, email: invite.email, role: invite.role, expiresAt: invite.expiresAt },
    });
  }
);

router.delete(
  "/:id/invites/:inviteId",
  async (req, res, next) => {
    req.headers["x-company-id"] = req.params.id!;
    return requireCompany(req, res, next);
  },
  requirePermission("manage_members"),
  async (req, res) => {
    await db
      .delete(companyInvites)
      .where(
        and(
          eq(companyInvites.id, req.params.inviteId!),
          eq(companyInvites.companyId, req.params.id!)
        )
      );
    return res.json({ ok: true });
  }
);

export default router;
