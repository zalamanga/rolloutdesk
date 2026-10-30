export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function requiresReconciliation(error: unknown): boolean {
  return !(
    error instanceof ApiError &&
    (error.status === 400 || error.status === 404)
  );
}

export class Api {
  csrfToken = "";
  onUnauthorized = () => {};

  async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(path, {
        method,
        credentials: "same-origin",
        signal: controller.signal,
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(method === "GET" ? {} : { "X-CSRF-Token": this.csrfToken }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        const detail = await response
          .json()
          .catch(() => ({
            code: "REQUEST_FAILED",
            message:
              "The request failed. Refresh to check the current server state.",
          }));
        if (response.status === 401 && path !== "/api/auth/login")
          this.onUnauthorized();
        throw new ApiError(response.status, detail.code, detail.message);
      }
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new Error(
        "The server response could not be confirmed. Refresh to reconcile before another write.",
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
