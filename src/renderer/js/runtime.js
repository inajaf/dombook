/**
 * The seam between a view and the shell.
 *
 * A view draws a page and handles that page's events. Saving a booking, though, has to make the
 * whole screen agree again — the calendar, the counters, the conflict badge — and that is the
 * shell's job. Importing the shell from a view would be a cycle: the shell imports the views to
 * draw them, so the two would initialise in whichever order the loader happened to pick, and the
 * failure mode is a half-initialised module rather than an error.
 *
 * So the dependency points one way. The shell fills these in at boot; a view calls them and does
 * not know what is behind them.
 */
export const runtime = {
  /** Re-read everything and redraw. What a saved form does when it is done. */
  refresh: async () => {},
  /** Move to a page. */
  navigate: () => {},
  /** Say something to the owner. */
  toast: () => {},
};

/** Filled by the shell before anything is drawn. */
export function connectShell(shell) {
  Object.assign(runtime, shell);
}
