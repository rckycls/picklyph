const assert = require('node:assert/strict');
const { test } = require('node:test');
const { isPhpCentavos, assertPhpCentavos, pesosToCentavos, formatPhpCentavos } = require('../src/money.ts');

test('centavo validation rejects fractions, negative/nonfinite/unsafe and coerced inputs', () => {
  for (const amount of [0, 1, 100, 12345, Number.MAX_SAFE_INTEGER]) {
    assert.equal(isPhpCentavos(amount), true);
    assert.doesNotThrow(() => assertPhpCentavos(amount));
  }
  for (const amount of [-1, 0.1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '100', null, undefined, true, 100n]) {
    assert.equal(isPhpCentavos(amount), false);
    assert.throws(() => assertPhpCentavos(amount), RangeError);
    assert.throws(() => formatPhpCentavos(amount), RangeError);
  }
});

test('peso decimals convert exactly without rounding and detect safe-integer overflow', () => {
  for (const [input, expected] of [
    ['0', 0], ['0.01', 1], ['0.1', 10], ['1.15', 115], ['19.99', 1999], ['0002.05', 205],
    ['1250', 125000], ['90071992547409.91', Number.MAX_SAFE_INTEGER],
  ]) assert.equal(pesosToCentavos(input), expected);
  for (const input of ['-1', '+1', '1.001', '.50', '1.', '1e2', '1,000', '₱10', ' 10', '10 ', '10\n', '10\r\n', '', 'NaN', '90071992547409.92', '999999999999999999999', 1.15]) {
    assert.throws(() => pesosToCentavos(input), RangeError);
  }
});

test('PHP display preserves two centavo digits even at the largest safe amount', () => {
  for (const [amount, expected] of [
    [0, '₱0.00'], [1, '₱0.01'], [115, '₱1.15'], [123456, '₱1,234.56'],
    [Number.MAX_SAFE_INTEGER, '₱90,071,992,547,409.91'],
  ]) assert.equal(formatPhpCentavos(amount), expected);
});
