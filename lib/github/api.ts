const BASE_URL = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 30_000;

interface RequestOptions {
  method?: string;
  token: string;
  body?: unknown;
}

export async function githubRequest<T = unknown>(
  path: string,
  { method = "GET", token, body }: RequestOptions,
): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    // A hung connection would otherwise hold the caller (e.g. a worker tick) for minutes.
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `GitHub ${method} ${path} failed: ${response.status} ${detail}`,
    );
  }

  if (response.status === 204) {
    return null as T;
  }
  return response.json() as Promise<T>;
}
