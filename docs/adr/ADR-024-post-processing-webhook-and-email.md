# ADR-024: Post-processing Rules — Webhook and Email Notification

Date: 2026-03-07
Status: Accepted

## Context

After a video is uploaded to YouTube the operator currently has no way to be notified unless they are watching the dashboard. For automated pipelines — CI integrations, Slack bots, monitoring dashboards, or personal notifications — a fire-and-forget hook after publish success or failure is essential.

The processing rules engine (ADR-014) handles pre-upload transforms. A parallel system is needed for post-upload side effects that must not block or endanger the upload itself.

## Decision

Introduce a **post-processing rules** system separate from the existing `ProcessingRule` type:

### Data model

```typescript
type PostProcessingTrigger = "success" | "failure" | "always";

interface WebhookAction { type: "webhook"; url: string }
interface EmailAction   { type: "email"; to: string; subject_template?: string }
type PostProcessingAction = WebhookAction | EmailAction;

interface PostProcessingRule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: PostProcessingTrigger;
  action: PostProcessingAction;
}
```

Rules are stored in `localStorage` under `video-sync:post-processing-rules` and managed via the `PostProcessingRulesPanel` UI component.

### Execution

`firePostProcessingRules(rules, success, video, youtubeUrl?, error?)` is called in `VideoCard.publishToYouTube()` immediately after the upload result is known — both on success and in the catch block for failures. It:

1. Filters to enabled rules whose `trigger` matches the outcome.
2. For each matching rule, fires a `fetch("/api/process/notify", …)` with no `await` — fully fire-and-forget. Network errors are silently swallowed. Upload success/failure is never affected.

### `/api/process/notify` server route

Always returns HTTP 200. Logs all outcomes (success and failure) via `serverLog`.

**Webhook action**: POSTs the following JSON to the configured URL:

```json
{
  "event": "publish_success" | "publish_failure",
  "video": {
    "id": "<catalog UUID>",
    "title": "...",
    "source_platform": "Zoom" | "Fireflies",
    "source_id": "...",
    "recorded_at": "...",
    "description": "...",
    "transcript_text": "..."
  },
  "youtubeUrl": "https://www.youtube.com/watch?v=...",
  "error": null,
  "timestamp": "2026-03-07T17:00:00Z"
}
```

`description` and `transcript_text` are `null` when not available. Webhook consumers can use the transcript to drive downstream summarisation, search indexing, or CMS ingestion without re-querying the source APIs.

**Email action**: Sends via Gmail SMTP using nodemailer with `service: "gmail"` and an app password. The body contains video title, status, YouTube URL (if published), error message (if failed), source platform/ID, catalog ID, the full description (if present), and a 500-character transcript excerpt (if a transcript has been loaded).

Subject supports `{{title}}` and `{{status}}` template variables. Example default: `Video Published: My Session Title`.

Gmail credentials are provided via environment variables — not stored in the client or rules:

| Variable | Purpose |
|---|---|
| `GMAIL_FROM` | Sender address (Gmail account) |
| `GMAIL_APP_PASSWORD` | Gmail App Password (not the account password) |

App Passwords are generated at https://myaccount.google.com/apppasswords with 2FA enabled.

## Consequences

- **Non-blocking**: a webhook timeout or email failure never delays or fails the YouTube upload.
- **Observable**: every webhook fire and email send (success or error) is recorded in server logs via `serverLog`, visible in `data/server.log`.
- **Extensible**: additional action types (Slack, Discord, SMS) can be added by extending `PostProcessingAction` and adding a handler branch in the notify route without changing the calling code.
- **Gmail only**: the email action is hardcoded to Gmail SMTP. Teams using other mail providers would need to extend the route. This is acceptable for the current use case.
- **No retry**: fire-and-forget with no retry. If the webhook URL is temporarily unreachable, the notification is lost. This is intentional — post-processing notifications are best-effort signals, not guaranteed delivery.
- **No criteria matching**: post-processing rules currently fire for all videos that match the trigger; there is no per-rule criteria filter (unlike pre-processing rules). This keeps the model simple; criteria can be added if needed.
