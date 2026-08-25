import { sign } from "node:crypto";
import { getConfig } from "@/lib/config";
import { githubRequest } from "@/lib/github/api";

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<number, CachedToken>();

function base64url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

function createAppJwt(): string {
  const { appId, privateKey } = getConfig();
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: appId };
  const unsigned = `${base64url(JSON.stringify(header))}.${
    base64url(JSON.stringify(payload))
  }`;
  const signature = sign("RSA-SHA256", Buffer.from(unsigned), privateKey)
    .toString("base64url");
  return `${unsigned}.${signature}`;
}

export async function getInstallationToken(
  installationId: number,
): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }
  const data = await githubRequest<{ token: string; expires_at: string }>(
    `/app/installations/${installationId}/access_tokens`,
    { method: "POST", token: createAppJwt() },
  );
  tokenCache.set(installationId, {
    token: data.token,
    expiresAt: Date.parse(data.expires_at) - 60_000,
  });
  return data.token;
}

export async function getRepoInstallationId(
  owner: string,
  repo: string,
): Promise<number> {
  const data = await githubRequest<{ id: number }>(
    `/repos/${owner}/${repo}/installation`,
    { token: createAppJwt() },
  );
  return data.id;
}
