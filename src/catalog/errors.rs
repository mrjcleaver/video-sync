use crate::catalog::value_objects::VideoStatus;
use thiserror::Error;

/// Domain errors for the Catalog bounded context.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum CatalogError {
    #[error("Invalid status transition from {from:?} to {to:?}")]
    InvalidStatusTransition { from: VideoStatus, to: VideoStatus },

    #[error("Video must have at least one owner")]
    OwnerRequired,

    #[error("Note text must not be empty")]
    EmptyNote,

    #[error("User is not authorized to perform this action")]
    Unauthorized,

    #[error("Duplicate video: source_id={source_id} platform={platform:?} already exists")]
    DuplicateVideo {
        source_id: String,
        platform: super::value_objects::SourcePlatform,
    },
}
