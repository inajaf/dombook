/**
 * The theme and text-size switches.
 *
 * Both are DEVICE preferences and both live in localStorage: `app_settings` replicates, so a
 * synced theme would let one device repaint another. The palette itself is in styles.css, and the
 * pre-paint bootstrap that applies it before the first frame is js/theme-boot.js.
 */

import { $ } from "./dom.js";

/**
 * Interface text size.
 *
 * Everything in styles.css is sized from `--text-scale`, so this is the whole implementation of
 * "make it readable" — one number. It is a property of the SCREEN rather than of the business:
 * a 60-year-old owner on a laptop wants large type, the same account on a wall-mounted office
 * display does not, and neither should sync the other's preference. That is why it lives in
 * localStorage and not in app_settings, which the server replicates.
 */
/**
 * The theme switch.
 *
 * The choice is light/dark/auto; the DOCUMENT always carries a resolved light or dark, because the
 * stylesheet has one dark block and a media-query copy would be a second palette to keep in step.
 * The pre-paint bootstrap in js/theme-boot.js owns reading and applying it; this only drives the
 * two controls and keeps them agreeing with each other.
 *
 * Like the text size, and for the same reason: it is a device preference, not account data.
 * `app_settings` replicates, so syncing a theme would let one device repaint another.
 */
const THEME_NAMES = { auto: "Как в системе", light: "Светлая", dark: "Тёмная" };

export function themeChoice() {
  return window.RentKeeperTheme?.read() || "auto";
}

/** The glyph shows what a click will SWITCH TO, which is what a toggle is for. */

/** The glyph shows what a click will SWITCH TO, which is what a toggle is for. */
function themeIcon(resolved) {
  return resolved === "dark"
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.2M12 19.2v2.2M4.2 12H2M22 12h-2.2M6.3 6.3 4.8 4.8M19.2 19.2l-1.5-1.5M17.7 6.3l1.5-1.5M4.8 19.2l1.5-1.5"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.6A8.6 8.6 0 1 1 9.4 3.5a6.9 6.9 0 0 0 11.1 11.1Z"/></svg>';
}

export function applyTheme(choice) {
  const resolved = window.RentKeeperTheme?.apply(choice) || "light";
  const label = $("#themeToggleLabel");
  const icon = $("#themeToggleIcon");
  const select = $("#themeSelect");
  if (label) label.textContent = THEME_NAMES[resolved];
  if (icon) icon.innerHTML = themeIcon(resolved);
  // The select shows the CHOICE, including "auto", while the button shows what is on screen.
  if (select && select.value !== choice) select.value = choice;
  const toggle = $("#themeToggle");
  if (toggle) {
    toggle.setAttribute("aria-label", `Тема: ${THEME_NAMES[resolved]}. Переключить`);
    toggle.dataset.resolved = resolved;
  }
  return resolved;
}

const TEXT_SCALES = { normal: 1, large: 1.12, xlarge: 1.28 };

const TEXT_SCALE_KEY = "rentkeeper.interface-scale";

export function textScaleName() {
  try {
    const stored = localStorage.getItem(TEXT_SCALE_KEY);
    return stored in TEXT_SCALES ? stored : "normal";
  } catch {
    // Storage can be unavailable; the default is the same as a first run.
    return "normal";
  }
}

export function applyTextScale(name) {
  const resolved = name in TEXT_SCALES ? name : "normal";
  document.documentElement.style.setProperty("--text-scale", String(TEXT_SCALES[resolved]));
  try {
    localStorage.setItem(TEXT_SCALE_KEY, resolved);
  } catch {
    // A device that refuses storage still gets the size for this session.
  }
  return resolved;
}
