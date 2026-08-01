import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import fs from "fs";
import path from "path";
import { eq } from "drizzle-orm";
import { env } from "./lib/env.js";
import {
  ASSETS_DIR,
  DEFAULTS_DIR,
  ensureAssetDirs,
  resolveCompanyAsset,
  type AssetKind,
} from "./lib/assets.js";
import { db } from "./db/index.js";
import { companies } from "./db/schema.js";
import authRoutes from "./routes/auth.js";
import companyRoutes from "./routes/companies.js";
import unitRoutes from "./routes/units.js";
import productRoutes from "./routes/products.js";
import customerRoutes from "./routes/customers.js";
import quotationRoutes from "./routes/quotations.js";
import invoiceRoutes from "./routes/invoices.js";
import pdfRoutes from "./routes/pdf.js";
import dashboardRoutes from "./routes/dashboard.js";
import siteRoutes from "./routes/sites.js";
import workerRoutes from "./routes/workers.js";
import attendanceRoutes from "./routes/attendance.js";
import advanceRoutes from "./routes/advances.js";
import wageRoutes from "./routes/wages.js";

ensureAssetDirs();

const app = express();

app.use(
  cors({
    origin: (origin, callback) => {
      // Non-browser clients (curl, server-to-server) send no Origin header
      if (!origin) return callback(null, true);
      if (env.corsOrigins.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    credentials: true,
  })
);
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

app.get("/health", (_req, res) => res.json({ ok: true, service: "tuba-backend" }));

/** Default branding for login / pre-auth screens. */
app.get("/branding", (_req, res) => {
  res.json({
    logoUrl: "/assets/defaults/logo",
    signatureUrl: "/assets/defaults/signature",
  });
});

app.get("/assets/defaults/:kind", (req, res) => {
  const kind = req.params.kind as AssetKind;
  if (kind !== "logo" && kind !== "signature") {
    return res.status(404).json({ error: "Not found" });
  }
  const filename = kind === "logo" ? "logo.jpeg" : "signature.png";
  const full = path.join(DEFAULTS_DIR, filename);
  if (!fs.existsSync(full)) return res.status(404).json({ error: "Asset not found" });
  return res.sendFile(full);
});

/** Per-company logo / signature from local disk. */
app.get("/assets/companies/:companyId/:kind", async (req, res) => {
  const kind = req.params.kind as AssetKind;
  const companyId = req.params.companyId!;
  if (kind !== "logo" && kind !== "signature") {
    return res.status(404).json({ error: "Not found" });
  }

  const company = await db.query.companies.findFirst({
    where: eq(companies.id, companyId),
  });
  if (!company) return res.status(404).json({ error: "Company not found" });

  const stored = kind === "logo" ? company.logoFile : company.signatureFile;
  const full = resolveCompanyAsset(companyId, kind, stored);
  if (!full) return res.status(404).json({ error: "Asset not found" });
  return res.sendFile(full);
});

app.use("/auth", authRoutes);
app.use("/companies", companyRoutes);
app.use("/units", unitRoutes);
app.use("/products", productRoutes);
app.use("/customers", customerRoutes);
app.use("/quotations", quotationRoutes);
app.use("/invoices", invoiceRoutes);
app.use("/pdf", pdfRoutes);
app.use("/dashboard", dashboardRoutes);
app.use("/sites", siteRoutes);
app.use("/workers", workerRoutes);
app.use("/attendance", attendanceRoutes);
app.use("/advances", advanceRoutes);
app.use("/wages", wageRoutes);

app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error(err);
    res.status(500).json({ error: err.message || "Internal server error" });
  }
);

app.listen(env.port, () => {
  console.log(`Tuba API listening on http://localhost:${env.port}`);
  console.log(`Local assets: ${ASSETS_DIR}`);
});
