/**
 * The one-line message that appears after an action.
 *
 * It carries an optional ACTION, which is what makes it useful rather than decorative: the message
 * that says a contract was written also offers to open it, so the owner does not have to remember
 * where it went.
 */

import { $ } from "./dom.js";

/**
 * A short message, optionally with one thing to do about it.
 *
 * The action exists for the case that produced it: a generated document announced itself and then
 * left the owner to find `~/Library/Application Support` — a directory Finder hides by default —
 * to look at the file they had just made. A message that says "the document is ready" without a
 * way to open it is only half an answer.
 */
export function toast(message, type = "success", action = null) {
  const element = document.createElement("div");
  element.className = `toast ${type === "error" ? "error" : ""}`;
  const text = document.createElement("span");
  text.textContent = message;
  element.append(text);
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "toast-action";
    button.textContent = action.label;
    button.addEventListener("click", () => {
      element.remove();
      action.run();
    });
    element.append(button);
  }
  $("#toastRegion").append(element);
  // A toast with an action stays long enough to be read and clicked; both disappear together.
  const lifetime = action ? 9000 : 3700;
  setTimeout(() => element.classList.add("is-leaving"), lifetime);
  setTimeout(() => element.remove(), lifetime + 200);
}
