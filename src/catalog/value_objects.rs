use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use wasm_bindgen::prelude::*;

/// External platform that originates video content.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SourcePlatform {
    Zoom,
    Loom,
    Fireflies,
    YouTube,
}

/// Any platform a video can exist on (source or destination).
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Platform {
    Zoom,
    Loom,
    Fireflies,
    YouTube,
    Kaltura,
    Veedio,
}

impl From<SourcePlatform> for Platform {
    fn from(sp: SourcePlatform) -> Self {
        match sp {
            SourcePlatform::Zoom => Platform::Zoom,
            SourcePlatform::Loom => Platform::Loom,
            SourcePlatform::Fireflies => Platform::Fireflies,
            SourcePlatform::YouTube => Platform::YouTube,
        }
    }
}

/// Role of a platform location in the video lifecycle.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum LocationRole {
    Origin,
    Intermediate,
    Destination,
}

/// A platform where this video exists, with its external identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlatformLocation {
    pub platform: Platform,
    pub external_id: String,
    pub external_url: Option<String>,
    pub role: LocationRole,
    #[serde(default)]
    pub ordinal: u32,
    pub synced_at: DateTime<Utc>,
    #[serde(default)]
    pub status: Option<String>,
}

/// Lifecycle status of a video within the curation pipeline.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum VideoStatus {
    Discovered,
    InScope,
    Approved,
    Skipped,
    Publishing,
    Published,
    Failed,
    Abandoned,
    ToRetry,
}

impl VideoStatus {
    /// Returns true if this status can transition to `InScope`.
    pub fn can_scope(&self) -> bool {
        matches!(self, VideoStatus::Discovered)
    }

    /// Returns true if this status can transition to `Approved`.
    pub fn can_approve(&self) -> bool {
        matches!(
            self,
            VideoStatus::Discovered | VideoStatus::InScope | VideoStatus::Skipped | VideoStatus::Failed | VideoStatus::ToRetry
        )
    }

    /// Returns true if this status can transition to `Skipped`.
    pub fn can_skip(&self) -> bool {
        matches!(self, VideoStatus::Discovered | VideoStatus::InScope)
    }

    /// Returns true if this status can transition to `Publishing`.
    pub fn can_publish(&self) -> bool {
        matches!(self, VideoStatus::Approved)
    }

    /// Returns true if this status can transition to `Abandoned`.
    pub fn can_abandon(&self) -> bool {
        matches!(
            self,
            VideoStatus::Failed | VideoStatus::InScope | VideoStatus::Discovered | VideoStatus::Skipped | VideoStatus::Published
        )
    }

    /// Returns true if this status can transition to `ToRetry`.
    pub fn can_mark_to_retry(&self) -> bool {
        matches!(self, VideoStatus::Failed | VideoStatus::Published)
    }
}

/// User role within the system.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum UserRole {
    Admin,
    Publisher,
    Viewer,
}

/// How a downstream VideoRecord relates to its upstream source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DerivationType {
    /// Different platform capture of the same meeting/session.
    SameEvent,
    /// Transcript produced by processing the upstream video.
    TranscribedFrom,
    /// Screen-recording or re-stream of the upstream.
    ScreenRecordingOf,
    /// Time-bounded clip extracted from the upstream.
    ClipOf,
}

/// Whether a provenance link was established automatically or by a curator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LinkOrigin {
    Auto,
    Manual,
}

/// A directional link from this VideoRecord to an upstream source.
/// `video_id` is None when the upstream is a phantom (not indexed in this catalog).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpstreamLink {
    /// Catalog ID of the upstream VideoRecord, if present.
    pub video_id: Option<Uuid>,
    pub platform: Platform,
    pub external_id: String,
    /// Display hint for the platform account (e.g. "ruv@ruv.net"). Not a foreign key.
    pub account_hint: Option<String>,
    pub relation: DerivationType,
    pub linked_by: LinkOrigin,
    pub linked_at: DateTime<Utc>,
}

/// A provenance link the curator has explicitly rejected — prevents re-suggestion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RejectedLink {
    pub platform: Platform,
    pub external_id: String,
    pub rejected_at: DateTime<Utc>,
}

/// Internal annotation attached to a video by a curator, owner, or moderator.
/// Not published to destination platforms.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Note {
    pub id: Uuid,
    pub author_id: Uuid,
    pub text: String,
    pub created_at: DateTime<Utc>,
}

impl Note {
    pub fn new(author_id: Uuid, text: String) -> Self {
        Self {
            id: Uuid::new_v4(),
            author_id,
            text,
            created_at: Utc::now(),
        }
    }
}

/// Identity of the user performing a command, used for authorization checks.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Actor {
    pub user_id: Uuid,
    pub role: UserRole,
}

impl Actor {
    pub fn new(user_id: Uuid, role: UserRole) -> Self {
        Self { user_id, role }
    }

    pub fn is_admin(&self) -> bool {
        self.role == UserRole::Admin
    }

    pub fn is_publisher(&self) -> bool {
        self.role == UserRole::Publisher
    }

    pub fn is_admin_or_publisher(&self) -> bool {
        self.is_admin() || self.is_publisher()
    }
}

/// Full-text search query with filters.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SearchQuery {
    pub text: String,
    pub source_filter: Option<SourcePlatform>,
    pub status_filter: Option<VideoStatus>,
    pub owner_filter: Option<Uuid>,
    pub date_from: Option<DateTime<Utc>>,
    pub date_to: Option<DateTime<Utc>>,
    pub participant: Option<String>,
    pub page: u32,
    pub page_size: u32,
}

impl SearchQuery {
    pub fn new(text: String) -> Self {
        Self {
            text,
            page: 1,
            page_size: 20,
            ..Default::default()
        }
    }
}
