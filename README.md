# Tuba Construction — Backend

Express + TypeScript API with Drizzle ORM and PostgreSQL.

## Prerequisites

- Node.js 20+
- PostgreSQL running locally
- SMTP credentials (optional for local; emails log to console if unset)

## Setup

```bash
createdb tuba
cp .env.example .env
# Edit DATABASE_URL, JWT_SECRET, SMTP_* as needed
npm install
npm run db:push
npm run dev
```

API runs at `http://localhost:4000`.

## Environment

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Postgres connection string |
| `JWT_SECRET` | Secret for auth cookies |
| `PORT` | Default `4000` |
| `FRONTEND_URL` | Frontend base URL for email links, default `http://localhost:3000` |
| `CORS_URL` | Allowed CORS origins (comma-separated). Defaults to `FRONTEND_URL` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | Real SMTP for password reset & invites |

Without SMTP credentials, password-reset and invite emails are printed to the server console.

## Main routes

- `/auth/*` — signup, login, logout, me, forgot/reset password, accept invite
- `/companies/*` — multi-company, members, invites
- `/units`, `/products`, `/customers`
- `/quotations`, `/invoices`, `/pdf/*`, `/dashboard`
# tuba-construction-backend
