# ADR-007: OAuth 2.0 and API Token Management

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-02-14 |
| **Deciders** | Architecture Team |
| **Project** | VID-BRIDGE-01 |

## Context

The system integrates with five external APIs (Zoom, Loom, Fireflies, YouTube, Kaltura), each requiring authentication credentials:

| Platform | Auth Method | Token Lifecycle |
|----------|------------|-----------------|
| Zoom | OAuth 2.0 (Server-to-Server) | Access token expires (1 hour) |
| Loom | API Key or OAuth 2.0 | API keys are long-lived |
| Fireflies | API Key | Long-lived |
| YouTube | OAuth 2.0 (User consent) | Access token expires (1 hour); refresh token long-lived |
| Kaltura | Session Token (KS) | Configurable expiry |

The PRD requires that all API tokens be **encrypted at rest** (NFR Security). The system must also handle OAuth token refresh transparently without user intervention.

## Decision

### 1. Credential Storage

All credentials are stored in the `platform_credentials` database table with the following structure:

```
PlatformCredential {
  id:               UUID
  tenant_id:        UUID
  platform:         Enum(ZOOM, LOOM, FIREFLIES, YOUTUBE, KALTURA)
  credential_type:  Enum(OAUTH2, API_KEY, SESSION_TOKEN)
  encrypted_data:   Bytea     -- AES-256-GCM encrypted JSON blob
  expires_at:       DateTime (nullable)
  created_at:       DateTime
  updated_at:       DateTime
}
```

- The `encrypted_data` field contains a JSON blob with platform-specific credential fields (`access_token`, `refresh_token`, `api_key`, etc.), encrypted using **AES-256-GCM**.
- The encryption key is stored in an environment variable or secrets manager (AWS Secrets Manager, HashiCorp Vault) — never in the database.

### 2. Token Refresh Strategy

A `TokenManager` service handles token lifecycle:

1. Before each API call, `TokenManager.getValidToken(platform, tenantId)` is called.
2. If the token expires within 5 minutes, it is **proactively refreshed** using the stored refresh token.
3. Refreshed tokens are re-encrypted and stored back in the database.
4. If refresh fails (e.g., refresh token revoked), the credential status is set to `INVALID` and the admin is notified (US-2).

### 3. User Authentication

The application itself uses OAuth 2.0 (Authorization Code flow) for user login, supporting SSO providers (Google, Microsoft). User sessions are managed via short-lived JWTs with refresh tokens.

## Consequences

### Positive
- All credentials encrypted at rest with AES-256-GCM.
- Proactive token refresh eliminates auth failures during long-running operations.
- Centralized `TokenManager` avoids scattered credential logic across adapters.

### Negative
- Encryption key management adds operational complexity (key rotation, access control).
- Proactive refresh requires background scheduling or middleware hooks.

### Risks
- If the encryption key is compromised, all stored credentials are exposed. Mitigation: use a secrets manager with audit logging and rotation policies.
- OAuth refresh token revocation by the user on the source platform will silently break ingestion until the admin re-authorizes.
