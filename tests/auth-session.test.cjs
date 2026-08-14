const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createAuthSessionStore } = require("../src/main/auth-session.cjs");

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "dombook-auth-session-"));
}

function base64Encrypt(text) {
  return Buffer.from(`enc:${Buffer.from(text, "utf8").toString("base64")}`, "utf8");
}

function base64Decrypt(buffer) {
  const value = buffer.toString("utf8");
  if (!value.startsWith("enc:")) throw new Error("not encrypted");
  return Buffer.from(value.slice(4), "base64").toString("utf8");
}

test("сохранённая сессия восстанавливается при включённом шифровании", async () => {
  const dir = await tmpDir();
  const filePath = path.join(dir, "session.bin");
  const store = createAuthSessionStore({
    filePath,
    readFile: (p) => fs.readFile(p),
    writeFile: (p, d) => fs.writeFile(p, d),
    encrypt: base64Encrypt,
    decrypt: base64Decrypt,
    isEncryptionAvailable: () => true,
  });

  const session = { token: "jwt-abc", user: { email: "a@b.com" }, plan: "free" };
  await store.save(session);

  const raw = await fs.readFile(filePath, "utf8");
  assert.ok(raw.startsWith("enc:"), "данные на диске должны быть зашифрованы");

  assert.deepEqual(await store.load(), session);
  await fs.rm(dir, { recursive: true, force: true });
});

test("когда шифрование недоступно, сессия хранится как текст и читается обратно", async () => {
  const dir = await tmpDir();
  const filePath = path.join(dir, "session.bin");
  const store = createAuthSessionStore({
    filePath,
    readFile: (p) => fs.readFile(p),
    writeFile: (p, d) => fs.writeFile(p, d),
    encrypt: () => { throw new Error("no encrypt"); },
    decrypt: () => { throw new Error("no decrypt"); },
    isEncryptionAvailable: () => false,
  });

  const session = { token: "jwt-xyz", accountName: "Тест" };
  await store.save(session);
  assert.deepEqual(await store.load(), session);
  await fs.rm(dir, { recursive: true, force: true });
});

test("сессия, записанная без шифрования, читается когда decrypt недоступен (откат на текст)", async () => {
  const dir = await tmpDir();
  const filePath = path.join(dir, "session.bin");
  // При записи шифрования не было -> данные легли как текст.
  const writer = createAuthSessionStore({
    filePath,
    readFile: (p) => fs.readFile(p),
    writeFile: (p, d) => fs.writeFile(p, d),
    encrypt: base64Encrypt,
    decrypt: base64Decrypt,
    isEncryptionAvailable: () => false,
  });

  await writer.save({ token: "t1" });

  // При чтении шифрование "включено", но decrypt ломается -> должен сработать
  // откат на чтение JSON-текста, а не падать.
  const reader = createAuthSessionStore({
    filePath,
    readFile: (p) => fs.readFile(p),
    writeFile: (p, d) => fs.writeFile(p, d),
    encrypt: base64Encrypt,
    decrypt: () => { throw new Error("boom"); },
    isEncryptionAvailable: () => true,
  });

  assert.deepEqual(await reader.load(), { token: "t1" });
  await fs.rm(dir, { recursive: true, force: true });
});

test("clear() обнуляет хранилище, load() возвращает null", async () => {
  const dir = await tmpDir();
  const filePath = path.join(dir, "session.bin");
  const store = createAuthSessionStore({
    filePath,
    readFile: (p) => fs.readFile(p),
    writeFile: (p, d) => fs.writeFile(p, d),
    encrypt: base64Encrypt,
    decrypt: base64Decrypt,
    isEncryptionAvailable: () => true,
  });

  await store.save({ token: "x" });
  await store.clear();
  assert.equal(await store.load(), null);
  await fs.rm(dir, { recursive: true, force: true });
});

test("отсутствующий файл и пустой файл возвращают null без ошибки", async () => {
  const dir = await tmpDir();
  const filePath = path.join(dir, "missing.bin");
  const store = createAuthSessionStore({
    filePath,
    readFile: (p) => fs.readFile(p),
    writeFile: (p, d) => fs.writeFile(p, d),
    encrypt: base64Encrypt,
    decrypt: base64Decrypt,
    isEncryptionAvailable: () => true,
  });
  await fs.writeFile(filePath, Buffer.alloc(0));
  assert.equal(await store.load(), null);
  await store.clear();
  assert.equal(await store.load(), null);
  await fs.rm(dir, { recursive: true, force: true });
});
