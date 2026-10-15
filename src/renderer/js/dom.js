/**
 * The smallest DOM helpers, in one place because every other module needs them.
 *
 * `escapeHtml` is not a formatting nicety: every view below builds HTML from data a guest typed
 * into a booking form, and a name containing `<` would otherwise become markup.
 */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function icon(id) {
  return `<svg aria-hidden="true"><use href="#${id}"></use></svg>`;
}

export function setBusy(button, busy, text = "Сохранение…") {
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = text;
    button.disabled = true;
    button.classList.add("is-busy");
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
    button.classList.remove("is-busy");
  }
}

export function showError(target, error) {
  target.textContent = error.message || String(error);
  target.hidden = false;
  target.focus?.();
}
