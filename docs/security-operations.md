# Security operations and release verification

Updated October 18, 2026. These procedures accompany the [checklist](security-and-optimization-checklist.md). Account-level changes and production recovery require access to the relevant service. Nothing in this change has been deployed, and no production credentials, customer records, or account permissions have been changed.

## Before the next release

1. Confirm both pickup street addresses. These remain **unconfirmed by the owner**. Do not mark fulfillment ready until they are set in `data/fulfillment.js`.
2. Check Render production has `ENVIRONMENT=production`, the paid persistent disk at `/var/data`, and a single instance. The app now refuses production startup unless its two signing/admin secrets are distinct and at least 32 characters long. Verify existing values privately before deployment; never paste them into a PR, chat, or log.
3. Run the checks below. CI also builds the image, checks the non-root user and excluded private files, and scans fixed HIGH/CRITICAL container vulnerabilities with a commit-pinned scanner. Docker is unavailable on this workstation, so those container checks must pass in CI before release. Unfixed image advisories still need review even when the automated fixed-vulnerability gate passes.
4. Deploy through the existing tested-commit workflow. Keep CSP in report-only mode on production initially. Check every public page, gallery, cart, pickup checkout, fonts, and error page for violations, then set `CSP_MODE=enforce` and repeat. Local browser checkout was tested with enforcement enabled; production enforcement remains a rollout step.
5. Verify HTTPS redirect, renewal status, all security headers, health commit, and permissions on the actual mounted disk. A directory owned by `node` in the image does not prove the existing mounted disk has the correct ownership. Correct the mount's ownership for the existing Node account through Render before switching traffic if necessary.

```sh
npm ci
npm test
npm run check:security
npm audit --audit-level=high
npm run check:performance
npm run check:load
npm run check:restore
```

The load and restore checks own temporary databases, disable email, and clean up their own files. They never use `.env` or the live KV file. Run the load/HTTP checks with loopback-network access. The secret check examines tracked and unignored working files and fetched Git history for private filenames and high-confidence credential patterns, printing locations rather than credentials. It is not a guarantee that every possible secret format is absent. Enable provider secret scanning as an additional account-level control.

## Credentials and account access

Use Render secret settings and GitHub Actions secrets. Keep a record of the owner, purpose, creation date, and next review date without recording the secret values. Use separate credentials for production and development. The staging service is now configured for the same unpaid-order flow and blocks outbound email by default.

For rotation, first prepare the new secret privately in the service's secret manager. Update `ADMIN_TOKEN` on the server and the authorized operator's local environment together; old admin tokens should return 401. Rotating `NEWSLETTER_KEY` invalidates existing newsletter links, including saved pending issues; let active jobs finish first or explicitly retire them and arrange new confirmation links. Review Resend and deploy-hook credentials in their respective providers, update their secret-store references, verify with a test recipient/deploy, then revoke the old credentials. Review access to Render, GitHub, Resend, and the registrar quarterly; enforce MFA and remove accounts that no longer need access. Do not change another person's account access without the appropriate owner approval.

Newsletter batches check current consent before every attempt. If membership changes after a possibly accepted attempt, that batch is retired with a `consent-changed` marker rather than sending altered content under the old idempotency key. Other active recipients in that batch can miss that issue; future issues still include them. This avoids both mailing an unsubscribed recipient and changing an ambiguous provider request. Old links are invalid after unsubscribe and resubscription. Confirm real-provider behavior with a test inbox before release, including the provider's idempotency retention window.

## Storage, retention, deletion, and recovery

The existing two-year order retention remains unchanged. It covers `order:`, its `submission:` copy, day indexes, and retained daily-summary jobs/markers. Newsletter pending signups expire after seven days; active subscriptions persist until unsubscribe. Newsletter job bodies and recipient batches expire after seven days. The owner still needs to approve the retention policy and confirm how provider backups and delivered mailbox copies are handled.

For an approved deletion request, locate the person's order IDs privately and remove or redact each corresponding order, submission copy, day index, retry job, and pending summary body that contains their information. Review active subscriptions and saved newsletter batches too. Record a minimal deletion ledger outside restored customer data so a backup restore can reapply approved deletions before any application or email worker starts. Do not erase unrelated orders from a shared summary. Provider backups and already-delivered emails require their own retention procedures; deleting a live KV key does not delete those copies.

