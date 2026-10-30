import { afterEach, describe, expect, it, vi } from "vitest";
import { Api, ApiError, requiresReconciliation } from "./api";

afterEach(() => vi.unstubAllGlobals());
describe("session and mutation outcomes", () => {
  it("locks stale, failed and unknown outcomes until an explicit read", () => {
    for (const error of [
      new Error("network"),
      new ApiError(409, "STALE", "stale"),
      new ApiError(401, "UNAUTHORIZED", "expired"),
      new ApiError(500, "SERVER", "failed"),
    ])
      expect(requiresReconciliation(error)).toBe(true);
    expect(
      requiresReconciliation(new ApiError(400, "INVALID", "validation")),
    ).toBe(false);
  });
  it("sends session credentials and in-memory CSRF on mutations", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    vi.stubGlobal("fetch", request);
    const api = new Api();
    api.csrfToken = "synthetic-csrf";
    await api.request("/api/flags/bulk-export/staging/publish", "POST", {
      expectedVersion: 2,
      note: "Synthetic release",
    });
    expect(request.mock.calls[0][1]).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      headers: {
        "X-CSRF-Token": "synthetic-csrf",
        "Content-Type": "application/json",
      },
    });
  });
  it("returns a generic uncertain response without echoing raw network errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("private upstream details")),
    );
    await expect(new Api().request("/api/flags")).rejects.toThrow(
      "The server response could not be confirmed",
    );
  });
  it("signals session expiry while preserving the status for reconciliation", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ code: "UNAUTHORIZED", message: "Sign in again." }),
            { status: 401 },
          ),
        ),
    );
    const api = new Api();
    api.onUnauthorized = vi.fn();
    await expect(api.request("/api/flags")).rejects.toBeInstanceOf(ApiError);
    expect(api.onUnauthorized).toHaveBeenCalledOnce();
  });
});
