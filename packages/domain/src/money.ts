export const PHP_CURRENCY = 'PHP';
export const CENTAVOS_PER_PESO = 100;

/** Nonnegative safe integers only; never round a monetary amount. */
export function isPhpCentavos(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function assertPhpCentavos(value: unknown): asserts value is number {
  if (!isPhpCentavos(value)) throw new RangeError('Amount must be nonnegative safe integer centavos.');
}

/** Parse a plain decimal peso input exactly, without floating-point multiplication. */
export function pesosToCentavos(value: string): number {
  if (typeof value !== 'string' || value !== value.trim() || !/^\d+(?:\.\d{1,2})?$/.test(value)) {
    throw new RangeError('Use a plain peso amount with at most two decimal places.');
  }
  const [pesos = '0', fraction = ''] = value.split('.');
  const amount = BigInt(pesos) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Amount exceeds safe integer centavos.');
  return Number(amount);
}

const pesoGrouping = new Intl.NumberFormat('en-PH', { maximumFractionDigits: 0 });

/** Always display both centavo digits, including at the safe-integer upper boundary. */
export function formatPhpCentavos(value: number): string {
  assertPhpCentavos(value);
  return `₱${pesoGrouping.format(Math.floor(value / 100))}.${String(value % 100).padStart(2, '0')}`;
}
