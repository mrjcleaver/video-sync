# ADR-003: Async Job Queue for Video Transfer Pipeline

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-02-14 |
| **Deciders** | Architecture Team |
| **Project** | VID-BRIDGE-01 |

## Context

Publishing a video involves downloading up to 5GB of media from a source platform and uploading it to a destination platform (YouTube or Kaltura). This is a long-running, I/O-bound operation that:

- Can take minutes to hours depending on file size and network throughput.
- Must not block the web server or API gateway.
- Must be retryable on transient failures (network timeouts, API rate limits).
- Must report progress to the user (PRD NFR: progress bars).

## Decision

We will use an **asynchronous job queue** (Redis-backed, using BullMQ or a similar library) to process all video transfer operations:

1. **Job Creation**: When a user clicks "Publish", the API creates a `PublishJob` record in the database and enqueues a job message containing the `video_record_id` and `destination` config.
2. **Worker Pool**: A pool of worker processes consumes jobs from the queue. Each worker:
   - Downloads the video from the source `download_url` to temporary storage (see ADR-004).
   - Uploads the file to the destination API.
   - Updates the `VideoRecord` status and `destination_id`/`destination_url` on completion.
3. **Retry Policy**: Failed jobs are retried with exponential backoff (delays: 30s, 2m, 10m, 1h) up to 4 attempts.
4. **Progress Reporting**: Workers emit progress events (% downloaded, % uploaded) via Redis Pub/Sub, which the API relays to the UI over WebSocket or SSE.
5. **Concurrency Control**: Worker concurrency is configurable to respect destination API rate limits (e.g., YouTube daily quota).

### Job States

```
PENDING -> DOWNLOADING -> UPLOADING -> COMPLETED
                |              |
                v              v
             FAILED         FAILED
              (retry)       (retry)
```

## Consequences

### Positive
- Long-running transfers do not block the API server.
- Built-in retry with backoff handles transient failures gracefully.
- Worker concurrency can be scaled independently of the API tier.
- Progress tracking gives users visibility into transfer status.

### Negative
- Adds Redis as an infrastructure dependency.
- Job state management increases system complexity (dead letter queues, stale job detection).
- Workers must handle partial uploads gracefully (resumable uploads where the destination API supports it).

### Risks
- Redis data loss on restart could lose in-flight jobs. Mitigation: persist job records in PostgreSQL as the source of truth; Redis is the dispatch mechanism only.
