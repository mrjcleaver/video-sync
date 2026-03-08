use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::catalog::value_objects::{DerivationType, LinkOrigin, LocationRole, Platform, SourcePlatform, VideoStatus};

/// Domain events emitted by the Catalog bounded context.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "event_type")]
pub enum CatalogEvent {
    VideoIndexed(VideoIndexed),
    VideoApproved(VideoApproved),
    VideoSkipped(VideoSkipped),
    VideoScoped(VideoScoped),
    NoteAdded(NoteAdded),
    OwnersAssigned(OwnersAssigned),
    ModeratorsAssigned(ModeratorsAssigned),
    MetadataUpdated(MetadataUpdated),
    StatusChanged(StatusChanged),
    LocationAdded(LocationAdded),
    LocationRemoved(LocationRemoved),
    LocationStatusUpdated(LocationStatusUpdated),
    VideoAbandoned(VideoAbandoned),
    VideoMarkedToRetry(VideoMarkedToRetry),
    UpstreamLinked(UpstreamLinked),
    UpstreamUnlinked(UpstreamUnlinked),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VideoIndexed {
    pub event_id: Uuid,
    pub timestamp: DateTime<Utc>,
    pub video_record_id: Uuid,
    pub source_platform: SourcePlatform,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VideoApproved {
    pub event_id: Uuid,
    pub timestamp: DateTime<Utc>,
    pub video_record_id: Uuid,
    pub approved_by: Uuid,
    pub previous_status: VideoStatus,
    pub metadata_edits: Option<MetadataEdits>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VideoSkipped {
    pub event_id: Uuid,
    pub timestamp: DateTime<Utc>,
    pub video_record_id: Uuid,
    pub skipped_by: Uuid,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VideoScoped {
    pub event_id: Uuid,
    pub timestamp: DateTime<Utc>,
    pub video_record_id: Uuid,
    pub scoped_by: Uuid,
    pub rule_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NoteAdded {
    pub event_id: Uuid,
    pub timestamp: DateTime<Utc>,
    pub video_record_id: Uuid,
    pub note_id: Uuid,
    pub author_id: Uuid,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OwnersAssigned {
    pub event_id: Uuid,
    pub timestamp: DateTime<Utc>,
    pub video_record_id: Uuid,
    pub assigned_by: Uuid,
    pub owners: Vec<Uuid>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModeratorsAssigned {
    pub event_id: Uuid,
    pub timestamp: DateTime<Utc>,
    pub video_record_id: Uuid,
    pub assigned_by: Uuid,
    pub moderators: Vec<Uuid>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MetadataUpdated {
    pub event_id: Uuid,
    pub timestamp: DateTime<Utc>,
    pub video_record_id: Uuid,
    pub updated_by: Uuid,
    pub edits: MetadataEdits,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StatusChanged {
    pub event_id: Uuid,
    pub timestamp: DateTime<Utc>,
    pub video_record_id: Uuid,
    pub from: VideoStatus,
    pub to: VideoStatus,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LocationAdded {
    pub event_id: Uuid,
    pub timestamp: DateTime<Utc>,
    pub video_record_id: Uuid,
    pub added_by: Uuid,
    pub platform: Platform,
    pub external_id: String,
    pub external_url: Option<String>,
    pub role: LocationRole,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LocationRemoved {
    pub event_id: Uuid,
    pub timestamp: DateTime<Utc>,
    pub video_record_id: Uuid,
    pub removed_by: Uuid,
    pub platform: Platform,
    pub external_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LocationStatusUpdated {
    pub event_id: Uuid,
    pub timestamp: DateTime<Utc>,
    pub video_record_id: Uuid,
    pub updated_by: Uuid,
    pub platform: Platform,
    pub external_id: String,
    pub old_status: Option<String>,
    pub new_status: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VideoAbandoned {
    pub event_id: Uuid,
    pub timestamp: DateTime<Utc>,
    pub video_record_id: Uuid,
    pub abandoned_by: Uuid,
    pub previous_status: VideoStatus,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VideoMarkedToRetry {
    pub event_id: Uuid,
    pub timestamp: DateTime<Utc>,
    pub video_record_id: Uuid,
    pub marked_by: Uuid,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UpstreamLinked {
    pub event_id: Uuid,
    pub timestamp: DateTime<Utc>,
    pub video_record_id: Uuid,
    pub upstream_video_id: Option<Uuid>,
    pub platform: Platform,
    pub external_id: String,
    pub relation: DerivationType,
    pub linked_by: LinkOrigin,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UpstreamUnlinked {
    pub event_id: Uuid,
    pub timestamp: DateTime<Utc>,
    pub video_record_id: Uuid,
    pub platform: Platform,
    pub external_id: String,
    pub rejected: bool,
}

/// Mutable metadata fields that can be edited during approval or update.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MetadataEdits {
    pub title: Option<String>,
    pub description: Option<String>,
    pub tags: Option<Vec<String>>,
    pub notes: Option<Vec<String>>,
    pub owners: Option<Vec<Uuid>>,
    pub moderators: Option<Vec<Uuid>>,
    pub recorded_at: Option<String>,
    pub transcript_text: Option<String>,
}
