import { Router } from "express";
import PDFDocument from "pdfkit";
import fs from "fs";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  companies,
  customers,
  invoiceItems,
  invoices,
  quotationItems,
  quotations,
} from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { requireCompany, requirePermission } from "../middleware/company.js";
import { amountInWordsInr, formatDateIndian, round2 } from "../lib/helpers.js";
import { resolveCompanyAsset } from "../lib/assets.js";

const router = Router();
router.use(requireAuth, requireCompany, requirePermission("download_pdf"));

type LineItem = {
  description: string;
  hsnCode: string | null;
  unit: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
};

type CompanyInfo = {
  name: string;
  address?: string | null;
  gstin?: string | null;
  phone?: string | null;
  email?: string | null;
  pfCode?: string | null;
  esicCode?: string | null;
};

type CustomerInfo = {
  name: string;
  address?: string | null;
  gstin?: string | null;
};

const PAGE = { left: 32, right: 563, top: 28, bottom: 812, width: 531 };
const COLORS = {
  titleBg: "#F0FDAD",
  metaBg: "#F9E8FC",
  toBg: "#FFFFCC",
  subjectBg: "#CCFFFF",
  wordsBg: "#CCFFFF",
  hsnBg: "#F0FDAD",
  border: "#222222",
  muted: "#333333",
};

const DEFAULT_TERMS = [
  "1. We trust you will find our offer in line with your requirement and look forward to receive your order at an earlier date",
  "2. Taxes as per Government norms",
].join("\n");

function drawBox(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  w: number,
  h: number,
  fill?: string
) {
  doc.save();
  if (fill) {
    doc.rect(x, y, w, h).fillAndStroke(fill, COLORS.border);
  } else {
    doc.rect(x, y, w, h).stroke(COLORS.border);
  }
  doc.restore();
}

function vCenter(y: number, h: number, fontSize: number) {
  return y + (h - fontSize) / 2 - 1;
}

function companyDetailsText(company: CompanyInfo) {
  const lines: string[] = [];
  if (company.address) {
    lines.push(...company.address.split(/\n+/).map((l) => l.trim()).filter(Boolean));
  }
  if (company.gstin) lines.push(`GSTIN/UIN : ${company.gstin}`);
  if (company.pfCode) lines.push(`PF CODE: ${company.pfCode}`);
  if (company.esicCode) lines.push(`ESIC CODE: ${company.esicCode}`);
  if (company.phone) lines.push(`Mobile No. ${company.phone}`);
  if (company.email) lines.push(`E-Mail : ${company.email}`);
  return lines.join("\n");
}

function parseTerms(notes?: string | null) {
  const raw = (notes?.trim() || DEFAULT_TERMS).split(/\n+/).map((l) => l.trim()).filter(Boolean);
  return raw.length ? raw : DEFAULT_TERMS.split("\n");
}

