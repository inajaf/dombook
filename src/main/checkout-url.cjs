/**
 * The one place a URL from outside the application reaches the operating system's opener.
 *
 * `shell.openExternal` launches whatever claims the scheme it is handed. The checkout URL comes
 * from the payment provider over the network, so it is an external value at a boundary, and an
 * unguarded one here would be a general "open anything on this machine" primitive if that response
 * were ever influenced.
 *
 * It lives in its own module rather than inline in the handler so it can be tested by calling it.
 * A guard asserted by grepping the source is a guard nobody has run.
 */

/** The payment hosts a checkout may send the user to. Paddle is the provider this product uses. */
const CHECKOUT_HOSTS = new Set([
  "paddle.com",
  "checkout.paddle.com",
  "pay.paddle.com",
  "sandbox-checkout.paddle.com",
]);

/**
 * Return the URL to open, or throw with a message the renderer can show.
 *
 * Only https, and only a known host. A subdomain of a known host is accepted because the provider
 * uses several, and a suffix match is checked against the dot boundary so `evil-paddle.com` is not
 * mistaken for `paddle.com`.
 */
function assertCheckoutUrl(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw));
  } catch {
    throw new Error("Платёжная система вернула ссылку, которую нельзя разобрать");
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Ссылка на оплату должна быть https, получено ${parsed.protocol}`);
  }
  const host = parsed.hostname.toLowerCase();
  const known = CHECKOUT_HOSTS.has(host) || [...CHECKOUT_HOSTS].some((base) => host.endsWith(`.${base}`));
  if (!known) {
    throw new Error(`Ссылка на оплату ведёт на неожиданный адрес: ${host}`);
  }
  return parsed.toString();
}

module.exports = { assertCheckoutUrl, CHECKOUT_HOSTS };
