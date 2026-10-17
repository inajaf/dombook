/**
 * Reading a field that arrives from outside the domain.
 *
 * These live here because two layers read the same fields: the store's own write methods, and the
 * read models that turn a form's or a query parameter's string into the number the domain needs.
 * Copying `integer` into the second of those would be two validators that agree until one is
 * changed, which is the drift this project keeps writing down rather than repeating.
 *
 * They throw. A field that cannot be read is a caller's mistake, and a silent default here would
 * turn a typo in a date range into a calendar quietly showing a different window.
 */
function integer(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < min || result > max) {
    throw new Error(`${label}: укажите целое число от ${min} до ${max}`);
  }
  return result;
}

function validDate(value, label) {
  const result = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) {
    throw new Error(`${label}: неверная дата`);
  }
  const [year, month, day] = result.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`${label}: неверная дата`);
  }
  return result;
}

module.exports = { integer, validDate };
