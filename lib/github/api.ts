const BASE_URL = "https://api.github.com";

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
