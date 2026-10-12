// Amounts are integers in micro-USD (1 USD = 1_000_000 micros) so per-call
// prices below one cent stay exact. PayPal only moves whole cents.
export const MICROS_PER_USD = 1_000_000;
export const MICROS_PER_CENT = 10_000;

const DECIMAL = /^(0|[1-9]\d*)(\.\d{1,6})?$/;

export function parseUsd(value: string): number {
  if (!DECIMAL.test(value)) throw new Error(`invalid USD amount: ${JSON.stringify(value)}`);
  const [whole, frac = ""] = value.split(".");
  const micros = Number(whole) * MICROS_PER_USD + Number((frac + "000000").slice(0, 6));
  if (!Number.isSafeInteger(micros)) throw new Error(`USD amount out of range: ${value}`);
  return micros;
}

export function formatUsd(micros: number): string {
  assertMicros(micros);
  const whole = Math.floor(micros / MICROS_PER_USD);
  let frac = String(micros % MICROS_PER_USD).padStart(6, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${whole}.${frac}`;
}

/** PayPal `amount.value` for a whole number of cents, e.g. 1234 -> "12.34". */
export function centsToValue(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error(`invalid cents: ${cents}`);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

export function valueToCents(value: string): number {
  const micros = parseUsd(value);
  if (micros % MICROS_PER_CENT !== 0) throw new Error(`not a whole-cent amount: ${value}`);
  return micros / MICROS_PER_CENT;
}

export function assertMicros(micros: number): void {
  if (!Number.isSafeInteger(micros) || micros < 0) throw new Error(`invalid micros: ${micros}`);
}
