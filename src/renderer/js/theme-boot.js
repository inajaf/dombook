/**
 * Paint the right theme in the first frame.
 *
 * A CLASSIC script in <head>, deliberately, and the only one left in this file's graph: a module
 * is deferred, so a module would run after the document is parsed and the window would paint light
 * and then turn dark. That reads as a fault rather than as a preference.
 *
 * It is also not inline, because the page's Content-Security-Policy is `script-src 'self'` — an
 * inline bootstrap would be refused, and loosening the policy to allow one is the wrong trade.
 *
 * The stored value is light/dark/auto. "auto" is resolved HERE so the stylesheet only ever has to
 * know a resolved light or dark; the alternative is a second full copy of the palette inside a
 * `prefers-color-scheme` media query, and two copies drift.
 */
(() => {
  const KEY = "rentkeeper.theme";
  const prefersDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;
  const read = () => {
    try {
      return localStorage.getItem(KEY) || "auto";
    } catch {
      // A blocked localStorage is not a reason to render the wrong palette.
      return "auto";
    }
  };
  const resolve = (choice) => (choice === "auto" ? (prefersDark() ? "dark" : "light") : choice);

  window.RentKeeperTheme = {
    KEY,
    read,
    resolve,
    /** Apply a choice (not a resolved value) and remember it. */
    apply(choice) {
      const resolved = resolve(choice);
      document.documentElement.dataset.theme = resolved;
      // Tells the browser which way to render scrollbars and form controls it draws itself.
      document.documentElement.style.colorScheme = resolved;
      try {
        localStorage.setItem(KEY, choice);
      } catch {
        /* the choice simply does not survive a restart */
      }
      return resolved;
    },
  };

  window.RentKeeperTheme.apply(read());
})();
