import type { AttendanceStatus, PayType } from "../db/schema.js";

export function round2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function daysInclusive(startDate: string, endDate: string) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const ms = end.getTime() - start.getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000)) + 1;
}

export function attendanceDayValue(status: AttendanceStatus): number {
  switch (status) {
    case "present":
    case "paid_leave":
      return 1;
    case "half_day":
      return 0.5;
    case "absent":
    default:
      return 0;
  }
}

export type WageComputeInput = {
  payType: PayType;
  fullDays: number;
  halfDays: number;
  otHours: number;
  dailyWage: number;
  monthlySalary: number;
  otRate: number;
  contractAmount: number;
  calendarDays: number;
  advances: number;
  adjustment: number;
};

export type WageComputeResult = {
  rateSnapshot: number | null;
  contractAmountSnapshot: number | null;
  gross: number;
  advancesDeducted: number;
  net: number;
};

export function computeWageLine(input: WageComputeInput): WageComputeResult {
  const workedDays = input.fullDays + input.halfDays * 0.5;
  const otPay = input.otHours * input.otRate;
  let gross = 0;
  let rateSnapshot: number | null = null;
  let contractAmountSnapshot: number | null = null;

  if (input.payType === "daily") {
    rateSnapshot = input.dailyWage;
    gross = workedDays * input.dailyWage + otPay;
  } else if (input.payType === "monthly") {
    rateSnapshot = input.monthlySalary;
    const days = Math.max(input.calendarDays, 1);
    gross = (input.monthlySalary * workedDays) / days + otPay;
  } else {
    contractAmountSnapshot = input.contractAmount;
    // Contract: presence-only; pay comes from adjustment / milestone entry
    gross = 0;
  }

  const advancesDeducted = Math.max(0, input.advances);
  const net = gross - advancesDeducted + input.adjustment;

  return {
    rateSnapshot,
    contractAmountSnapshot,
    gross: round2(gross),
    advancesDeducted: round2(advancesDeducted),
    net: round2(net),
  };
}
