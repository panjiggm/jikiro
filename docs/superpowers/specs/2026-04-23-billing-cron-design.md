# Billing Cron Jobs — Daily Sweep

**Status:** Approved
**Date:** 2026-04-23
**Owner:** Engineering

## 1. Goals

Implement scheduled background maintenance for billing, focused on two concerns:

1. **Auto-downgrade real-time** — Ensure the `Subscription` table in the database reflects real state: paid plans whose `currentPeriodEnd` has passed are downgraded to `free` even if the user has not returned to the app. This keeps analytics, admin dashboards, and reporting accurate.
2. **Pending checkout cleanup** — Hard-delete `BillingCheckout` rows whose `status = 'pending'` and whose `expiresAt` has passed, to keep the table clean.

Out of scope for this phase:
- Email notifications (expiry reminders, expired notices)
- Soft recurring billing (auto-generating renewal checkouts)
- Credit reconciliation cron — credits are already handled idempotently by `ensureCreditsForCurrentCycle` via `grantExternalId`; downgrade cron implicitly resets credits as a side effect.
- Hard-delete of `failed` or `expired` checkouts — retained for audit / fraud detection purposes.

## 2. Non-Goals

- Near real-time downgrade (hourly / 15-minute frequency). Daily cron is sufficient because `resolveBillingState` already performs a lazy downgrade check on every chat/API request, so no user ever actually *uses* Pro entitlements after expiry. The cron exists purely for DB/reporting correctness.
- Complex retry logic. Jobs are idempotent — next day's run handles any transient failures.
- Multi-cron architecture. A single sweep endpoint covers both tasks within Vercel Hobby plan's 2-cron limit.

## 3. Architecture

```
┌──────────────────┐     ┌─────────────────────────────┐     ┌───────────────┐
│ Vercel Cron      │────▶│ GET /api/cron/billing-sweep │────▶│ PostgreSQL    │
│ (daily 00:00 UTC │     │                              │     │ (Neon)        │
│  = 07:00 WIB)    │     │ 1. Downgrade expired subs    │     └───────────────┘
└──────────────────┘     │ 2. Delete expired pending    │
                         │    checkouts                 │
                         │                              │
                         │ Auth: Bearer CRON_SECRET     │
                         └─────────────────────────────┘
```

### Design Principles

- **Single cron, single endpoint** — simple, hobby-friendly, easy to reason about. Split later if Phase 2 needs it.
- **Idempotent** — safe to run multiple times. Each row's downgrade checks current state before acting.
- **Per-task isolation** — use `Promise.allSettled` so one failing task doesn't block the other.
- **Per-row isolation** — wrap each subscription/checkout in its own try/catch so one bad row doesn't abort the sweep.
- **Observability via Vercel Logs** — log a summary at end: `{ succeeded, failed, errors }` for each task. No external monitoring needed for Phase 1.
- **Reuse existing patterns** — downgrade logic mirrors what `ensureRegularSubscription` already does for the lazy case.

## 4. File Structure

### New Files

```
app/api/cron/billing-sweep/route.ts   # HTTP entrypoint — auth + dispatch
lib/billing/cron.ts                    # Pure business logic
vercel.json                            # Cron schedule config (already exists, extend it)
```

### Modified Files

```
lib/db/billing-queries.ts              # + findExpiredPaidSubscriptions()
                                       # + deleteExpiredPendingCheckouts()
.env.example                           # + CRON_SECRET placeholder
```

## 5. Endpoint Design

### Route: `GET /api/cron/billing-sweep`

**Authentication:** Verify `Authorization: Bearer <CRON_SECRET>` header. Vercel Cron automatically includes this header for scheduled invocations.

**Response shape:**
```ts
{
  ok: boolean;
  downgrade: PromiseSettledResult<{ succeeded: number; failed: number; errors: Array<{ id: string; message: string }> }>;
  cleanup:   PromiseSettledResult<{ deleted: number }>;
}
```

**Skeleton:**
```ts
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const [downgrade, cleanup] = await Promise.allSettled([
    runSubscriptionDowngradeSweep(),
    runPendingCheckoutCleanup(),
  ]);

  console.log("[BillingSweep]", { downgrade, cleanup });

  return Response.json({ ok: true, downgrade, cleanup });
}
```

## 6. Business Logic — `lib/billing/cron.ts`

