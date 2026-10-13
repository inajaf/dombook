"use strict";

// Persists the authenticated JWT session at rest, encrypting it when the
// host platform provides a secret store (Electron safeStorage). Kept free of
// Electron imports so it can be unit-tested with plain Node by injecting
// `readFile`/`writeFile`/`encrypt`/`decrypt`/`isEncryptionAvailable`.
//
// Storage layout is a single file holding either an encrypted blob (when
// encryption is available) or the raw UTF-8 JSON (fallback). On load we try
// decryption first, then fall back to plain text so a session written when
// the secret store was unavailable can still be restored later.

function createAuthSessionStore({
  filePath,
  readFile,
  writeFile,
  encrypt,
  decrypt,
  isEncryptionAvailable = () => false,
}) {
  async function save(session) {
    const json = JSON.stringify(session);
    const content = isEncryptionAvailable() ? encrypt(json) : Buffer.from(json, "utf8");
    await writeFile(filePath, content);
  }

  async function load() {
    try {
      const content = await readFile(filePath);
      if (!content || content.length === 0) return null;
      if (isEncryptionAvailable()) {
        try {
          const plain = decrypt(content);
          if (plain) return JSON.parse(plain);
        } catch {
          // fall through to the plain-text path
        }
      }
      const text = Buffer.isBuffer(content) ? content.toString("utf8") : String(content);
      if (!text.trim()) return null;
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  async function clear() {
    try {
      await writeFile(filePath, Buffer.alloc(0));
    } catch {
      // ignore write failures on clear; the session is treated as gone
    }
  }

  return { save, load, clear };
}

module.exports = { createAuthSessionStore };