Render's disk snapshots are a separate recovery mechanism from an application deploy rollback. Verify their actual schedule and availability in the account; a platform description is not evidence that a particular backup is usable. A file copy of an active SQLite database without its WAL is not a valid backup. Use a provider-consistent snapshot or a checkpointed copy made after stopping the app.

To inspect a downloaded, checkpointed snapshot safely:

```sh
node scripts/restore-check.mjs /path/to/checkpointed-snapshot.sqlite3
```

This opens disposable copies only, validates that all logical values, including chunked records, are readable, compares their fingerprints, and prints counts without customer values. It never imports the app scheduler or email code. It refuses a source with a nonempty sibling WAL. The synthetic-fixture run proves the tool works; **a recent production snapshot has not been supplied or restored**.

During a real recovery drill: isolate the service and recipients; set `EMAIL_DISABLED=true`; keep the newsletter off; restore the snapshot; reapply deletions; verify orders, submissions, subscribers, sales, retry jobs, and digest cursors; inspect pending sends for age and provider idempotency-window limits; then run a controlled test order and recovery test. Start exactly one scheduler. Enable real email only after explicit recipient/job review. Target **at most 24 hours of data loss and recovery within 60 minutes** as provisional operating objectives; confirm them against actual backup coverage and a timed drill before treating them as commitments.

For a code rollback, redeploy a previously tested commit with the current disk still mounted. Do not replace or delete the disk. Newsletter storage format 2 is not understood by older code: drain pending format-2 issues before rolling back to a version without support, or keep their workers disabled and forward-fix. Verify the health commit and replay a known checkout token to confirm the rollback did not create an order twice.

## Monitoring and incident response

Configure independent five-minute GET monitors for the public homepage and `/api/health`, with the health response required to contain `"ok":true`. HEAD is not supported on the health route. Test the monitor's notification channel in the monitoring service. Monitor recurring 5xx responses in Render, pending email failures, and missed daily summaries. The app now marks health unhealthy when free disk falls below its reserve or its scheduler has not completed for two cron intervals. Reserve is 15% of the filesystem, bounded between 20 and 256 MiB. Check capacity alerts and scheduler recovery after the deployment; app health cannot notify anyone while the app itself is down.

On an incident, record the UTC time, affected flow, request IDs, current commit, and customer impact without copying customer bodies or tokens. Contain the cause; use a tested rollback if compatible with pending jobs; recover data with email disabled if needed; verify the same checkout token can recover the original order. Afterwards, record the cause, actions, evidence of recovery, and one regression check with an owner and due date. Account notifications and any customer communications require the owner's authorized recipients and wording.

## Performance and recurring checks

`npm run optimize:images` generates responsive WebP files and the manifest from the original photos and updates static HTML. Run it after adding photos. Existing generated files are immutable: change the transformation-version string in the generator when changing encoding rules after release. Preserve originals for detailed views and future regeneration. The local display font is a Latin subset in WOFF2 with a swap fallback; reproduce it with FontTools plus Brotli using the original TTF and the existing CSS Unicode range. The original licensed font remains in place.

The image check enforces a 250 KiB limit per generated photo, plus gzip budgets of 40,000 bytes for the manifest, 20,000 for the main CSS, and 12,000 for the homepage. The isolated load check uses 10 concurrent clients, 110 browsing/quote requests, and five simultaneous submissions of one checkout token; its p95 budget is 1,500 ms with no failed requests and one unique order. These are regression budgets for local/CI runs, not production capacity promises.

Before each release, record a mobile slow-network lab baseline for homepage, eras, product view, filtering, bag changes, and checkout. Profile long tasks and rendering costs. After deployment, gather field measurements separately for mobile and desktop and assess the 75th percentile against LCP ≤ 2.5 s, INP ≤ 200 ms, and CLS ≤ 0.1. Browser automation here verified the desktop flow and errors, but did not provide mobile throttling or field Web Vitals. Do not report those targets as achieved based on asset savings or the local API load test.

Dependabot is configured for monthly npm, Docker, and Actions updates. A monthly GitHub workflow audits dependencies and scans the production image. The existing release workflow repeats tests, history checks, performance budgets, load, restore, image checks, and deployment smoke checks. These take effect after publication to GitHub; branch protection, security notifications, required reviewers, and external monitors still need account configuration. Quarterly, the service owner should repeat the production restore drill, compatible rollback, account review, and rotation review, recording dated evidence in this directory.
