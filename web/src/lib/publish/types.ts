/**
 * ADR-077 §3 — the shape every destination adapter speaks.
 *
 * Before this, each platform's push lived inline in a VideoCard handler
 * with its own credential plumbing, error handling and event text. Three
 * handlers meant three chances to fix a bug in one place and miss the
 * other two — which is how the provenance footer ended up duplicated
 * three ways and Kaltura inherited YouTube's character cap.
 *
 * Adapters do exactly one thing: push the media and report where it
 * landed. They do NOT touch the catalog store, emit activity events, or
 * drive status transitions — the caller owns those, because status
 * semantics are the aggregate's business (ADR-077 §1) and not a
 * per-platform concern.
 *
 * Credentials are passed in rather than read from localStorage here, so
 * adapters are unit-testable and so the browser-storage dependency stays
 * at the edge.
 */

import type { DestinationSpec } from "../youtubeTitleAlign";
import type { VideoRecordJSON } from "../wasm";

/** Source-fetch credentials, forwarded to whichever endpoint downloads
 *  the media. Which ones matter depends on the source URL scheme, not on
 *  the destination — a Fireflies-sourced record needs Fireflies creds
 *  whether it is going to YouTube or Kaltura. */
export interface SourceCredentials {
  zoomAccountId?: string;
  zoomClientId?: string;
  zoomClientSecret?: string;
  firefliesApiKey?: string;
  ytCookies?: string;
}

export interface YouTubeCredentials {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}

export interface KalturaCredentials {
  partnerId?: string;
  adminSecret?: string;
}

export interface PublishCredentials {
  source: SourceCredentials;
  youtube?: YouTubeCredentials;
  kaltura?: KalturaCredentials;
}

/** What to publish, independent of where. `visibility` is the value the
 *  destination declared, in that platform's own vocabulary — an adapter
 *  applies it if its endpoint supports it (only YouTube's does today;
 *  see appliesDeclaredVisibility in destinationResolver). */
export interface PublishAttrs {
  title: string;
  description: string;
  tags: string[];
  visibility?: string;
  trimStartSeconds?: number;
}

export interface PushRequest {
  record: VideoRecordJSON;
  spec: DestinationSpec;
  attrs: PublishAttrs;
  /** Source media URL. May differ from record.download_url when an
   *  upstream copy is a better fetch target (ADR-062 source picking). */
  sourceUrl: string;
  creds: PublishCredentials;
  /** Progress reporter for long uploads. YouTube's endpoint streams
   *  phases over SSE; the others are single-shot and report once. */
  onPhase?: (phase: string) => void;
}

export interface PushResult {
  external_id: string;
  external_url: string;
  /** Bytes transferred, when the endpoint reports it (Drive does). */
  bytes?: number;
  /** ADR-077 §5 — the visibility the platform actually has after the
   *  push, read back rather than assumed. Absent when the platform has no
   *  read-back yet (Kaltura, pending its access-control mapping). */
  observed_visibility?: string;
  /** False when the push landed but the declared visibility could not be
   *  applied. The media is there; the sharing is not what was asked for. */
  visibility_applied?: boolean;
  visibility_error?: string;
}

export interface DestinationAdapter {
  platform: DestinationSpec["platform"];
  /** Push the media. Throws on failure with an operator-readable message;
   *  the executor turns that into a per-destination Failed outcome. */
  push(req: PushRequest): Promise<PushResult>;
}