function streamQuotationPdf(
  res: import("express").Response,
  opts: {
    docTitle?: string;
    numberLabel?: string;
    number: string;
    date: Date | string;
    company: CompanyInfo;
    customer: CustomerInfo;
    subject?: string | null;
    validity?: string | null;
    paymentTerms?: string | null;
    taxRate: string;
    subtotal: string;
    taxAmount: string;
    total: string;
    notes?: string | null;
    items: LineItem[];
    filename: string;
    logoPath?: string | null;
    signaturePath?: string | null;
  }
) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${opts.filename}"`);

  const doc = new PDFDocument({ margin: 28, size: "A4", bufferPages: true });
  doc.pipe(res);

  const left = PAGE.left;
  const right = PAGE.right;
  const fullW = PAGE.width;
  const midX = 248;
  const metaLabelW = 98;
  const metaValueX = midX + metaLabelW;
  const metaValueW = right - metaValueX;
  const docTitle = opts.docTitle ?? "Quotation";
  const numberLabel = opts.numberLabel ?? "QUOTATION NO.";
  const pad = 5;

  let y = PAGE.top;

  // Title
  const titleH = 24;
  drawBox(doc, left, y, fullW, titleH, COLORS.titleBg);
  doc
    .font("Helvetica-Bold")
    .fontSize(14)
    .fillColor("#000")
    .text(docTitle, left, vCenter(y, titleH, 14), { width: fullW, align: "center" });
  y += titleH;

  // Company + meta
  const headerH = 118;
  drawBox(doc, left, y, midX - left, headerH);

  const logoPath = opts.logoPath;
  const hasLogo = Boolean(logoPath && fs.existsSync(logoPath));
  const logoW = 44;
  const logoH = 44;
  const textX = hasLogo ? left + pad + logoW + 4 : left + pad;
  const textW = midX - textX - pad;

  if (hasLogo && logoPath) {
    try {
      doc.image(logoPath, left + pad, y + pad, {
        width: logoW,
        height: logoH,
        fit: [logoW, logoH],
      });
    } catch {
      // ignore
    }
  }

  // Company name — larger + bold highlight
  const companyName = (opts.company.name || "COMPANY").toUpperCase();
  doc
    .font("Helvetica-Bold")
    .fontSize(12)
    .fillColor("#000")
    .text(companyName, textX, y + pad, { width: textW, align: "left" });
  const afterNameY = doc.y + 2;
  const details = companyDetailsText(opts.company);
  if (details) {
    doc
      .font("Helvetica")
      .fontSize(7)
      .fillColor("#000")
      .text(details, textX, afterNameY, { width: textW, align: "left", lineGap: 0.5 });
  }

  const paymentValue =
    opts.paymentTerms?.trim() ||
    "50% Adv. With P.O. & 50% After Compl., of work within 7 days";
  const metaRows: { label: string; value: string; h: number }[] = [
    { label: numberLabel, value: opts.number, h: 24 },
    { label: "DATE", value: formatDateIndian(opts.date), h: 22 },
    { label: "QTN. VAILIDITY", value: opts.validity?.trim() || "30 DAYS", h: 22 },
    { label: "PAYMENT TERMS", value: paymentValue, h: headerH - 24 - 22 - 22 },
  ];

  let my = y;
  for (const row of metaRows) {
    drawBox(doc, midX, my, metaLabelW, row.h);
    drawBox(doc, metaValueX, my, metaValueW, row.h, COLORS.metaBg);
    doc
      .font("Helvetica-Bold")
      .fontSize(7.5)
      .fillColor("#000")
      .text(row.label, midX + 3, my + 4, { width: metaLabelW - 6, align: "left" });

    const isPayment = row.label === "PAYMENT TERMS";
    doc.font("Helvetica-Bold").fontSize(isPayment ? 7 : 9);
    if (isPayment) {
      doc.text(row.value, metaValueX + 3, my + 3, {
        width: metaValueW - 6,
        align: "left",
        lineGap: 0.5,
      });
    } else {
      doc.text(row.value, metaValueX + 3, vCenter(my, row.h, 9), {
        width: metaValueW - 6,
        align: "center",
      });
    }
    my += row.h;
  }

  y += headerH;

  // TO + Subject
  const subjectText = opts.subject?.trim() || "Quotation for";
  const customerName = opts.customer.name || "";
  const customerRest = [
    opts.customer.address?.replace(/\n+/g, ", ") || "",
    `GSTIN/UIN : ${opts.customer.gstin || ""}`,
  ]
    .filter(Boolean)
    .join("\n");

  doc.font("Helvetica-Bold").fontSize(11);
  const nameH = doc.heightOfString(customerName || " ", { width: midX - left - pad * 2 });
  doc.font("Helvetica").fontSize(8);
  const restH = customerRest
    ? doc.heightOfString(customerRest, { width: midX - left - pad * 2 })
    : 0;
  doc.font("Helvetica-Bold").fontSize(8.5);
  const subjectH = doc.heightOfString(`Subject\n${subjectText}`, {
    width: right - midX - pad * 2,
  });

  const toH = Math.max(62, 16 + nameH + restH + 10, subjectH + 14);

  drawBox(doc, left, y, midX - left, toH, COLORS.toBg);
  drawBox(doc, midX, y, right - midX, toH, COLORS.subjectBg);

  doc
    .font("Helvetica-Bold")
    .fontSize(8)
    .fillColor("#000")
    .text("TO", left + pad, y + 4, { width: midX - left - pad * 2 });

  // Customer / company name — larger + bold highlight
  doc
    .font("Helvetica-Bold")
    .fontSize(11)
    .text(customerName, left + pad, y + 15, {
      width: midX - left - pad * 2,
      align: "left",
    });
  if (customerRest) {
    doc
      .font("Helvetica")
      .fontSize(8)
      .text(customerRest, left + pad, doc.y + 2, {
        width: midX - left - pad * 2,
        lineGap: 1,
      });
  }

  doc
    .font("Helvetica-Bold")
    .fontSize(8)
    .text("Subject", midX + pad, y + 4, { width: right - midX - pad * 2 });
  doc
    .font("Helvetica-Bold")
    .fontSize(8.5)
    .text(subjectText, midX + pad, y + 15, {
      width: right - midX - pad * 2,
      lineGap: 1,
    });

  y += toH + 8;

  // Greeting (short)
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#000").text("Respected Sir/Madam,", left, y);
  y += 13;
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor(COLORS.muted)
    .text(
      "With reference to your enquiry, we submit our lowest quotation. We hope you find our rates competitive and favour us with your valued order.",
      left + 12,
      y,
      { width: fullW - 12, align: "left", lineGap: 1 }
    );
  y = doc.y + 8;

  // Table columns
  const cols = {
    sr: { x: left, w: 30 },
    desc: { x: left + 30, w: 220 },
    hsn: { x: left + 250, w: 54 },
    unit: { x: left + 304, w: 40 },
    qty: { x: left + 344, w: 48 },
    rate: { x: left + 392, w: 58 },
    amt: { x: left + 450, w: right - (left + 450) },
  };

  const headerRowH = 18;

  const drawTableHeader = () => {
    for (const c of Object.values(cols)) {
      drawBox(doc, c.x, y, c.w, headerRowH);
    }
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#000");
    const ty = vCenter(y, headerRowH, 8);
    doc.text("Sr.", cols.sr.x, ty, { width: cols.sr.w, align: "center" });
    doc.text("Description of Materials", cols.desc.x + 2, ty, {
      width: cols.desc.w - 4,
      align: "center",
    });
    doc.text("HSN/SAC", cols.hsn.x, ty, { width: cols.hsn.w, align: "center" });
    doc.text("Unit", cols.unit.x, ty, { width: cols.unit.w, align: "center" });
    doc.text("Qty", cols.qty.x, ty, { width: cols.qty.w, align: "center" });
    doc.text("Rate", cols.rate.x, ty, { width: cols.rate.w, align: "center" });
    doc.text("Amount", cols.amt.x, ty, { width: cols.amt.w, align: "center" });
    y += headerRowH;
  };

  const ensureSpace = (need: number, redrawHeader = true) => {
    if (y + need > PAGE.bottom) {
      doc.addPage();
      y = PAGE.top;
      if (redrawHeader) drawTableHeader();
    }
  };

  drawTableHeader();

  opts.items.forEach((item, idx) => {
    doc.font("Helvetica").fontSize(8);
    const descH = Math.max(
      28,
      doc.heightOfString(item.description, { width: cols.desc.w - 6 }) + 10
    );
    ensureSpace(descH);

    drawBox(doc, cols.sr.x, y, cols.sr.w, descH);
    drawBox(doc, cols.desc.x, y, cols.desc.w, descH);
    drawBox(doc, cols.hsn.x, y, cols.hsn.w, descH, COLORS.hsnBg);
    drawBox(doc, cols.unit.x, y, cols.unit.w, descH);
    drawBox(doc, cols.qty.x, y, cols.qty.w, descH);
    drawBox(doc, cols.rate.x, y, cols.rate.w, descH);
    drawBox(doc, cols.amt.x, y, cols.amt.w, descH);

    const cy = vCenter(y, descH, 9);
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#000");
    doc.text(String(idx + 1), cols.sr.x, cy, { width: cols.sr.w, align: "center" });

    doc.font("Helvetica").fontSize(8);
    doc.text(item.description, cols.desc.x + 3, y + 5, {
      width: cols.desc.w - 6,
      align: "left",
    });
    doc.text(item.hsnCode || "", cols.hsn.x, cy, { width: cols.hsn.w, align: "center" });
    doc.text(item.unit, cols.unit.x, cy, { width: cols.unit.w, align: "center" });
    doc.text(String(Number(item.quantity)), cols.qty.x, cy, {
      width: cols.qty.w,
      align: "center",
    });
    doc.text(Number(item.unitPrice).toFixed(2), cols.rate.x, cy, {
      width: cols.rate.w,
      align: "center",
    });

    doc.font("Helvetica-Bold").fontSize(9);
    doc.text(Number(item.lineTotal).toFixed(2), cols.amt.x, cy, {
      width: cols.amt.w,
      align: "center",
    });
    y += descH;
  });

  // Totals
  const taxRate = Number(opts.taxRate);
  const halfRate = round2(taxRate / 2);
  const subtotal = Number(opts.subtotal);
  const halfTax = round2(Number(opts.taxAmount) / 2);
  const total = Number(opts.total);
  const rowH = 18;
  const grandH = 22;
  const totalsBlockH = rowH * 3 + grandH;
  const labelColW = cols.rate.x + cols.rate.w - cols.hsn.x;

  ensureSpace(totalsBlockH + 100, false);

  drawBox(doc, left, y, cols.desc.x + cols.desc.w - left, totalsBlockH, COLORS.wordsBg);
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#000")
    .text("Amount Chargeable in words", left + 4, y + 5, {
      width: cols.desc.x + cols.desc.w - left - 8,
    });
  doc
    .font("Helvetica-Bold")
    .fontSize(8.5)
    .text(amountInWordsInr(total), left + 4, y + 16, {
      width: cols.desc.x + cols.desc.w - left - 8,
      lineGap: 1,
    });

  const moneyRows: { label: string; value: string; bold?: boolean; h: number }[] = [
    { label: "Total Rs.", value: subtotal.toFixed(2), h: rowH },
    { label: `CGST ${halfRate}%`, value: halfTax.toFixed(2), h: rowH },
    { label: `SGST ${halfRate}%`, value: halfTax.toFixed(2), h: rowH },
    { label: "Total Amount Rs.", value: total.toFixed(2), bold: true, h: grandH },
  ];

  let ty = y;
  for (const row of moneyRows) {
    drawBox(doc, cols.hsn.x, ty, labelColW, row.h);
    drawBox(doc, cols.amt.x, ty, cols.amt.w, row.h);
    doc
      .font(row.bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(row.bold ? 10 : 9)
      .fillColor("#000")
      .text(row.label, cols.hsn.x + 3, vCenter(ty, row.h, row.bold ? 10 : 9), {
        width: labelColW - 6,
        align: "right",
      });
    doc
      .font("Helvetica-Bold")
      .fontSize(row.bold ? 10 : 9)
      .text(row.value, cols.amt.x, vCenter(ty, row.h, row.bold ? 10 : 9), {
        width: cols.amt.w,
        align: "center",
      });
    ty += row.h;
  }

  y += totalsBlockH + 10;

  // Terms (editable) + signature
  const terms = parseTerms(opts.notes);
  const sigW = 190;
  const sigH = 50;
  const termsW = fullW - sigW - 16;
  const termsBlockH = Math.max(
    sigH + 8,
    terms.reduce((h, t) => h + doc.heightOfString(t, { width: termsW }) + 3, 0)
  );
  ensureSpace(termsBlockH + 8, false);

  const footerTop = y;
  doc.font("Helvetica").fontSize(8).fillColor("#000");
  let termsY = y;
  for (const term of terms) {
    doc.text(term, left, termsY, { width: termsW, align: "left", lineGap: 0.5 });
    termsY = doc.y + 2;
  }

  // Signature image already contains FOR - TUBA CONSTRUCTION + PROPRIETOR
  const sigX = right - sigW;
  const signaturePath = opts.signaturePath;
  if (signaturePath && fs.existsSync(signaturePath)) {
    try {
      doc.image(signaturePath, sigX, footerTop, {
        width: sigW,
        height: sigH,
        fit: [sigW, sigH],
      });
    } catch {
      doc
        .font("Helvetica-Bold")
        .fontSize(9)
        .text(`FOR - ${opts.company.name.toUpperCase()}`, sigX, footerTop, {
          width: sigW,
          align: "right",
        });
      doc.text("PROPRIETOR", sigX, footerTop + 28, { width: sigW, align: "right" });
    }
  } else {
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .text(`FOR - ${opts.company.name.toUpperCase()}`, sigX, footerTop, {
        width: sigW,
        align: "right",
      });
    doc.text("PROPRIETOR", sigX, footerTop + 28, { width: sigW, align: "right" });
  }

  doc.end();
}

