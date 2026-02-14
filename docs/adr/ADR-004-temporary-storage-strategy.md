# ADR-004: Temporary Storage Strategy for Video Binaries

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-02-14 |
| **Deciders** | Architecture Team |
| **Project** | VID-BRIDGE-01 |

## Context

The system is explicitly **not a video hosting platform** (PRD scope). It stores metadata and temporarily buffers video binaries during the transfer from source to destination. Video files can be up to 5GB (PRD NFR). We need a storage solution that:

- Handles large files efficiently.
- Automatically cleans up after transfer completion.
- Is cost-effective for transient data.
- Supports streaming reads/writes to avoid loading full files into memory.

## Decision

We will use **AWS S3** (or S3-compatible storage such as MinIO for local development) as the temporary storage layer:

1. **Bucket Configuration**: A dedicated bucket `vidbrige-temp-{env}` with:
   - **Lifecycle Policy**: Objects expire and are auto-deleted after **24 hours**.
   - **Storage Class**: S3 Standard (optimized for frequent access during the transfer window).
2. **Upload Path Convention**: `temp/{video_record_id}/{source_platform}/{filename}`.
3. **Streaming**: Workers stream downloads directly to S3 using multipart upload (no local disk dependency). Similarly, uploads to destination APIs stream from S3 using presigned URLs or chunked reads.
4. **Cleanup**: On successful publish, the worker explicitly deletes the temp object. The 24-hour lifecycle policy serves as a safety net for orphaned files from failed jobs.
5. **Size Limits**: Objects up to 5GB are handled via S3 multipart upload (part size: 100MB).

## Consequences

### Positive
- No local disk requirements on worker nodes — fully cloud-native.
- Automatic cleanup via lifecycle policy prevents storage cost accumulation.
- S3 multipart upload handles 5GB files reliably.
- S3-compatible alternatives (MinIO) enable local development without AWS dependency.

### Negative
- S3 transfer costs (data transfer between S3 and external APIs) add to operational cost.
- Adds AWS SDK as a dependency.
- Workers in non-AWS environments may experience higher latency to S3.

### Alternatives Considered
- **Local disk on workers**: Rejected — does not scale horizontally; disk management complexity; risk of filling disk.
- **Stream directly source-to-destination without intermediate storage**: Rejected — source download URLs may expire mid-transfer; no ability to retry the upload without re-downloading; some destination APIs require Content-Length headers that need a complete file.
