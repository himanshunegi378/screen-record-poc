/**
 * Safely parses any value to a finite number.
 * Returns null if the parsed value is not a finite number (e.g., NaN, Infinity).
 *
 * @param {*} value - The value to parse.
 * @returns {number|null} The parsed number or null.
 */
function parseFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

module.exports = { parseFiniteNumber };

