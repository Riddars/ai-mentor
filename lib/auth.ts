// Token cryptography and viewer identity. This file holds ONLY token crypto and
// carries no database access, so proxy.ts can verify a signature on every request
// without opening SQLite. The user store and password handling live in lib/users.ts.

export const AUTH_COOKIE = "auth";
export const AUTH_MAX_AGE_S = 30 * 24 * 60 * 60;

const encoder = new TextEncoder();

/** Panel roles. Students do not use the panel; they work through GitHub. */
export type Role = "head" | "supervisor";

/** The current viewer, extracted from the token. Basis of every access check. */
export type Viewer = {
  userId: string;
  login: string;
  role: Role;
  /** Copy of users.session_version at sign-in; a mismatch revokes the token. */
  sessionVersion: number;
};

/**
 * Auth is on only when AUTH_SECRET is set. Without it: open in development,
 * closed in production (fail closed). Revocation of issued tokens goes through
 * sessionVersion (checked by getViewer), not through the secret.
 */
export function authEnabled(): boolean {
  return Boolean(process.env.AUTH_SECRET);
}

async function signingKey(): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`ai-curator-auth-v1:${process.env.AUTH_SECRET ?? ""}`),
  );
  return crypto.subtle.importKey(
    "raw",
    digest,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function hmacHex(payload: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await signingKey(), encoder.encode(payload));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string compare — does not leak the matched prefix length. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

type TokenPayload = Viewer & { exp: number };

/** Issue a token "<payload base64url>.<HMAC signature>" with an expiry. */
export async function createAuthToken(viewer: Viewer): Promise<string> {
  const payload: TokenPayload = { ...viewer, exp: Date.now() + AUTH_MAX_AGE_S * 1000 };
  const body = b64urlEncode(encoder.encode(JSON.stringify(payload)));
  return `${body}.${await hmacHex(body)}`;
}

/**
 * Verify a token and return the identity it carries, or null when the signature
 * does not match, the token expired, or the shape is wrong. Crypto only: whether
 * the user still exists and is enabled is checked by getViewer.
 */
export async function verifyAuthToken(token: string | undefined): Promise<Viewer | null> {
  if (!authEnabled() || !token) return null;
  const dot = token.indexOf(".");
  if (dot === -1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmacHex(body);
  if (!timingSafeEqualStr(sig, expected)) return null;
  try {
    const raw = new TextDecoder().decode(b64urlDecode(body));
    const p = JSON.parse(raw) as Partial<TokenPayload>;
    if (
      typeof p.userId !== "string" ||
      typeof p.login !== "string" ||
      (p.role !== "head" && p.role !== "supervisor") ||
      typeof p.sessionVersion !== "number" ||
      typeof p.exp !== "number" ||
      p.exp <= Date.now()
    ) {
      return null;
    }
    return { userId: p.userId, login: p.login, role: p.role, sessionVersion: p.sessionVersion };
  } catch {
    return null;
  }
}
