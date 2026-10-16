const test = require("node:test");
const assert = require("node:assert/strict");
const { assertCheckoutUrl } = require("../src/main/checkout-url.cjs");

// `shell.openExternal` hands a URL to the operating system, which launches whatever claims the
// scheme. The checkout URL arrives from the payment provider over the network, so this is an
// external value at a boundary, and the guard is the only thing between a bad response and an
// "open anything on this machine" primitive.

test("ссылка на оплату от платёжной системы проходит", () => {
  assert.equal(assertCheckoutUrl("https://checkout.paddle.com/checkout/abc"), "https://checkout.paddle.com/checkout/abc");
  assert.equal(assertCheckoutUrl("https://pay.paddle.com/x"), "https://pay.paddle.com/x");
  assert.equal(assertCheckoutUrl("https://paddle.com/x"), "https://paddle.com/x");
});

test("чужой хост отклоняется", () => {
  // The case that matters: a response that points somewhere else entirely.
  assert.throws(() => assertCheckoutUrl("https://evil.example.com/pay"), /неожиданный адрес/);
  assert.throws(() => assertCheckoutUrl("https://paddle.com.evil.example/pay"), /неожиданный адрес/);
});

test("похожий хост не считается своим", () => {
  // The suffix check has to end at a dot boundary, or `evil-paddle.com` passes a naive endsWith.
  assert.throws(() => assertCheckoutUrl("https://evil-paddle.com/pay"), /неожиданный адрес/);
  assert.throws(() => assertCheckoutUrl("https://notpaddle.com/pay"), /неожиданный адрес/);
  assert.equal(assertCheckoutUrl("https://sandbox-checkout.paddle.com/x"), "https://sandbox-checkout.paddle.com/x");
});

test("не https отклоняется", () => {
  assert.throws(() => assertCheckoutUrl("http://checkout.paddle.com/x"), /должна быть https/);
  assert.throws(() => assertCheckoutUrl("file:///etc/passwd"), /должна быть https/);
  assert.throws(() => assertCheckoutUrl("javascript:alert(1)"), /должна быть https/);
});

test("мусор вместо ссылки отклоняется, а не падает наружу", () => {
  assert.throws(() => assertCheckoutUrl(""), /нельзя разобрать/);
  assert.throws(() => assertCheckoutUrl(undefined), /нельзя разобрать/);
  assert.throws(() => assertCheckoutUrl({}), /нельзя разобрать/);
});
