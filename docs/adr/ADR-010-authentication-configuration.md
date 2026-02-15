# ADR-010: Authentication Configuration for External Services

| Field | Value |
|-------|-------|
| **Status** | Proposed |
| **Date** | 2026-02-15 |
| **Deciders** | Architecture Team |
| **Project** | VID-BRIDGE-01 |
| **Supersedes** | — |
| **Related** | ADR-005 (Source Integration), ADR-007 (OAuth Token Management), ADR-008 (DDD Bounded Contexts) |

## Context

Video Bridge integrates with five external platforms. Each platform has its own authentication model, developer portal, and credential lifecycle. ADR-007 decided *how* credentials are stored and refreshed at runtime. This ADR addresses the **operational** question: how does an administrator configure and maintain these credentials in the first place?

The platforms and their auth requirements are:

| Platform | Role | Auth Model | Developer Setup | Scopes / Permissions |
|----------|------|-----------|----------------|---------------------|
| **Zoom** | Source | OAuth 2.0 Server-to-Server app | Zoom Marketplace → Build → Server-to-Server OAuth | `recording:read`, `meeting:read` |
| **Loom** | Source + Intermediate | API Key *or* OAuth 2.0 | Loom Developer Portal → API Credentials | Workspace-level read access |
| **Fireflies.ai** | Source | API Key | Fireflies Settings → Integrations → API Key | Read transcripts |
| **YouTube** | Destination | OAuth 2.0 (User consent, Authorization Code) | Google Cloud Console → YouTube Data API v3 | `youtube.upload`, `youtube.readonly` |
| **Kaltura** | Destination | KS (Kaltura Session) Token | Kaltura Management Console → Integration Settings | Admin-level KS or scoped App Token |

A video may originate in Zoom, pass through Loom for editing, and then be published to both YouTube and Kaltura. The system must hold valid credentials for each platform a tenant uses, and those credentials must be independently configurable, testable, and revocable.

### Problems with the Current Model

1. **Single destination tracking.** The `VideoRecord` aggregate currently stores one `destination_id` and one `destination_url`. A video published to both YouTube and Kaltura cannot be fully represented.
2. **No location registry.** There is no way to answer "where does this video exist?" across all platforms.
3. **No connection health visibility.** Admins cannot see which platform connections are healthy, expiring, or broken without inspecting the database.

## Decision

### 1. Connection Configuration UI

The admin settings page will expose a **Connections** panel listing all five platforms. Each connection card shows:

- Platform name and logo
- Connection status: `Connected`, `Expiring`, `Disconnected`, `Error`
- Last successful API call timestamp
- A **Connect** / **Reconnect** / **Revoke** action button

#### OAuth 2.0 Platforms (Zoom, YouTube)

Clicking **Connect** initiates the standard OAuth Authorization Code flow:

1. Browser redirects to the platform's authorization URL with the required scopes.
2. User grants consent on the platform's consent screen.
3. Callback URL receives the authorization code.
4. Backend exchanges the code for access + refresh tokens.
5. Tokens are encrypted (AES-256-GCM per ADR-007) and stored as a `PlatformCredential`.

Zoom's Server-to-Server OAuth variant skips user consent — the admin provides the `account_id`, `client_id`, and `client_secret` from the Zoom Marketplace app, and the backend exchanges them directly for an access token.

#### API Key Platforms (Loom, Fireflies)

Clicking **Connect** opens a form where the admin pastes the API key. The backend:

1. Validates the key by making a lightweight test API call (e.g., Loom `GET /v1/videos?limit=1`).
2. If valid, encrypts and stores it.
3. If invalid, returns an error with guidance.

#### Session Token Platform (Kaltura)

Clicking **Connect** opens a form for the admin to provide:

- `partner_id` (Kaltura account ID)
- `admin_secret` or an `app_token` + `app_token_id`

The backend generates a Kaltura Session (KS) using the `session.start` API, validates it, and stores the generation parameters (not the ephemeral KS itself) so that new sessions can be minted on demand.

### 2. Platform Location Registry

To support multi-platform identity tracking, we introduce a `PlatformLocation` value object:

```
PlatformLocation {
  platform:       Platform          -- ZOOM | LOOM | FIREFLIES | YOUTUBE | KALTURA
  external_id:    String            -- ID on that platform
  external_url:   String (nullable) -- Direct link on that platform
  role:           LocationRole      -- ORIGIN | INTERMEDIATE | DESTINATION
  synced_at:      DateTime          -- When this location was last confirmed
}

LocationRole: Enum(ORIGIN, INTERMEDIATE, DESTINATION)
```

