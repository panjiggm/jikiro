# Billing Cron Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a daily Vercel Cron that (1) downgrades expired paid subscriptions to Free and (2) hard-deletes pending checkouts whose `expiresAt` has passed, so the database reflects real billing state for analytics and reporting.

**Architecture:** Single HTTP endpoint `GET /api/cron/billing-sweep` invoked daily at 00:00 UTC (07:00 WIB). Endpoint authenticates via `CRON_SECRET`, runs two isolated tasks (downgrade + cleanup) via `Promise.allSettled`, and logs results to Vercel Logs. Business logic lives in `lib/billing/cron.ts`; DB access in `lib/db/billing-queries.ts`.

**Tech Stack:** Next.js 16 Route Handler, Drizzle ORM (Neon PostgreSQL), Vercel Cron Jobs, Playwright for E2E tests.

**Spec:** `docs/superpowers/specs/2026-04-23-billing-cron-design.md`

---

## File Structure

### New Files
- `app/api/cron/billing-sweep/route.ts` — HTTP entrypoint (auth + dispatch)
- `lib/billing/cron.ts` — business logic (`runSubscriptionDowngradeSweep`, `runPendingCheckoutCleanup`)
- `tests/e2e/billing-cron.test.ts` — E2E tests

### Modified Files
- `lib/db/billing-queries.ts` — add `findExpiredPaidSubscriptions()`, `deleteExpiredPendingCheckouts()`
- `vercel.json` — add `crons` array
- `.env.example` — add `CRON_SECRET` placeholder

---

## Task 1: Scaffold Cron Endpoint with Auth Guard

**Goal:** Create the route handler that returns 401 without a valid `CRON_SECRET`, and 200 with it. No business logic yet — just the auth skeleton.

**Files:**
- Create: `app/api/cron/billing-sweep/route.ts`
- Modify: `.env.example` (add CRON_SECRET)
- Test: `tests/e2e/billing-cron.test.ts`

- [ ] **Step 1: Add CRON_SECRET to `.env.example`**

Modify `.env.example` — add at the end:

```bash

# Cron job authentication (generate via: openssl rand -hex 32)
CRON_SECRET=
```

- [ ] **Step 2: Generate secret and add to `.env.local`**

Run:
```bash
echo "" >> .env.local
echo "# Cron" >> .env.local
echo "CRON_SECRET=$(openssl rand -hex 32)" >> .env.local
```

Then verify with:
```bash
grep CRON_SECRET .env.local
```
Expected output: `CRON_SECRET=<64 hex chars>`

- [ ] **Step 3: Write the failing test (auth guard)**

Create `tests/e2e/billing-cron.test.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm test tests/e2e/billing-cron.test.ts`

Expected: All 3 tests FAIL — endpoint returns 404 (route doesn't exist).

- [ ] **Step 5: Implement minimal endpoint with auth guard**

Create `app/api/cron/billing-sweep/route.ts`:

```ts
import "server-only";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");

  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json(
      { error: "Unauthorized", ok: false },
      { status: 401 }
    );
  }

  return Response.json({ ok: true });
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test tests/e2e/billing-cron.test.ts`

Expected: All 3 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add app/api/cron/billing-sweep/route.ts tests/e2e/billing-cron.test.ts .env.example
git commit -m "feat(billing): scaffold cron sweep endpoint with auth guard

Adds GET /api/cron/billing-sweep protected by CRON_SECRET.
No business logic yet — auth skeleton only."
```

---

## Task 2: Add `findExpiredPaidSubscriptions` Query

**Goal:** Add a Drizzle query that returns subscriptions eligible for downgrade: paid plan, status active, `currentPeriodEnd <= now`.

**Files:**
- Modify: `lib/db/billing-queries.ts`

- [ ] **Step 1: Add `lte` and `ne` to drizzle-orm import**

In `lib/db/billing-queries.ts`, the current import is:
```ts
import { and, desc, eq, sql } from "drizzle-orm";
```

Change to:
```ts
import { and, desc, eq, lte, ne, sql } from "drizzle-orm";
```

- [ ] **Step 2: Add `findExpiredPaidSubscriptions` function**

Append to `lib/db/billing-queries.ts` (end of file):

```ts
export async function findExpiredPaidSubscriptions() {
  try {
    const now = new Date();
    return await db
      .select()
      .from(subscription)
      .where(
        and(
          ne(subscription.planSlug, "free"),
          eq(subscription.status, "active"),
          lte(subscription.currentPeriodEnd, now)
        )
      );
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to find expired paid subscriptions"
    );
  }
}
```

- [ ] **Step 3: Verify lint passes**

Run: `pnpm check lib/db/billing-queries.ts`

Expected: `Checked 1 file. No fixes applied.`

- [ ] **Step 4: Commit**

```bash
git add lib/db/billing-queries.ts
git commit -m "feat(billing): add findExpiredPaidSubscriptions query

