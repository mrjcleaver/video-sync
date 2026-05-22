# Zoom OAuth Scopes for Video Bridge

**Related ADRs:** [ADR-007](adr/ADR-007-oauth2-token-management.md), [ADR-010](adr/ADR-010-authentication-configuration.md)

## Auth Model

Video Bridge uses a **Server-to-Server OAuth** app created in the [Zoom Marketplace](https://marketplace.zoom.us/). This is an internal (account-level) app — no user consent screen is involved. The admin provides `account_id`, `client_id`, and `client_secret`, and the backend exchanges them directly for an access token.

Access tokens expire after **1 hour** and are refreshed proactively by the `TokenManager` (ADR-007).

## Required Granular Scopes

Zoom has migrated from classic scopes (e.g., `recording:read`) to **granular scopes**. The following scopes must be enabled on the Server-to-Server OAuth app in the Zoom Marketplace.

### Cloud Recording Scopes

These are required for the Zoom Source Adapter to discover and download recordings.

| Scope | Purpose | Why Needed |
|-------|---------|------------|
| `cloud_recording:read:list_user_recordings:admin` | List all users' recordings | Polling fallback: `GET /v2/users/{userId}/recordings` to discover new recordings across the account |
| `cloud_recording:read:list_recording_files:admin` | Get a meeting's recording files | Retrieve recording file URLs for download during publish operations |
| `cloud_recording:read:meeting_transcript:admin` | Get a meeting transcript | Fetch transcript text to populate the `transcript_text` field in the catalog |

### Meeting Scopes

These are required to enrich video metadata with meeting details and participant information.

| Scope | Purpose | Why Needed |
|-------|---------|------------|
| `meeting:read:meeting:admin` | Get a meeting's details | Fetch meeting title, duration, and settings for catalog metadata |
| `meeting:read:list_past_participants:admin` | Get past meeting participants | Populate the `participants` field on `VideoDiscovered` events |
| `meeting:read:summary:admin` | Get a meeting summary | Fetch AI Companion summary to populate the `description` field (if available) |

### User Scopes

Required for the connection health check.

| Scope | Purpose | Why Needed |
|-------|---------|------------|
| `user:read:user:admin` | Get a user | Health check endpoint: `GET /v2/users/me` to verify credentials are valid |

## Optional Scopes

These are not required for core functionality but enable additional features.

| Scope | Purpose | Feature |
|-------|---------|---------|
| `cloud_recording:read:recording_settings:admin` | Get recording settings | Display recording configuration in the video detail view |
| `meeting:read:list_meetings:admin` | List meetings | Future: schedule-aware ingestion to correlate recordings with calendar entries |

## Webhook Events

Zoom webhooks do **not** require OAuth scopes — they are configured separately on the app in the Zoom Marketplace under **Feature > Event Subscriptions**. Video Bridge subscribes to:

| Event | Purpose |
|-------|---------|
| `recording.completed` | Real-time notification when a new cloud recording is available (primary ingestion trigger) |
| `recording.trashed` | Detect when a recording is deleted on Zoom so the catalog can flag it |

The webhook endpoint must be accessible at `/webhooks/zoom` and the **Secret Token** must be stored as `webhook_secret` on the `SourceConnection` aggregate for signature verification.

## Setup Steps

1. Go to the [Zoom App Marketplace](https://marketplace.zoom.us/) > **Develop** > **Build App**
2. Choose **Server-to-Server OAuth**
3. Fill in the app name (e.g., "Video Bridge")
4. Under **Scopes**, add all scopes listed in the "Required Granular Scopes" tables above
5. Under **Feature** > **Event Subscriptions**, enable and add the webhook events listed above
6. Copy the `Account ID`, `Client ID`, and `Client Secret`
7. In Video Bridge **Connections > Zoom**, paste those three values and either **Override locally** (browser only) or, for Admins, **Save as shared default** (Google Secret Manager — ADR-042). To verify the credentials work, open the **Meetings** import tab, set a date range that overlaps a known recording, and click **Fetch from Zoom**.

## Scope Naming Convention

Zoom granular scopes follow the pattern:

```
{resource}:{action}:{object}[:{level}]
```

- **resource**: `cloud_recording`, `meeting`, `user`
- **action**: `read`, `write`, `update`, `delete`
- **object**: specific sub-resource (e.g., `list_user_recordings`, `meeting_transcript`)
- **level** (optional): `admin` (account-wide) or `master` (multi-account). Video Bridge requires `:admin` level since the Server-to-Server app operates at the account level.

## Legacy Scope Mapping

ADR-010 references the classic scopes `recording:read` and `meeting:read`. These map to the granular scopes as follows:

| Classic Scope | Granular Equivalents |
|---------------|---------------------|
| `recording:read` | `cloud_recording:read:list_user_recordings:admin`, `cloud_recording:read:list_recording_files:admin`, `cloud_recording:read:meeting_transcript:admin` |
| `meeting:read` | `meeting:read:meeting:admin`, `meeting:read:list_past_participants:admin`, `meeting:read:summary:admin` |

## Troubleshooting

**Error 4711: "Invalid access token, does not contain scopes"**
This means the token was generated before the scope was added. Re-generate the token: deactivate and reactivate the app in the Zoom Marketplace, or wait for the current token to expire (1 hour).

**Scopes not appearing in the Marketplace UI**
Some granular scopes only appear after selecting the correct scope category in the left panel. Look under **Recording** (not **Meeting**) for `cloud_recording:*` scopes.

**Health check passes but recordings return 403**
The `user:read:user:admin` scope used for health checks is separate from recording scopes. Ensure the `cloud_recording:read:*` scopes are also enabled.
