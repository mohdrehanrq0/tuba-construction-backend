import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseCorsOrigins(): string[] {
  const raw = process.env.CORS_URL ?? process.env.FRONTEND_URL ?? "http://localhost:3000";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required("DATABASE_URL"),
  jwtSecret: required("JWT_SECRET"),
  frontendUrl: process.env.FRONTEND_URL ?? "http://localhost:3000",
  /** Allowed browser origins for CORS (comma-separated in CORS_URL). */
  corsOrigins: parseCorsOrigins(),
  cookieSecure: process.env.COOKIE_SECURE === "true",
  smtp: {
    host: process.env.SMTP_HOST ?? "",
    port: Number(process.env.SMTP_PORT ?? 587),
    user: process.env.SMTP_USER ?? "",
    pass: process.env.SMTP_PASS ?? "",
    from: process.env.SMTP_FROM ?? "Tuba Construction <noreply@tubaconstruction.com>",
  },
};
