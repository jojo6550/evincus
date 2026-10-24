# Security and optimization checklist

Updated October 18, 2026. Checked items have local implementation and verification evidence. Unchecked items still require production, account, business, or measurement work; supporting code may already be implemented. Nothing has been deployed.

See the [implementation report](security-implementation-report.md) and [operations guide](security-operations.md). Assign an account owner and target date to remaining operational items.

## P1 — Security hardening

- [x] **Streaming body limits:** unknown-length, declared-length, and multibyte limits pass HTTP/parser tests; oversized streams are cancelled before full buffering.
- [ ] **Trusted proxy verification:** Render-specific address validation and direct-connection spoof tests pass. Test forged forwarding headers through actual Render ingress before closing. The adapter follows [Render's documented first-entry behavior](https://feedback.render.com/features/p/send-the-correct-x-forwarded-for).
- [x] **Abuse limits:** quote, admin, and newsletter-link limits run before expensive work; tests cover rejection, recovery, contention, and fail-closed behavior.
- [x] **Network deadlines:** explicit HTTP, browser API, site-copy, Resend, and keepalive deadlines; truncated successful responses remain uncertain and retain the checkout retry token.
- [ ] **Unprivileged container:** `USER node` and writable directories are configured, with CI checks. Docker is unavailable locally; verify image execution and actual Render mount ownership.
- [ ] **Browser security policy rollout:** shared headers and enforced local checkout pass. Inspect live proxy headers/violations in report-only mode, then enforce CSP in production. See [OWASP header guidance](https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html).

## P1 — Release verification

### Configuration and access

- [ ] **Production mode:** no payment integration exists; local preview behavior is verified. Inspect actual Render settings and post-deploy endpoints.
- [ ] **Production secrets:** guards reject missing, short, example, or duplicate signing/admin secrets. Actual creation, rotation, revocation, and provider verification require account access.
- [ ] **Private files/history:** local pattern-based scans pass across working files and 88 commits. Built-image exclusions and provider secret scanning still need CI/account evidence; patterns cannot detect every secret format.
- [x] **Admin access:** tests verify wrong/missing tokens, unavailable unconfigured routes, `no-store`, and stale-version conflicts. Tokens remain server/operator-side.
- [x] **CORS and authorization:** production origin checks pass; authentication and limits operate independently of CORS.
- [ ] **HTTPS and account access:** verify redirects, renewal, least-privilege access, and MFA for Render, GitHub, Resend, and the registrar.

### Orders, content, and customer data

- [x] **Authoritative pricing:** tests cover prices, discounts, variants, quantities, availability, sale boundaries, and tampered totals.
- [x] **Order idempotency:** concurrent submissions, payload conflicts, atomic failures, and persisted replay after restart pass; five duplicate submissions create one order.
- [x] **Input validation:** customer/notes limits, pickup choices, carts, malformed JSON, and unsupported methods pass.
- [x] **HTML/URL handling:** markup is escaped in receipts and summaries; labels are escaped, status uses `textContent`, and responsive-image URLs reject unsafe schemes.
- [x] **Static boundaries:** encoded/double-encoded traversal and private-file tests pass. File access also rejects symlinks and paths outside the public root.
- [ ] **Unreleased material:** published era modules and all photo variants remain public. Owners must review unpublished content before each push; never deploy secret drops early.
- [x] **Log privacy:** nested customer data, credential fields, bearer strings, link tokens, and email-like strings are redacted; beacon fields are restricted and tested.
- [ ] **Retention approval:** two-year order retention is preserved. Procedures cover submission/index/retry/summary copies and restored deletions; approve provider/mailbox/backup handling with the owner.
- [x] **Pending checkout:** browser success clears the pending submission and ordered quantities; uncertain/truncated responses preserve the original token, and restart replay recovers the original order.

### Email and recovery

- [x] **Newsletter consent:** double opt-in, forged links, one-click unsubscribe, concurrent signup generations, resubscription invalidation, and retry consent checks pass.
- [ ] **Real email delivery:** simulated failures and durable retries pass; test-email guards are implemented. Actual Resend/inbox behavior needs provider access and a controlled recipient.
- [ ] **Production backup drill:** synthetic SQLite restoration validates orders, submissions, subscribers, sales, retries, cursors, and chunked values. Supply and time a recent production snapshot restore.
- [ ] **Production disk:** local persistence/restart passes; disk reserve and overdue-cron health signals exist. Verify the actual mount, snapshot schedule, capacity alerts, and single instance.
- [ ] **Release and rollback:** all 230 tests pass; CI gates and tested-commit deployment checks are configured. Publish/run CI and rehearse a compatible rollback; format-2 newsletter jobs have documented precautions.
- [ ] **External monitors:** health signals and five-minute GET monitor instructions are ready. Create/verify monitors, notification delivery, repeated-5xx alerts, and overdue-summary alerts in the provider.
- [ ] **Fulfillment:** pickup street addresses are still **unconfirmed by the owner**. Existing values are preserved; confirm before launch. Receipts state that payment was not collected.

## P2 — Performance and reliability

### Baseline, images, and interaction

- [ ] **Mobile baseline:** desktop browsing/gallery/bag/pickup checkout and eras passed. Mobile slow-network timing, resource counts, and interaction measurements remain outstanding.
- [ ] **Field Web Vitals:** gather mobile and desktop 75th-percentile data for LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1. Asset/API savings do not prove field targets. See [Google's guidance](https://web.dev/articles/vitals).
- [x] **Responsive photos:** 203 versioned WebP variants from 70 originals, each ≤ 250 KiB; smallest variants total 84% fewer bytes. Originals are preserved.
- [x] **Image geometry/priority:** intrinsic dimensions or aspect-ratio containers reserve space; hero is eager/high-priority, offscreen content lazy, gallery sources update together.
- [x] **Local font:** Latin WOFF2 reduces the display font from 922,676 to 28,848 bytes, with swap fallback and preload. Browser rendering passes; mobile timing remains part of the baseline.
- [ ] **Interaction profiling:** reel visibility/reduced-motion behavior is preserved. Profile filtering, gallery, and bag updates on a representative device for long tasks and layout costs.

### Requests and caching

- [x] **Startup concurrency:** site copy and catalog load concurrently; three released-era details still load in parallel for the current nine-product catalog.
- [x] **Compression:** real HTTP tests verify gzip/Brotli bodies and encoding variation for GET, HEAD, and 304 responses.
- [x] **Conditional static responses:** ETag, Last-Modified, 304, HEAD without content reads, and a bounded 16 MiB metadata-invalidated cache pass tests.
- [x] **Asset lifetimes:** versioned photos get immutable caching; HTML/config revalidate, existing unversioned assets retain short caching, private responses remain `no-store`.
- [x] **Price freshness:** quotes/orders remain authoritative; no price/sales cache was added, and sale/drop boundary tests pass.

### Server and storage

- [x] **Isolated load:** 110 requests at concurrency 10, zero failures, 76 ms p95, about 76 MB RSS; five duplicate submissions return one order. See [local results](security-evidence/load-report.json), which are not production capacity claims.
- [x] **Newsletter growth:** at most 100 recipients per independent record, persisted preparation cursor, and bounded sends; a 1,200-recipient regression check verifies resumption and unique deliveries.
- [x] **Bounded background work:** provider deadlines and a 45-second cron budget checked between work units; durable retry/digest state and per-batch progress remain available to later runs.
- [x] **Graceful shutdown:** stop traffic/timers, drain tracked work within a 20-second deadline, close KV, and preserve retries; real order/restart/replay test passes.

## P3 — Recurring operations

- [ ] **Dependency/image reviews:** current npm audit has zero known vulnerabilities. Monthly Dependabot and scheduled scans are configured; publish them, review notifications, and run the Docker scanner in CI.
- [ ] **Release access:** Actions are commit-pinned with minimal permissions. Confirm branch protections, required checks/reviewers, and secret-change controls in GitHub.
- [ ] **Release performance review:** static/image/load budgets are configured. Repeat mobile baselines and compare actual measurements at every release.
- [ ] **Quarterly recovery/access:** procedures are documented; assign an owner and perform real restore, compatible rollback, access, and rotation reviews after storage changes and quarterly.
- [x] **Incident procedure:** the operating guide defines containment, request-ID evidence, safe recovery, verification, and a dated regression follow-up; apply it when incidents occur.

Request handling follows [OWASP Node.js guidance](https://cheatsheetseries.owasp.org/cheatsheets/Nodejs_Security_Cheat_Sheet.html). Production completion requires evidence from the actual services.
