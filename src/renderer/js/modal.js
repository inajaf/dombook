/**
 * The confirmation dialog.
 *
 * One implementation rather than one per destructive action: a confirmation that looks different
 * every time is one people learn to dismiss without reading, and every caller here is about to
 * delete something.
 */

import { $ } from "./dom.js";

export function confirmAction({ title, text, button = "Подтвердить", action }) {
  $("#confirmTitle").textContent = title;
  $("#confirmText").textContent = text;
  $("#confirmAction").textContent = button;
  const dialog = $("#confirmDialog");
  dialog.returnValue = "";
  dialog.showModal();
  dialog.addEventListener("close", async function onClose() {
    dialog.removeEventListener("close", onClose);
    if (dialog.returnValue !== "confirm") return;
    try {
      await action();
    } catch (error) {
      toast(error.message, "error");
    }
  });
}
