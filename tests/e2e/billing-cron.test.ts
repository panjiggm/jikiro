import { expect, test } from "@playwright/test";

const hasCronSecret = Boolean(process.env.CRON_SECRET);

test.describe("Billing cron endpoint", () => {
  test.skip(!hasCronSecret, "CRON_SECRET is not configured.");

  test("rejects request without authorization header", async ({ request }) => {
    const response = await request.get("/api/cron/billing-sweep");

    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({
      error: "Unauthorized",
      ok: false,
    });
  });

  test("rejects request with invalid bearer token", async ({ request }) => {
    const response = await request.get("/api/cron/billing-sweep", {
      headers: {
        authorization: "Bearer invalid-secret",
      },
    });

    expect(response.status()).toBe(401);
  });

  test("accepts request with valid CRON_SECRET", async ({ request }) => {
    const response = await request.get("/api/cron/billing-sweep", {
      headers: {
        authorization: `Bearer ${process.env.CRON_SECRET}`,
      },
    });

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
  });
});
