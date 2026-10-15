#!/usr/bin/env node
/**
 * Where Electron keeps an app's userData directory, per platform.
 *
 * The end-to-end harness deletes that directory to start from a clean database, and both copies
 * of the path were macOS-only (`~/Library/Application Support/<name>`). On a Linux runner the
 * delete removed nothing, every suite inherited the previous run's rows, and the failures that
 * followed look exactly like product bugs — a booking refused as occupied by a row the suite
 * never created. That is the same shape as the harness-replay flake, from a different cause.
 *
 * One definition, used by the bash stack script (through the CLI at the bottom) and by
 * `e2e-lib.mjs` (through the export), so the two cannot disagree about what "clean" means.
 */
import os from "node:os";
import path from "node:path";

export function userDataDir(appName) {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", appName);
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), appName);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), appName);
}

/** Every name this product has kept a profile under, current first. */
export const PROFILE_NAMES = ["rentkeeper-desktop", "dombook-desktop"];

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  process.stdout.write(userDataDir(process.argv[2] || PROFILE_NAMES[0]));
}
