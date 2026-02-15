use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::catalog::events::MetadataEdits;
use crate::catalog::value_objects::{Actor, SourcePlatform};

/// Commands accepted by the VideoRecord aggregate.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum VideoCommand {
    IndexVideo(IndexVideo),
    ApproveVideo(ApproveVideo),
    SkipVideo(SkipVideo),
    RequestPublish(RequestPublish),
    MarkPublished(MarkPublished),
    MarkFailed(MarkFailed),
    UpdateMetadata(UpdateMetadata),
    AddNote(AddNote),
    AssignOwners(AssignOwners),
    AssignModerators(AssignModerators),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexVideo {
    pub source_id: String,
    pub source_platform: SourcePlatform,
    pub title: String,
    pub description: Option<String>,
    pub duration_seconds: u32,
    pub participants: Vec<String>,
    pub transcript_text: Option<String>,
    pub download_url: String,
    pub thumbnail_url: Option<String>,
    pub tags: Vec<String>,
    pub metadata_extra: Option<serde_json::Value>,
    pub initial_owner: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApproveVideo {
    pub actor: Actor,
    pub metadata_edits: Option<MetadataEdits>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkipVideo {
    pub actor: Actor,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestPublish {
    pub actor: Actor,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarkPublished {
    pub destination_id: String,
    pub destination_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarkFailed {
    pub error_message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateMetadata {
    pub actor: Actor,
    pub edits: MetadataEdits,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AddNote {
    pub actor: Actor,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssignOwners {
    pub actor: Actor,
    pub owners: Vec<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssignModerators {
    pub actor: Actor,
    pub moderators: Vec<Uuid>,
}
