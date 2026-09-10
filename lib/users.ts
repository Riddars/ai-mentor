import "server-only";
import { cache } from "react";
import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { getDb } from "@/lib/db";
import {
  AUTH_COOKIE,
  authEnabled,
  timingSafeEqualStr,
  verifyAuthToken,
  type Role,
  type Viewer,
} from "@/lib/auth";

// User store and passwords. Touches the database, so it is NOT imported from
// proxy.ts (edge). Passwords are stored only as a PBKDF2-SHA256 hash, never in
// clear. The signed-in identity for pages and actions comes from getViewer().

export type User = {
  id: string;
  login: string;
  role: Role;
  name: string | null;
  disabled: boolean;
  createdAt: string;
};

type UserRow = User & { password_salt: string; password_hash: string };

const encoder = new TextEncoder();
const PBKDF2_ITERATIONS = 120_000;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function derive(password: string, salt: BufferSource): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

async function hashPassword(password: string): Promise<{ salt: string; hash: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: bytesToHex(salt), hash: await derive(password, salt) };
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    login: row.login,
    role: row.role,
    name: row.name,
    disabled: Boolean((row as unknown as { disabled: number }).disabled),
    createdAt: (row as unknown as { created_at: string }).created_at,
  };
}

function findRowByLogin(login: string): UserRow | null {
  const row = getDb()
    .prepare("SELECT * FROM users WHERE login = @login COLLATE NOCASE")
    .get({ login }) as UserRow | undefined;
  return row ?? null;
}

export function findUserByLogin(login: string): User | null {
  const row = findRowByLogin(login);
  return row ? toUser(row) : null;
}

export function findUserById(id: string): User | null {
  const row = getDb().prepare("SELECT * FROM users WHERE id = @id").get({ id }) as
    | UserRow
    | undefined;
  return row ? toUser(row) : null;
}

export function listUsers(): User[] {
  const rows = getDb()
    .prepare("SELECT * FROM users ORDER BY created_at")
    .all() as unknown as UserRow[];
  return rows.map(toUser);
}

export async function verifyPassword(input: string, login: string): Promise<boolean> {
  if (input.length === 0 || input.length > 200) return false;
  const row = findRowByLogin(login);
  if (!row) return false;
  const got = await derive(input, hexToBytes(row.password_salt));
  return timingSafeEqualStr(got, row.password_hash);
}

export async function createUser(params: {
  login: string;
  password: string;
  role: Role;
  name?: string;
}): Promise<User> {
  const { salt, hash } = await hashPassword(params.password);
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO users (id, login, password_salt, password_hash, role, name)
       VALUES (@id, @login, @salt, @hash, @role, @name)`,
    )
    .run({
      id,
      login: params.login,
      salt,
      hash,
      role: params.role,
      name: params.name ?? null,
    });
  return findUserById(id)!;
}

export function setUserDisabled(id: string, disabled: boolean): void {
  getDb()
    .prepare("UPDATE users SET disabled = @disabled WHERE id = @id")
    .run({ id, disabled: disabled ? 1 : 0 });
}

export function usersCount(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
  return row.n;
}

/**
 * Create the first head account from HEAD_LOGIN / HEAD_PASSWORD when the user
 * table is empty. Runs at login time; a no-op once any account exists.
 */
export async function ensureBootstrap(): Promise<void> {
  if (usersCount() > 0) return;
  const login = process.env.HEAD_LOGIN;
  const password = process.env.HEAD_PASSWORD;
  if (!login || !password) return;
  await createUser({ login, password, role: "head", name: "Head" });
}

/** Current viewer from the cookie, re-checked against the live user record. */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  if (!authEnabled()) {
    // Development convenience: with auth off, act as a head so the panel is usable.
    if (process.env.NODE_ENV === "development") {
      return { userId: "dev", login: "dev", role: "head" };
    }
    return null;
  }
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  const claim = await verifyAuthToken(token);
  if (!claim) return null;
  const user = findUserById(claim.userId);
  if (!user || user.disabled) return null;
  return { userId: user.id, login: user.login, role: user.role };
});
