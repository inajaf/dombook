const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function uuid(): string {
  return crypto.randomUUID();
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export function otpCode(length = 6): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let code = "";
  for (let i = 0; i < length; i++) code += String(bytes[i]! % 10);
  return code;
}

export function base64url(input: Uint8Array): string {
  let binary = "";
  for (const byte of input) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function encJson(value: unknown): string {
  return base64url(encoder.encode(JSON.stringify(value)));
}

export async function signJwt(
  payload: Record<string, unknown>,
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const unsigned = `${encJson(header)}.${encJson(body)}`;
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(unsigned));
  return `${unsigned}.${base64url(new Uint8Array(signature))}`;
}

export async function verifyJwt(token: string, secret: string): Promise<Record<string, unknown> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    base64urlDecode(signature!),
    encoder.encode(`${header}.${body}`),
  );
  if (!valid) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(decoder.decode(base64urlDecode(body!)));
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp < now) return null;
  return payload;
}

// Constant-time string comparison (via SHA-256 digest comparison).
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const da = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(a)));
  const db = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(b)));
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i]! ^ db[i]!;
  return diff === 0;
}

