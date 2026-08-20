class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

let mutationTokenPromise: Promise<string> | null = null;

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const raw = await response.text();
  let value: Record<string, unknown> | unknown = raw;
  if (contentType.includes("application/json") && raw) {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new ApiError(`The local API returned invalid JSON (${response.status}).`, response.status);
    }
  }
  if (!response.ok) {
    const message = value && typeof value === "object" && "error" in value
      ? String((value as { error: unknown }).error)
      : raw.trim() || `Request failed: ${response.status}`;
    throw new ApiError(message, response.status);
  }
  return value as T;
}

export async function post<T>(url: string, value: unknown = {}): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const mutationToken = await localMutationToken();
    try {
      return await api<T>(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-attention-mutation-token": mutationToken,
        },
        body: JSON.stringify(value),
      });
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 403 || attempt > 0) throw error;
      mutationTokenPromise = null;
    }
  }
  throw new Error("Local mutation authorization failed.");
}

function localMutationToken(): Promise<string> {
  mutationTokenPromise ??= api<{ mutationToken: string }>("/api/session")
    .then((session) => session.mutationToken)
    .catch((error) => {
      mutationTokenPromise = null;
      throw error;
    });
  return mutationTokenPromise;
}