The `VideoRecord` aggregate gains a new field:

```
locations: Vec<PlatformLocation>    -- All known platform locations for this video
```

The existing `source_id`, `source_platform`, `destination_id`, and `destination_url` fields are retained for backwards compatibility but the `locations` list becomes the authoritative source for multi-platform presence. A migration will seed `locations` from the existing single-source/single-destination fields.

#### Lifecycle Example

A video recorded in Zoom, edited in Loom, published to YouTube and Kaltura would have:

```json
"locations": [
  { "platform": "Zoom",    "external_id": "zoom-rec-abc", "external_url": "https://zoom.us/rec/abc",    "role": "ORIGIN",       "synced_at": "2026-02-10T14:00:00Z" },
  { "platform": "Loom",    "external_id": "loom-vid-xyz", "external_url": "https://loom.com/share/xyz",  "role": "INTERMEDIATE", "synced_at": "2026-02-11T09:30:00Z" },
  { "platform": "YouTube", "external_id": "yt-dQw4w9Wg",  "external_url": "https://youtube.com/watch?v=dQw4w9Wg", "role": "DESTINATION", "synced_at": "2026-02-12T16:00:00Z" },
  { "platform": "Kaltura", "external_id": "klt-entry-123", "external_url": "https://video.example.edu/id/klt-entry-123", "role": "DESTINATION", "synced_at": "2026-02-12T16:05:00Z" }
]
```

### 3. Connection Health Checks

Each platform adapter exposes a `healthCheck()` method:

| Platform | Health Check Method |
|----------|-------------------|
| Zoom | `GET /v2/users/me` |
| Loom | `GET /v1/videos?limit=1` |
| Fireflies | GraphQL `{ user { email } }` |
| YouTube | `GET /youtube/v3/channels?mine=true` |
| Kaltura | `session.start` + `baseEntry.list` with limit 1 |

Health checks run:
- On-demand when the admin clicks **Test Connection**.
- Automatically every 30 minutes via a background scheduler.
- Before any ingestion or publish operation (fast-path: cached result valid for 5 minutes).

Failed health checks emit a `CredentialInvalidated` domain event (per ADR-007) and update the connection status in the UI.

### 4. Environment-Based Configuration

For non-interactive deployments (CI/CD, self-hosted), credentials can be provided via environment variables:

```
ZOOM_ACCOUNT_ID=...
ZOOM_CLIENT_ID=...
ZOOM_CLIENT_SECRET=...

LOOM_API_KEY=...

FIREFLIES_API_KEY=...

YOUTUBE_CLIENT_ID=...
YOUTUBE_CLIENT_SECRET=...
YOUTUBE_REFRESH_TOKEN=...

KALTURA_PARTNER_ID=...
KALTURA_ADMIN_SECRET=...
```

On startup, the `IdentityContext` bootstrap reads these variables and upserts `PlatformCredential` records if they do not already exist. Environment variables take precedence over database-stored credentials when both are present.

### 5. Credential Rotation

- **OAuth tokens**: Rotated automatically by the `TokenManager` (ADR-007).
- **API keys**: Admin generates a new key on the platform, pastes it in the Connections UI, and the old key is replaced.
- **Kaltura secrets**: Same manual rotation as API keys; the system re-derives sessions using the new secret.

All rotation operations log an audit event with the acting user, timestamp, and platform — but never the credential value itself.

## Consequences

### Positive

- Admins get a single, visible place to manage all platform connections.
- Videos can be tracked across all platforms they exist in, not just source and one destination.
- Health checks surface broken connections before they cause silent ingestion or publish failures.
- Environment variable support enables infrastructure-as-code deployments.

### Negative

- The `PlatformLocation` list adds complexity to the `VideoRecord` aggregate and its serialization.
- Five different auth models means five different connection flows to build and maintain.
- Health check scheduling adds a background process that must be monitored.

### Migration

- Existing `VideoRecord` documents gain an empty `locations` vec by default.
- A one-time migration copies `source_id`/`source_platform` into `locations[0]` with role `ORIGIN`, and `destination_id`/`destination_url` into `locations[1]` with role `DESTINATION` (if present).
- The legacy fields remain readable but writes go through the `locations` list.
