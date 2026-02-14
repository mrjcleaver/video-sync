# Aggregate: PublishJob

**Bounded Context:** [Publishing](../bounded-contexts/publishing.md)

## Description

The `PublishJob` aggregate tracks a single video transfer operation from a source platform to a destination platform. It manages the download-buffer-upload pipeline, retry logic, and progress reporting.

## Entity Diagram

```
PublishJob (Aggregate Root)
├── id: UUID
├── video_record_id: UUID
├── tenant_id: UUID
├── destination: DestinationPlatform [VO]
├── destination_conn_id: UUID
├── status: PublishStatus [VO]
├── progress_percent: Integer
├── metadata_override: PublishMetadata [VO]
│   ├── title: String
│   ├── description: String?
│   └── tags: List<String>
├── privacy_setting: PrivacySetting [VO]?
├── kaltura_category: String?
├── temp_storage_key: String?
├── attempt_count: Integer
├── max_attempts: Integer
├── error_message: String?
├── created_at: DateTime
├── started_at: DateTime?
├── completed_at: DateTime?
├── destination_id: String?
└── destination_url: String?
```

## State Machine

```
┌─────────┐     start      ┌──────────────┐     downloaded     ┌───────────┐
│ PENDING  │ ──────────────>│ DOWNLOADING  │ ──────────────────>│ UPLOADING │
└─────────┘                 └──────┬───────┘                    └─────┬─────┘
                                   │ error                            │
                                   v                                  │ error
                            ┌──────────────┐                          │
                            │   FAILED     │ <────────────────────────┘
                            │ (retryable?) │
                            └──────┬───────┘
                                   │ retry (if attempts < max)
                                   v
                            ┌──────────────┐
                            │   PENDING    │  (re-enqueued)
                            └──────────────┘

┌───────────┐    success    ┌──────────────┐
│ UPLOADING │ ─────────────>│  COMPLETED   │
└───────────┘               └──────────────┘
```

## Business Rules

1. **Retry Policy**: On failure, `attempt_count` is incremented. If `attempt_count < max_attempts`, the job is re-enqueued with exponential backoff (30s, 2m, 10m, 1h). If `attempt_count >= max_attempts`, the job is permanently `FAILED`.
2. **YouTube Privacy**: `privacy_setting` must be set when `destination` is `YOUTUBE`. Defaults to `UNLISTED` if omitted.
3. **Metadata Required**: `metadata_override.title` must be non-empty.
4. **Temp Cleanup**: On `COMPLETED` or permanent `FAILED`, the temp storage object (`temp_storage_key`) must be deleted from S3.
5. **Quota Check**: Before starting a YouTube upload, the adapter must verify that the daily quota has not been exhausted.
6. **Concurrency**: Only one active PublishJob should exist per `video_record_id` + `destination` combination.

## Commands

| Command | Description | Preconditions |
|---------|-------------|---------------|
| `CreatePublishJob` | Enqueue a new publish operation | Valid video_record_id, destination, metadata |
| `StartDownload` | Begin downloading from source to temp storage | Status is PENDING |
| `CompleteDownload` | Mark download phase complete, begin upload | Status is DOWNLOADING |
| `CompleteUpload` | Record destination info, mark COMPLETED | Status is UPLOADING |
| `FailJob` | Record error, determine retry eligibility | Status is DOWNLOADING or UPLOADING |
| `RetryJob` | Re-enqueue a failed job | Status is FAILED, attempts < max |
| `CancelJob` | Cancel a pending or active job | Status is PENDING, DOWNLOADING, or UPLOADING |

## Events Emitted

| Event | Trigger |
|-------|---------|
| `PublishCompleted` | Job reaches COMPLETED status |
| `PublishFailed` | Job reaches permanent FAILED status (retries exhausted) |
| `PublishProgress` | Progress update during download or upload phase |
