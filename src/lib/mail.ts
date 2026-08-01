import nodemailer from "nodemailer";
import { env } from "./env.js";

function createTransport() {
  if (!env.smtp.host || !env.smtp.user) {
    return null;
  }
  return nodemailer.createTransport({
    host: env.smtp.host,
    port: env.smtp.port,
    secure: env.smtp.port === 465,
    auth: {
      user: env.smtp.user,
      pass: env.smtp.pass,
    },
  });
}

async function sendMail(options: {
  to: string;
  subject: string;
  html: string;
  text: string;
}) {
  const transport = createTransport();
  if (!transport) {
    console.warn("[mail] SMTP not configured. Email would have been sent:");
    console.warn(`To: ${options.to}`);
    console.warn(`Subject: ${options.subject}`);
    console.warn(options.text);
    return { preview: true as const };
  }
  await transport.sendMail({
    from: env.smtp.from,
    to: options.to,
    subject: options.subject,
    html: options.html,
    text: options.text,
  });
  return { preview: false as const };
}

export async function sendPasswordResetEmail(to: string, token: string) {
  const link = `${env.frontendUrl}/reset-password?token=${token}`;
  return sendMail({
    to,
    subject: "Reset your Tuba Construction password",
    text: `Reset your password using this link (expires in 1 hour):\n${link}`,
    html: `<p>Reset your password using this link (expires in 1 hour):</p><p><a href="${link}">${link}</a></p>`,
  });
}

export async function sendInviteEmail(opts: {
  to: string;
  companyName: string;
  role: string;
  token: string;
}) {
  const link = `${env.frontendUrl}/accept-invite?token=${opts.token}`;
  return sendMail({
    to: opts.to,
    subject: `You're invited to join ${opts.companyName} on Tuba Construction`,
    text: `You've been invited to join ${opts.companyName} as ${opts.role}.\nAccept the invite and create your account:\n${link}`,
    html: `<p>You've been invited to join <strong>${opts.companyName}</strong> as <strong>${opts.role}</strong>.</p><p><a href="${link}">Accept invite & create account</a></p>`,
  });
}

export async function sendAddedToCompanyEmail(opts: {
  to: string;
  companyName: string;
  role: string;
}) {
  const link = `${env.frontendUrl}/login`;
  return sendMail({
    to: opts.to,
    subject: `You've been added to ${opts.companyName}`,
    text: `You've been added to ${opts.companyName} as ${opts.role}. Sign in: ${link}`,
    html: `<p>You've been added to <strong>${opts.companyName}</strong> as <strong>${opts.role}</strong>.</p><p><a href="${link}">Sign in</a></p>`,
  });
}
