"use client";

export async function adminFetch<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    credentials: "include",
  });
  const payload = (await response.json().catch(() => ({}))) as { data?: T; error?: string };
  if (!response.ok) {
    throw new Error(payload.error ?? `Request failed with ${response.status}`);
  }
  return payload.data as T;
}