router.get("/quotations/:id", async (req, res) => {
  const row = await db.query.quotations.findFirst({
    where: and(eq(quotations.id, req.params.id!), eq(quotations.companyId, req.companyId!)),
  });
  if (!row) return res.status(404).json({ error: "Quotation not found" });

  const items = await db.query.quotationItems.findMany({
    where: eq(quotationItems.quotationId, row.id),
  });
  const customer = await db.query.customers.findFirst({
    where: eq(customers.id, row.customerId),
  });
  const company = await db.query.companies.findFirst({
    where: eq(companies.id, req.companyId!),
  });

  streamQuotationPdf(res, {
    number: row.number,
    date: row.createdAt,
    company: {
      name: company?.name ?? "TUBA CONSTRUCTION",
      address: company?.address,
      gstin: company?.gstin,
      phone: company?.phone,
      email: company?.email,
      pfCode: company?.pfCode,
      esicCode: company?.esicCode,
    },
    customer: {
      name: customer?.name ?? "",
      address: customer?.address,
      gstin: customer?.gstin,
    },
    subject: row.subject,
    validity: row.validity,
    paymentTerms: row.paymentTerms,
    taxRate: row.taxRate,
    subtotal: row.subtotal,
    taxAmount: row.taxAmount,
    total: row.total,
    notes: row.notes,
    items,
    filename: `${row.number.replace(/\//g, "-")}.pdf`,
    logoPath: company
      ? resolveCompanyAsset(company.id, "logo", company.logoFile)
      : null,
    signaturePath: company
      ? resolveCompanyAsset(company.id, "signature", company.signatureFile)
      : null,
  });
});

