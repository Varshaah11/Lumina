import type { ApiErrorBody } from "@/types/api";
import { API_BASE_URL } from "@/lib/config";

export class ApiError extends Error {
  constructor(public status: number, message: string, public data?: ApiErrorBody | string | null) {
    super(message);
    this.name = "ApiError";
  }
}

export const api = async <T>(endpoint: string, options: RequestInit = {}): Promise<T> => {
  const url = `${API_BASE_URL}${endpoint}`;
  const headers = new Headers(options.headers || {});
  
  if (!headers.has("Content-Type") && !(options.body instanceof URLSearchParams)) {
    headers.set("Content-Type", "application/json");
  } else if (options.body instanceof URLSearchParams) {
    headers.set("Content-Type", "application/x-www-form-urlencoded");
  }

  // Auth is carried by the HttpOnly cookie the backend sets; JS never sees or sends the JWT itself
  const response = await fetch(url, {
    ...options,
    headers,
    credentials: "include",
  });

  let data: unknown;
  const contentType = response.headers.get("content-type");
  try {
    if (contentType && contentType.includes("application/json")) {
      data = await response.json();
    } else {
      data = await response.text();
    }
  } catch {
    data = null;
  }

  if (!response.ok) {
    // Try to extract detail message from FastAPI error format
    const body: ApiErrorBody | null = data && typeof data === "object" ? (data as ApiErrorBody) : null;
    const message = body?.detail
      ? (typeof body.detail === 'string' ? body.detail : body.detail[0]?.msg || JSON.stringify(body.detail))
      : (body?.message || "An error occurred");
    throw new ApiError(response.status, message, body ?? (typeof data === "string" ? data : null));
  }

  return data as T;
};