Returns subscriptions with paid plan, active status, and
currentPeriodEnd in the past — candidates for downgrade."
```

---

## Task 3: Add `deleteExpiredPendingCheckouts` Query

**Goal:** Add a Drizzle query that hard-deletes pending checkouts whose `expiresAt` has passed. Returns count of deleted rows.

**Files:**
- Modify: `lib/db/billing-queries.ts`

- [ ] **Step 1: Add `isNotNull` to drizzle-orm import**

In `lib/db/billing-queries.ts`, update the import:

```ts
import { and, desc, eq, isNotNull, lte, ne, sql } from "drizzle-orm";
```

- [ ] **Step 2: Add `deleteExpiredPendingCheckouts` function**

Append to `lib/db/billing-queries.ts` (end of file):

```ts
export async function deleteExpiredPendingCheckouts() {
  try {
    const now = new Date();
    const deleted = await db
      .delete(billingCheckout)
      .where(
        and(
          eq(billingCheckout.status, "pending"),
          isNotNull(billingCheckout.expiresAt),
          lte(billingCheckout.expiresAt, now)
        )
      )
      .returning({ id: billingCheckout.id });

    return deleted.length;
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to delete expired pending checkouts"
    );
  }
}
```

- [ ] **Step 3: Verify lint passes**

Run: `pnpm check lib/db/billing-queries.ts`

Expected: `Checked 1 file. No fixes applied.`

- [ ] **Step 4: Commit**

```bash
git add lib/db/billing-queries.ts
git commit -m "feat(billing): add deleteExpiredPendingCheckouts query

