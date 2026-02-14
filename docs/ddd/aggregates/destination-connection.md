# Aggregate: DestinationConnection

**Bounded Context:** [Publishing](../bounded-contexts/publishing.md)

## Description

The `DestinationConnection` aggregate represents a configured integration between the Video Bridge and a destination video platform (YouTube or Kaltura). It holds the credentials reference and platform-specific configuration needed for uploads.

## Entity Diagram

```
DestinationConnection (Aggregate Root)
├── id: UUID
├── tenant_id: UUID
├── platform: DestinationPlatform [VO]
├── status: ConnectionStatus [VO]
├── credential_id: UUID
└── config: JSONB
    ├── [YouTube] channel_id: String
    ├── [YouTube] default_privacy: PrivacySetting
    ├── [Kaltura] partner_id: String
    └── [Kaltura] default_category: String?
```

## Business Rules

1. **One Per Platform**: A tenant may have at most one active `DestinationConnection` per `DestinationPlatform`.
2. **Credential Validity**: Before starting a publish job, the system verifies the credential is `VALID`. If invalid, the publish job is rejected.
3. **YouTube Channel**: For YouTube connections, `config.channel_id` must be set and verified via the YouTube API.
4. **Kaltura Partner**: For Kaltura connections, `config.partner_id` must be set.

## Commands

| Command | Description | Preconditions |
|---------|-------------|---------------|
| `CreateConnection` | Configure a new destination integration | Admin role, no duplicate platform for tenant |
| `UpdateConnection` | Modify config (channel, category, etc.) | Connection exists, admin role |
| `TestConnection` | Verify credentials and connectivity | Connection exists |
| `PauseConnection` | Temporarily disable publishing to this destination | Status is ACTIVE |
| `ResumeConnection` | Re-enable publishing | Status is PAUSED |
| `DeleteConnection` | Remove the integration | Admin role, no active PublishJobs |