router.get("/invoices/:id", async (req, res) => {
  const row = await db.query.invoices.findFirst({
    where: and(eq(invoices.id, req.params.id!), eq(invoices.companyId, req.companyId!)),
  });
  if (!row) return res.status(404).json({ error: "Invoice not found" });

  const items = await db.query.invoiceItems.findMany({
    where: eq(invoiceItems.invoiceId, row.id),
  });
  const customer = await db.query.customers.findFirst({
    where: eq(customers.id, row.customerId),
  });
  const company = await db.query.companies.findFirst({
    where: eq(companies.id, req.companyId!),
  });

  streamQuotationPdf(res, {
    docTitle: "Tax Invoice",
    numberLabel: "INVOICE NO.",
    number: row.number,
    date: row.createdAt,
    company: {
      name: company?.name ?? "TUBA CONSTRUCTION",
      address: company?.address,
      gstin: company?.gstin,
      phone: company?.phone,
      email: company?.email,
      pfCode: company?.pfCode,
      esicCode: company?.esicCode,
    },
    customer: {
      name: customer?.name ?? "",
      address: customer?.address,
      gstin: customer?.gstin,
    },
    subject: row.subject?.trim() || "Invoice for",
    validity: row.validity?.trim() || "30 DAYS",
    paymentTerms:
      row.paymentTerms?.trim() ||
      "50% Adv. With P.O. & 50% After Compl., of work within 7 days",
    taxRate: row.taxRate,
    subtotal: row.subtotal,
    taxAmount: row.taxAmount,
    total: row.total,
    notes: row.notes,
    items,
    filename: `${row.number.replace(/\//g, "-")}.pdf`,
    logoPath: company
      ? resolveCompanyAsset(company.id, "logo", company.logoFile)
      : null,
    signaturePath: company
      ? resolveCompanyAsset(company.id, "signature", company.signatureFile)
      : null,
  });
});

export default router;
