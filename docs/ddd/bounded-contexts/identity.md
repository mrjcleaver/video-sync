# Bounded Context: Identity

## Purpose

The Identity Context manages user authentication, tenant isolation, and secure storage/retrieval of platform credentials. It provides the `TokenManager` shared service used by both Ingestion and Publishing contexts.

## Aggregates

### User

Represents an authenticated user of the Video Bridge system.

```
User {
  id:            UUID
  tenant_id:     UUID
  email:         String (unique)
  name:          String
  role:          UserRole               -- ADMIN | PUBLISHER | VIEWER
  auth_provider: AuthProvider           -- GOOGLE | MICROSOFT | LOCAL
  external_id:   String (nullable)      -- ID from OAuth provider
  created_at:    DateTime
  last_login_at: DateTime (nullable)
}
```

**Invariants:**
- Each tenant must have at least one ADMIN user.
- Email must be unique across the system.

### Tenant

Represents an organizational unit (company, team) that owns resources.

```
Tenant {
  id:          UUID
  name:        String
  slug:        String (unique)          -- URL-safe identifier
  plan:        TenantPlan              -- FREE | PRO | ENTERPRISE
  created_at:  DateTime
}
```

### PlatformCredential

Stores encrypted credentials for external platform APIs.

```
PlatformCredential {
  id:              UUID
  tenant_id:       UUID
  platform:        Platform              -- ZOOM | LOOM | FIREFLIES | YOUTUBE | KALTURA
  credential_type: CredentialType        -- OAUTH2 | API_KEY | SESSION_TOKEN
  encrypted_data:  Bytea                 -- AES-256-GCM encrypted JSON
  status:          CredentialStatus      -- VALID | EXPIRING | INVALID | REVOKED
  expires_at:      DateTime (nullable)
  last_used_at:    DateTime (nullable)
  created_at:      DateTime
  updated_at:      DateTime
}
```

**Invariants:**
- `encrypted_data` must never be exposed in API responses or logs.
- Only ADMIN users can create or modify PlatformCredentials.
- A tenant may have at most one active credential per platform.

### Value Objects

```
UserRole: Enum(ADMIN, PUBLISHER, VIEWER)

AuthProvider: Enum(GOOGLE, MICROSOFT, LOCAL)

Platform: Enum(ZOOM, LOOM, FIREFLIES, YOUTUBE, KALTURA)

CredentialType: Enum(OAUTH2, API_KEY, SESSION_TOKEN)

CredentialStatus: Enum(VALID, EXPIRING, INVALID, REVOKED)

TenantPlan: Enum(FREE, PRO, ENTERPRISE)

DecryptedCredential {
  access_token:   String (nullable)
  refresh_token:  String (nullable)
  api_key:        String (nullable)
  session_token:  String (nullable)
  extra:          Map<String, String>    -- Platform-specific fields
}
```

## Domain Services

### TokenManager

The core shared service consumed by Ingestion and Publishing contexts:

```
TokenManager {
  getValidToken(platform: Platform, tenantId: UUID): DecryptedCredential
  refreshToken(credentialId: UUID): DecryptedCredential
  revokeCredential(credentialId: UUID): void
  checkHealth(credentialId: UUID): CredentialStatus
}
```

**Behavior:**
1. `getValidToken` decrypts the stored credential and checks expiry.
2. If the token expires within 5 minutes, it proactively calls `refreshToken`.
3. If refresh fails, it sets the credential status to `INVALID` and emits `CredentialInvalidated`.
4. All token operations are logged for audit (without logging the actual token values).

### AuthService

Handles user authentication:

1. OAuth 2.0 Authorization Code flow for Google/Microsoft SSO.
2. Issues short-lived JWT access tokens (15 min) + refresh tokens (7 days).
3. Role-based access control: ADMIN, PUBLISHER, VIEWER.

### EncryptionService

Manages credential encryption/decryption:

1. Uses AES-256-GCM with a master key from the secrets manager.
2. Each credential has a unique IV (initialization vector).
3. Supports key rotation: new credentials use the latest key version; old credentials are re-encrypted on next access.

## Domain Events

| Event | Direction | Payload |
|-------|-----------|---------|
| `CredentialInvalidated` | Produced | `credential_id`, `platform`, `tenant_id`, `reason` |
| `CredentialRefreshed` | Produced (internal) | `credential_id`, `platform`, `new_expiry` |
| `UserCreated` | Produced | `user_id`, `tenant_id`, `role` |

## Authorization Matrix

| Action | ADMIN | PUBLISHER | VIEWER |
|--------|-------|-----------|--------|
| Configure source/destination connections | Yes | No | No |
| Manage platform credentials | Yes | No | No |
| View video catalog | Yes | Yes | Yes |
| Search videos | Yes | Yes | Yes |
| Publish videos | Yes | Yes | No |
| Edit publish metadata | Yes | Yes | No |
| Manage users | Yes | No | No |

## External Dependencies

- OAuth 2.0 providers (Google, Microsoft)
- AWS Secrets Manager / HashiCorp Vault (encryption key storage)
- PostgreSQL (user, tenant, credential storage)
