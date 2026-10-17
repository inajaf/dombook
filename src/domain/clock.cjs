/**
 * The clock, in one place.
 *
 * `nowIso` lived inside `database.cjs` and was used both by the store and by the migrations that
 * moved out of it. Copying three lines into the new module would have been the drift this project
 * keeps writing down: two clocks that agree until somebody changes one.
 *
 * It is a module rather than an injected dependency because nothing in the product benefits from
 * substituting it. `todayInTimeZone` exists on the store because a booking window depends on the
 * account's zone, and that is a real seam; this is not.
 */
const { todayInTimeZone } = require("./booking/booking-policy.cjs");

function nowIso() {
  return new Date().toISOString();
}

/**
 * Today, as the account's time zone sees it.
 *
 * Separate from `nowIso` on purpose: a timestamp is universal and a DATE is local, and a booking
 * that starts today in Baku is not today in UTC for three hours of every evening.
 */
function todayIso() {
  return todayInTimeZone();
}

module.exports = { nowIso, todayIso };