Hard-deletes pending checkouts whose expiresAt has passed.
Returns count of removed rows."
```

---

## Task 4: Implement `runSubscriptionDowngradeSweep`

**Goal:** Write business logic to iterate expired paid subscriptions and downgrade each to Free, with per-row error isolation. Wire into cron endpoint. Verify via E2E test.

**Files:**
- Create: `lib/billing/cron.ts`
- Modify: `app/api/cron/billing-sweep/route.ts`
- Test: `tests/e2e/billing-cron.test.ts`

- [ ] **Step 1: Write the failing E2E test**

Append to `tests/e2e/billing-cron.test.ts` (inside the `test.describe` block, after the existing tests):

```ts
  test("downgrades an expired paid subscription to free", async ({
    request,
  }) => {
    // Arrange: seed a Pro subscription whose period has already ended
    const { db } = await import("../../lib/db/client");
    const { getPlanSnapshot } = await import("../../lib/billing/plans");
    const { subscription, user } = await import("../../lib/db/schema");
    const { eq } = await import("drizzle-orm");

    const proSnapshot = getPlanSnapshot("pro", "monthly");
    const freeSnapshot = getPlanSnapshot("free", "monthly");

    const [seededUser] = await db
      .insert(user)
      .values({
        email: `cron-sweep-${Date.now()}@e2e.test`,
        name: "Cron Sweep E2E",
      })
      .returning();

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const lastMonth = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);

    await db.insert(subscription).values({
      currentPeriodEnd: yesterday,
      currentPeriodStart: lastMonth,
      interval: "monthly",
      planSlug: "pro",
      planSnapshot: proSnapshot,
      status: "active",
      userId: seededUser.id,
    });

    // Act: hit the cron endpoint
    const response = await request.get("/api/cron/billing-sweep", {
      headers: {
        authorization: `Bearer ${process.env.CRON_SECRET}`,
      },
    });

    // Assert: subscription was downgraded to free
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);

    const [downgraded] = await db
      .select()
      .from(subscription)
      .where(eq(subscription.userId, seededUser.id))
      .limit(1);

    expect(downgraded?.planSlug).toBe("free");
    expect(downgraded?.status).toBe("active");
    expect(downgraded?.planSnapshot).toEqual(freeSnapshot);
    expect(downgraded?.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now());
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test tests/e2e/billing-cron.test.ts -g "downgrades an expired"`

Expected: FAIL — the expired Pro subscription is still `planSlug: "pro"` because endpoint returns early without downgrading.

- [ ] **Step 3: Create `lib/billing/cron.ts`**

Create `lib/billing/cron.ts`:

```ts
import "server-only";

import { addMonths } from "date-fns";
import { getPlanSnapshot } from "@/lib/billing/plans";
import {
  findExpiredPaidSubscriptions,
  saveSubscription,
} from "@/lib/db/billing-queries";

export type DowngradeSweepResult = {
  succeeded: number;
  failed: number;
  errors: Array<{ subscriptionId: string; message: string }>;
};

export async function runSubscriptionDowngradeSweep(): Promise<DowngradeSweepResult> {
  const expired = await findExpiredPaidSubscriptions();
  const result: DowngradeSweepResult = {
    errors: [],
    failed: 0,
    succeeded: 0,
  };

  for (const sub of expired) {
    try {
      const now = new Date();
      await saveSubscription({
        currentPeriodEnd: addMonths(now, 1),
        currentPeriodStart: now,
        interval: "monthly",
        lastCheckoutId: sub.lastCheckoutId,
        planSlug: "free",
        planSnapshot: getPlanSnapshot("free", "monthly"),
        status: "active",
        subscriptionId: sub.id,
        userId: sub.userId,
      });
      result.succeeded++;
    } catch (error) {
      result.failed++;
      result.errors.push({
        message: error instanceof Error ? error.message : String(error),
        subscriptionId: sub.id,
      });
    }
  }

  return result;
}
```

- [ ] **Step 4: Wire into endpoint**

Replace the contents of `app/api/cron/billing-sweep/route.ts` with:

```ts
import "server-only";

import { runSubscriptionDowngradeSweep } from "@/lib/billing/cron";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");

  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json(
      { error: "Unauthorized", ok: false },
      { status: 401 }
    );
  }

  const [downgrade] = await Promise.allSettled([
    runSubscriptionDowngradeSweep(),
  ]);

  console.log("[BillingSweep]", { downgrade });

  return Response.json({ downgrade, ok: true });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test tests/e2e/billing-cron.test.ts -g "downgrades an expired"`

Expected: PASS — subscription is now downgraded to free with new period.

- [ ] **Step 6: Verify lint passes**

Run: `pnpm check lib/billing/cron.ts app/api/cron/billing-sweep/route.ts`

Expected: `Checked 2 files. No fixes applied.`

- [ ] **Step 7: Commit**

```bash
git add lib/billing/cron.ts app/api/cron/billing-sweep/route.ts tests/e2e/billing-cron.test.ts
git commit -m "feat(billing): downgrade expired paid subscriptions in cron sweep