### `runSubscriptionDowngradeSweep()`

**Query:** Return subscriptions where:
- `planSlug != 'free'`
- `status = 'active'`
- `currentPeriodEnd <= now`

**For each:** Update in place with `saveSubscription`:
- `planSlug = 'free'`
- `planSnapshot = getPlanSnapshot('free', 'monthly')`
- `interval = 'monthly'`
- `currentPeriodStart = now`
- `currentPeriodEnd = addMonths(now, 1)`
- `lastCheckoutId = existing.lastCheckoutId` (preserve reference to last paid checkout)

Wrap per-row in try/catch so one failure doesn't stop the loop.

### `runPendingCheckoutCleanup()`

**Query:** Hard-delete `BillingCheckout` rows where:
- `status = 'pending'`
- `expiresAt IS NOT NULL`
- `expiresAt <= now`

Single `DELETE` statement, return `{ deleted: <count> }`.

## 7. Database Queries — `lib/db/billing-queries.ts`

### `findExpiredPaidSubscriptions()`
```ts
export async function findExpiredPaidSubscriptions(): Promise<Subscription[]> {
  const now = new Date();
  return db
    .select()
    .from(subscription)
    .where(
      and(
        ne(subscription.planSlug, "free"),
        eq(subscription.status, "active"),
        lte(subscription.currentPeriodEnd, now),
      )
    );
}
```

### `deleteExpiredPendingCheckouts()`
```ts
export async function deleteExpiredPendingCheckouts(): Promise<number> {
  const now = new Date();
  const result = await db
    .delete(billingCheckout)
    .where(
      and(
        eq(billingCheckout.status, "pending"),
        lte(billingCheckout.expiresAt, now),
      )
    )
    .returning({ id: billingCheckout.id });
  return result.length;
}
```

## 8. Vercel Configuration

### `vercel.json`

Extend the existing file:
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

Schedule `0 0 * * *` = daily at 00:00 UTC = 07:00 WIB. Low-traffic window for Indonesian users.

### Environment Variables

Add to `.env.example` and Vercel project settings:
```
CRON_SECRET=<generate via: openssl rand -hex 32>
```

## 9. Edge Cases

| Case | Handling |
|---|---|
| User already lazy-downgraded before cron runs | Query filter `planSlug != 'free'` excludes them |
| Subscription status is `cancelled` or `past_due` | Query filter `status = 'active'` — skipped; cron only touches actives |
| Pending checkout was just paid between fetch & delete | `status = 'pending'` in WHERE clause protects against accidental deletion |
| `expiresAt` is NULL on a pending checkout | Skipped (IS NOT NULL implicit in `lte` predicate) |
| Cron runs twice in a day (manual trigger + scheduled) | Idempotent — second run has empty result set |
| Single row fails mid-sweep | Per-row try/catch logs error, sweep continues |
| Entire downgrade task fails | `Promise.allSettled` ensures cleanup still runs |

## 10. Observability

- **Success path:** `console.log` summary object visible in Vercel Logs.
- **Failure path:** Errors are caught, logged with context (subscription ID, error message).
- **Manual trigger:** Operators can curl the endpoint with `CRON_SECRET` to trigger on-demand.
- No external monitoring (Sentry, Datadog) for Phase 1 — Vercel Logs sufficient.

## 11. Testing

### Unit Tests (required)
- `runSubscriptionDowngradeSweep` — mock queries, verify downgrade payload and idempotency
- `runPendingCheckoutCleanup` — mock delete, verify return shape
- Auth guard — endpoint returns 401 without correct `CRON_SECRET`

### E2E Tests (optional — Phase 2)
- Seed expired paid subscription → curl endpoint → verify subscription downgraded to free
- Seed expired pending checkout → curl endpoint → verify row deleted

### Manual Verification
- After deploy, trigger cron manually from Vercel dashboard → confirm logs show sweep executed.
- Verify `Subscription` and `BillingCheckout` tables in Drizzle Studio before/after.

## 12. Future Considerations (Out of Scope)

Once email is implemented (Phase 2), split this cron or add a second cron for:
- H-7 renewal reminder
- H-1 renewal reminder
- "Your plan expired" notice after downgrade
- Auto-generate renewal `BillingCheckout` 3 days before expiry

Hard-delete of `failed`/`expired` checkouts older than 90 days can become a weekly cron at that point.
