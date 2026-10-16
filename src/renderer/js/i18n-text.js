/**
 * Text a VIEW builds, rather than text the markup already contains.
 *
 * `i18n.js` translates the DOM: it walks text nodes and swaps each Russian source string for its
 * entry in the dictionary. That covers everything written into `index.html` and nothing a view
 * assembles at runtime, so a phrase built in JavaScript has no dictionary entry and stays Russian
 * in every language. The i18n test reads the markup, so it cannot see them either.
 *
 * Two such phrases shipped in the calendar: an English interface showed "17 из 84 ночей" and
 * "свободно 14 ночей с Oct 29". Found by screenshotting the app in English, which is the only
 * thing that would have found them.
 *
 * `translate` falls back to the source string, so a missing entry shows Russian rather than a key name or
 * a blank. `withCounts` fills `{placeholders}` AFTER translating, because word order differs: the
 * English "{taken} of {capacity} nights" and the Azerbaijani "{capacity} gecədən {taken}" put the
 * numbers in different places.
 */
export function translate(source) {
  return window.i18n?.t?.(source) ?? source;
}

export function withCounts(template, values) {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    template,
  );
}
