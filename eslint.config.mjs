// Linters, chosen for bugs rather than for taste.
//
// This project had none, by an earlier decision: the renderer is ES modules with no build step and
// no formatter, and the house style is matched by hand. What changed is not that taste became
// enforceable — it is that one class of mistake kept shipping, and a check catches it in a second
// where a person catches it in a browser.
//
// The class is `no-undef`. A missing import in this codebase is not a build error; it is a
// `ReferenceError` at the moment that line runs, and three of them shipped: `$` in `toast.js` (so
// the message reporting a failure was itself the failure), `api` in `views/properties.js` (so
// saving a unit did nothing), and `statusLabelsFor` in `views/conflicts.js`, which never existed.
// `tests/module-graph.test.cjs` catches the sibling-import shape of it; a linter catches all of it,
// including the typo in a local name and the global that is not there.
//
// So: correctness rules ON, stylistic rules OFF. A rule that only disagrees with the surrounding
// code is a rule somebody will disable, and a disabled rule protects nothing.
import globals from "globals";
import { defineConfig } from "eslint/config";

/** Bugs in every file, whatever it is. */
const correctness = {
  "no-undef": "error",
  "no-unused-vars": ["error", {
    args: "after-used",
    // A leading underscore is how this codebase already marks a binding it must accept and does
    // not use (an ignored IPC payload, an unused rename).
    argsIgnorePattern: "^_",
    varsIgnorePattern: "^_",
    caughtErrors: "none",
  }],
  "no-redeclare": "error",
  "no-dupe-keys": "error",
  "no-dupe-args": "error",
  "no-dupe-class-members": "error",
  "no-duplicate-case": "error",
  "no-unreachable": "error",
  "no-fallthrough": "error",
  "no-self-assign": "error",
  "no-self-compare": "error",
  "no-constant-condition": ["error", { checkLoops: false }],
  "no-cond-assign": ["error", "except-parens"],
  "no-unsafe-negation": "error",
  "no-unsafe-optional-chaining": "error",
  "no-prototype-builtins": "error",
  "no-debugger": "error",
  "no-sparse-arrays": "error",
  "valid-typeof": "error",
  "use-isnan": "error",
  "no-obj-calls": "error",
  "no-compare-neg-zero": "error",
  "no-template-curly-in-string": "error",
  "require-atomic-updates": "off", // noisy on the async patterns this codebase uses deliberately
  "no-empty": ["error", { allowEmptyCatch: true }], // `catch {}` with a comment is the house style
  "no-console": "off", // the scripts ARE command-line tools; their output is the interface
};

export default defineConfig([
  {
    // The renderer: browser globals, loaded as ES modules over file://.
    files: ["src/renderer/js/**/*.js"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: { ...globals.browser } },
    rules: correctness,
  },
  {
    // `theme-boot.js` is the ONE classic script: it runs in <head> before the modules are deferred,
    // so it has no imports and must not be treated as a module.
    files: ["src/renderer/js/theme-boot.js"],
    languageOptions: { sourceType: "script", globals: { ...globals.browser } },
    rules: { ...correctness, "no-implicit-globals": "error" },
  },
  {
    // The harness: Node ES modules that drive a real browser over CDP.
    files: ["scripts/**/*.mjs"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: { ...globals.node } },
    rules: correctness,
  },
  {
    // The main process: Node CommonJS inside Electron.
    files: ["src/**/*.cjs"],
    languageOptions: { ecmaVersion: 2023, sourceType: "commonjs", globals: { ...globals.node } },
    rules: correctness,
  },
  {
    files: ["tests/**/*.cjs"],
    languageOptions: { ecmaVersion: 2023, sourceType: "commonjs", globals: { ...globals.node } },
    rules: correctness,
  },
  {
    // The marketing site is a CLASSIC script on purpose: as a module it would not load from
    // `file://` at all — module scripts are fetched with CORS and a file origin is opaque — so the
    // page would be blank for anyone who opened the downloaded file. Nothing there needs imports.
    files: ["website/**/*.js"],
    languageOptions: { ecmaVersion: 2023, sourceType: "script", globals: { ...globals.browser } },
    rules: { ...correctness, "no-implicit-globals": "error" },
  },
  // Build output and vendored code are not ours to lint.
  { ignores: ["release/**", "node_modules/**", "artifacts/**", "server/**", ".dsh-vision-toolkit/**"] },
]);
