# Bounded Context: Publishing

## Purpose

The Publishing Context handles the transfer of video files from source platforms to destination platforms (YouTube, Kaltura). It manages the lifecycle of publish jobs, including downloading, uploading, retry logic, and progress reporting.

## Aggregates

### PublishJob

Represents a single video transfer operation from source to destination.

```
PublishJob {
  id:                  UUID
  video_record_id:     UUID                  -- FK to Catalog.VideoRecord
  tenant_id:           UUID
  destination:         DestinationPlatform   -- YOUTUBE | KALTURA
  destination_conn_id: UUID                  -- FK to DestinationConnection
  status:              PublishStatus          -- PENDING | DOWNLOADING | UPLOADING | COMPLETED | FAILED
  progress_percent:    Integer (0-100)
  metadata_override:   PublishMetadata        -- User-edited title, description, tags
  privacy_setting:     PrivacySetting (nullable) -- For YouTube: PUBLIC | PRIVATE | UNLISTED
  kaltura_category:    String (nullable)      -- For Kaltura category mapping
  temp_storage_key:    String (nullable)      -- S3 key for buffered file
  attempt_count:       Integer (default: 0)
  max_attempts:        Integer (default: 4)
  error_message:       String (nullable)
  created_at:          DateTime
  started_at:          DateTime (nullable)
  completed_at:        DateTime (nullable)
  destination_id:      String (nullable)      -- Video ID on destination
  destination_url:     String (nullable)      -- Public URL on destination
}
```

**Invariants:**
- `status` transitions follow: `PENDING -> DOWNLOADING -> UPLOADING -> COMPLETED` or any active state -> `FAILED`.
- `attempt_count` must not exceed `max_attempts`. On exhaustion, status becomes `FAILED` permanently.
- `privacy_setting` is required when `destination` is `YOUTUBE`.
- `metadata_override` must have a non-empty `title`.

### DestinationConnection

Represents a configured integration with a destination platform.

```
DestinationConnection {
  id:             UUID
  tenant_id:      UUID
  platform:       DestinationPlatform      -- YOUTUBE | KALTURA
  status:         ConnectionStatus         -- ACTIVE | PAUSED | ERROR
  credential_id:  UUID                     -- FK to Identity.PlatformCredential
  config:         JSONB                    -- Platform-specific (e.g., YouTube channel ID, Kaltura partner ID)
}
```

### Value Objects

```
DestinationPlatform: Enum(YOUTUBE, KALTURA)

PublishStatus: Enum(PENDING, DOWNLOADING, UPLOADING, COMPLETED, FAILED)

PrivacySetting: Enum(PUBLIC, PRIVATE, UNLISTED)

PublishMetadata {
  title:       String
  description: String (nullable)
  tags:        List<String>
}

PublishProgress {
  job_id:      UUID
  phase:       String            -- "downloading" | "uploading"
  percent:     Integer (0-100)
  bytes_transferred: Long
  bytes_total:       Long
}
```

## Domain Services

### PublishOrchestrator

Processes publish jobs from the queue:

1. Dequeues a `PENDING` job.
2. Obtains valid credentials via `Identity.TokenManager`.
3. Refreshes the `download_url` from the source adapter if expired.
4. **Download phase**: Streams the video from the source to S3 temp storage. Updates status to `DOWNLOADING`. Emits progress events.
5. **Upload phase**: Streams from S3 to the destination API. Updates status to `UPLOADING`. Emits progress events.
6. On success: Sets status to `COMPLETED`, records `destination_id` and `destination_url`. Emits `PublishCompleted`. Deletes temp file from S3.
7. On failure: Increments `attempt_count`. If retries remain, re-enqueues with backoff delay. If exhausted, sets status to `FAILED`. Emits `PublishFailed`.

### DestinationAdapterRegistry

Maintains a registry of `DestinationAdapter` implementations:

```
interface DestinationAdapter {
  platform: DestinationPlatform
  upload(file: ReadableStream, metadata: PublishMetadata, config: JSONB): Promise<UploadResult>
  validateQuota(): Promise<QuotaStatus>
}
```

### YouTubeAdapter

- Uses YouTube Data API v3 `videos.insert` for resumable uploads.
- Supports privacy settings (Public, Private, Unlisted).
- Checks daily quota before starting upload. If quota is near limit, defers the job.

### KalturaAdapter

- Uses Kaltura VPaaS API for media upload.
- Maps `PublishMetadata` to Kaltura entry fields.
- Supports category/gallery assignment via `kaltura_category`.

## Domain Events

| Event | Direction | Payload |
|-------|-----------|---------|
| `PublishRequested` | Consumed (from UI/API) | `video_record_id`, `destination`, `metadata_override`, `privacy_setting` |
| `PublishCompleted` | Produced | `publish_job_id`, `video_record_id`, `destination_id`, `destination_url` |
| `PublishFailed` | Produced | `publish_job_id`, `video_record_id`, `error_message`, `attempt_count` |

## External Dependencies

- YouTube Data API v3
- Kaltura VPaaS API
- AWS S3 (temporary storage)
- Redis / BullMQ (job queue)
- Identity Context (for credentials)
- Catalog Context (for video metadata and status updates)
