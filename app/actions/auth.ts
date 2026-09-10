"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { AUTH_COOKIE, AUTH_MAX_AGE_S, authEnabled, createAuthToken } from "@/lib/auth";
import { ensureBootstrap, findUserByLogin, verifyPassword } from "@/lib/users";

export type LoginState = { error: string } | null;

// Minimal brute-force guard: after 5 consecutive failures from one IP, a 30s
// pause. The counter lives in process memory; enough for a single instance.
const FAILS_LIMIT = 5;
const BLOCK_MS = 30_000;
const fails = new Map<string, { count: number; blockedUntil: number }>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function clientIp(): Promise<string> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  if (!authEnabled()) redirect("/");
  await ensureBootstrap();

  const now = Date.now();
  const ip = await clientIp();
  const rec = fails.get(ip);
  if (rec && rec.blockedUntil > now) {
    return { error: "Слишком много попыток. Подождите полминуты." };
  }

  const login = formData.get("login");
  const password = formData.get("password");
  const user = typeof login === "string" ? findUserByLogin(login) : null;
  const ok =
    user !== null &&
    !user.disabled &&
    typeof password === "string" &&
    (await verifyPassword(password, user.login));
  if (!ok || !user) {
    await sleep(400);
    const served = rec !== undefined && rec.blockedUntil > 0 && rec.blockedUntil <= now;
    const count = served ? 1 : (rec?.count ?? 0) + 1;
    fails.set(ip, { count, blockedUntil: count >= FAILS_LIMIT ? now + BLOCK_MS : 0 });
    if (fails.size > 1000) fails.clear();
    return { error: "Неверный логин или пароль." };
  }

  fails.delete(ip);
  const token = await createAuthToken({
    userId: user.id,
    login: user.login,
    role: user.role,
  });
  (await cookies()).set(AUTH_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: AUTH_MAX_AGE_S,
  });
  redirect("/");
}

export async function logoutAction(): Promise<void> {
  (await cookies()).delete(AUTH_COOKIE);
  redirect("/login");
}