Adds runSubscriptionDowngradeSweep to iterate expired paid subs
and downgrade each to free. Per-row try/catch prevents single
failures from aborting the sweep. Wired into cron endpoint."
```

---

## Task 5: Implement `runPendingCheckoutCleanup`

**Goal:** Add a second sweep task that hard-deletes expired pending checkouts, running in parallel with the downgrade sweep.

**Files:**
- Modify: `lib/billing/cron.ts`
- Modify: `app/api/cron/billing-sweep/route.ts`
- Test: `tests/e2e/billing-cron.test.ts`

- [ ] **Step 1: Write the failing E2E test**

Append to `tests/e2e/billing-cron.test.ts` (inside the `test.describe` block):

```ts
  test("hard-deletes expired pending checkouts", async ({ request }) => {
    const { db } = await import("../../lib/db/client");
    const { getPlanSnapshot } = await import("../../lib/billing/plans");
    const { billingCheckout, user } = await import("../../lib/db/schema");
    const { eq } = await import("drizzle-orm");

    const proSnapshot = getPlanSnapshot("pro", "monthly");

    const [seededUser] = await db
      .insert(user)
      .values({
        email: `cron-cleanup-${Date.now()}@e2e.test`,
        name: "Cron Cleanup E2E",
      })
      .returning();

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const merchantRef = `CRON-CLEANUP-${Date.now()}`;

    const [seededCheckout] = await db
      .insert(billingCheckout)
      .values({
        amountIdr: proSnapshot.priceIdr,
        expiresAt: yesterday,
        interval: "monthly",
        merchantRef,
        planSlug: "pro",
        planSnapshot: proSnapshot,
        status: "pending",
        userId: seededUser.id,
      })
      .returning();

    const response = await request.get("/api/cron/billing-sweep", {
      headers: {
        authorization: `Bearer ${process.env.CRON_SECRET}`,
      },
    });

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);

    const remaining = await db
      .select()
      .from(billingCheckout)
      .where(eq(billingCheckout.id, seededCheckout.id));

    expect(remaining).toHaveLength(0);
  });

  test("does not delete pending checkouts whose expiresAt is in the future", async ({
    request,
  }) => {
    const { db } = await import("../../lib/db/client");
    const { getPlanSnapshot } = await import("../../lib/billing/plans");
    const { billingCheckout, user } = await import("../../lib/db/schema");
    const { eq } = await import("drizzle-orm");

    const proSnapshot = getPlanSnapshot("pro", "monthly");

    const [seededUser] = await db
      .insert(user)
      .values({
        email: `cron-keep-${Date.now()}@e2e.test`,
        name: "Cron Keep E2E",
      })
      .returning();

    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const merchantRef = `CRON-KEEP-${Date.now()}`;

    const [seededCheckout] = await db
      .insert(billingCheckout)
      .values({
        amountIdr: proSnapshot.priceIdr,
        expiresAt: tomorrow,
        interval: "monthly",
        merchantRef,
        planSlug: "pro",
        planSnapshot: proSnapshot,
        status: "pending",
        userId: seededUser.id,
      })
      .returning();

    await request.get("/api/cron/billing-sweep", {
      headers: {
        authorization: `Bearer ${process.env.CRON_SECRET}`,
      },
    });

    const remaining = await db
      .select()
      .from(billingCheckout)
      .where(eq(billingCheckout.id, seededCheckout.id));

    expect(remaining).toHaveLength(1);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test tests/e2e/billing-cron.test.ts -g "pending checkout"`

Expected: First test FAILS — checkout is still in DB. Second test may PASS already (cron doesn't delete anything yet), but we include it as a regression guard.

- [ ] **Step 3: Add `runPendingCheckoutCleanup` to `lib/billing/cron.ts`**

Append to `lib/billing/cron.ts`:

```ts
import { deleteExpiredPendingCheckouts } from "@/lib/db/billing-queries";

export type CleanupSweepResult = {
  deleted: number;
};

export async function runPendingCheckoutCleanup(): Promise<CleanupSweepResult> {
  const deleted = await deleteExpiredPendingCheckouts();
  return { deleted };
}
```

**Note:** Merge the `deleteExpiredPendingCheckouts` import with the existing `@/lib/db/billing-queries` import at the top — do not duplicate the import statement. The final import block should look like:

```ts
import {
  deleteExpiredPendingCheckouts,
  findExpiredPaidSubscriptions,
  saveSubscription,
} from "@/lib/db/billing-queries";
```

- [ ] **Step 4: Wire into endpoint**

Update `app/api/cron/billing-sweep/route.ts` — replace the dispatch block:

```ts
import "server-only";

import {
  runPendingCheckoutCleanup,
  runSubscriptionDowngradeSweep,
} from "@/lib/billing/cron";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");

  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json(
      { error: "Unauthorized", ok: false },
      { status: 401 }
    );
  }

  const [downgrade, cleanup] = await Promise.allSettled([
    runSubscriptionDowngradeSweep(),
    runPendingCheckoutCleanup(),
  ]);

  console.log("[BillingSweep]", { cleanup, downgrade });

  return Response.json({ cleanup, downgrade, ok: true });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test tests/e2e/billing-cron.test.ts`

Expected: All tests PASS, including both new ones.

- [ ] **Step 6: Verify lint passes**

Run: `pnpm check lib/billing/cron.ts app/api/cron/billing-sweep/route.ts`

Expected: `Checked 2 files. No fixes applied.`

- [ ] **Step 7: Commit**

```bash
git add lib/billing/cron.ts app/api/cron/billing-sweep/route.ts tests/e2e/billing-cron.test.ts
git commit -m "feat(billing): hard-delete expired pending checkouts in cron sweep

Adds runPendingCheckoutCleanup running in parallel with the
downgrade sweep via Promise.allSettled. Both tasks isolated —
a failure in one does not block the other."
```

---

## Task 6: Register Cron Schedule in `vercel.json`

**Goal:** Tell Vercel to invoke the endpoint daily at 00:00 UTC (07:00 WIB).

**Files:**
- Modify: `vercel.json`

- [ ] **Step 1: Read the current `vercel.json`**

Run: `cat vercel.json`

Expected output:
```json
{
  "framework": "nextjs"
}
```

- [ ] **Step 2: Update `vercel.json` with cron config**

Replace the entire contents of `vercel.json` with:

```json
{
  "framework": "nextjs",
  "crons": [
    {
      "path": "/api/cron/billing-sweep",
      "schedule": "0 0 * * *"
    }
  ]
}
```

**Schedule explanation:** `0 0 * * *` = "at minute 0 of hour 0, every day" = 00:00 UTC daily = 07:00 WIB. Vercel enforces UTC for cron schedules.

- [ ] **Step 3: Validate JSON syntax**

Run: `node -e "JSON.parse(require('fs').readFileSync('vercel.json'))" && echo "valid"`

Expected output: `valid`

- [ ] **Step 4: Commit**

```bash
git add vercel.json
git commit -m "chore(billing): register daily cron for billing sweep

Schedule: 00:00 UTC daily (07:00 WIB). Hits
GET /api/cron/billing-sweep with Vercel's generated
Authorization: Bearer CRON_SECRET header."
```

---

## Task 7: Manual Verification on Local Dev

**Goal:** Confirm the endpoint works against the real local database before deploying.

**Files:** None modified — manual check only.

- [ ] **Step 1: Start dev server**

In terminal A, run: `pnpm dev`

Wait for `Ready` message at http://localhost:3000 (or whatever port your env uses).

- [ ] **Step 2: Hit the endpoint without auth**

In terminal B, run:

```bash
curl -i http://localhost:3000/api/cron/billing-sweep
```

Expected: HTTP 401 with body `{"error":"Unauthorized","ok":false}`.

- [ ] **Step 3: Hit the endpoint with valid auth**

Run:

```bash
curl -i -H "Authorization: Bearer $(grep CRON_SECRET .env.local | cut -d= -f2)" \
  http://localhost:3000/api/cron/billing-sweep
```

Expected: HTTP 200 with a JSON body shaped like:
```json
{
  "cleanup": { "status": "fulfilled", "value": { "deleted": 0 } },
  "downgrade": { "status": "fulfilled", "value": { "succeeded": 0, "failed": 0, "errors": [] } },
  "ok": true
}
```

- [ ] **Step 4: Check Vercel Logs format in dev console**

In terminal A (`pnpm dev`), look for a line like:
```
[BillingSweep] { cleanup: { ... }, downgrade: { ... } }
```

This confirms the log will appear in Vercel Logs post-deploy.

- [ ] **Step 5: Stop dev server**

In terminal A, press `Ctrl+C`.

---

## Task 8: Deployment Checklist (Pre-merge)

**Goal:** Ensure all prerequisites are met before merging and deploying to Vercel.

**Files:** None — this is a review gate.

- [ ] **Step 1: Confirm `CRON_SECRET` is set in Vercel project settings**

Go to https://vercel.com/<team>/<project>/settings/environment-variables and add:
- Name: `CRON_SECRET`
- Value: the same 64-char hex value from `.env.local` (or generate a new production-only one via `openssl rand -hex 32`)
- Environments: Production (at minimum); Preview and Development optional

- [ ] **Step 2: Run full lint suite**

Run: `pnpm check`

Expected: No errors in any of the files modified by this plan.

- [ ] **Step 3: Run full test suite**

Run: `pnpm test`

Expected: All tests pass (including existing ones). Check `billing-cron.test.ts` tests specifically.

- [ ] **Step 4: Verify the new plan matches the spec**

Open `docs/superpowers/specs/2026-04-23-billing-cron-design.md` and cross-check:
- [ ] Auth via `CRON_SECRET` ✓
- [ ] Daily schedule at 00:00 UTC ✓
- [ ] `findExpiredPaidSubscriptions` + `deleteExpiredPendingCheckouts` queries added ✓
- [ ] `runSubscriptionDowngradeSweep` + `runPendingCheckoutCleanup` business logic added ✓
- [ ] Per-task isolation via `Promise.allSettled` ✓
- [ ] Per-row isolation via try/catch in downgrade loop ✓
- [ ] E2E tests cover auth guard, downgrade, cleanup, and future-dated checkout preservation ✓

- [ ] **Step 5: Merge and deploy**

Push the branch, open a PR, merge after review. Vercel will pick up the cron schedule on next deploy.

- [ ] **Step 6: Post-deploy verification**

After first scheduled run (or via manual trigger from Vercel dashboard → Crons tab → "Run now"):
1. Open Vercel Logs, filter by `[BillingSweep]`
2. Confirm log appears with both `downgrade` and `cleanup` results
3. Verify no errors

---

## Notes & Future Considerations

- **Batching:** Phase 1 processes all expired subs in a single loop. Vercel Hobby function timeout is 60s; Pro is 300s. If `findExpiredPaidSubscriptions` returns thousands of rows, introduce pagination (e.g., process 100 at a time in a loop). Not needed for Phase 1.
- **Retries:** Vercel Cron does not retry failed invocations. Since both tasks are idempotent, next day's run handles any transient failures.
- **Observability upgrade path:** If volume grows, replace `console.log` with Sentry breadcrumbs or a dedicated metrics sink. For Phase 1, Vercel Logs is sufficient.
- **Email/notification coupling:** The downgrade sweep does **not** send a "your plan expired" email — this is deliberate (email is out of scope per spec Section 1). When email feature lands, add a hook in `runSubscriptionDowngradeSweep` after each successful downgrade to enqueue a notification.
