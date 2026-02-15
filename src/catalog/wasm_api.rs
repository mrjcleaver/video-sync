use wasm_bindgen::prelude::*;

use crate::catalog::commands::*;
use crate::catalog::events::CatalogEvent;
use crate::catalog::video_record::VideoRecord;

/// WASM-exposed wrapper around VideoRecord.
/// All methods accept/return JSON strings for JS interop.
#[wasm_bindgen]
pub struct WasmVideoRecord {
    inner: VideoRecord,
}

#[wasm_bindgen]
impl WasmVideoRecord {
    /// Create a new VideoRecord from a JSON IndexVideo command.
    #[wasm_bindgen(constructor)]
    pub fn new(index_cmd_json: &str) -> Result<WasmVideoRecord, JsError> {
        let cmd: IndexVideo =
            serde_json::from_str(index_cmd_json).map_err(|e| JsError::new(&e.to_string()))?;
        let (record, _events) = VideoRecord::index(cmd);
        Ok(Self { inner: record })
    }

    /// Get the record ID.
    pub fn id(&self) -> String {
        self.inner.id.to_string()
    }

    /// Get the current status.
    pub fn status(&self) -> String {
        serde_json::to_string(&self.inner.status).unwrap_or_default()
    }

    /// Get the full record as JSON.
    pub fn to_json(&self) -> Result<String, JsError> {
        self.inner
            .to_json()
            .map_err(|e| JsError::new(&e.to_string()))
    }

    /// Restore from JSON.
    #[wasm_bindgen(js_name = "fromJson")]
    pub fn from_json(json: &str) -> Result<WasmVideoRecord, JsError> {
        let record =
            VideoRecord::from_json(json).map_err(|e| JsError::new(&e.to_string()))?;
        Ok(Self { inner: record })
    }

    /// Approve the video. Returns JSON array of emitted events.
    pub fn approve(&mut self, cmd_json: &str) -> Result<String, JsError> {
        let cmd: ApproveVideo =
            serde_json::from_str(cmd_json).map_err(|e| JsError::new(&e.to_string()))?;
        let events = self
            .inner
            .approve(cmd)
            .map_err(|e| JsError::new(&e.to_string()))?;
        Self::events_to_json(&events)
    }

    /// Skip the video. Returns JSON array of emitted events.
    pub fn skip(&mut self, cmd_json: &str) -> Result<String, JsError> {
        let cmd: SkipVideo =
            serde_json::from_str(cmd_json).map_err(|e| JsError::new(&e.to_string()))?;
        let events = self
            .inner
            .skip(cmd)
            .map_err(|e| JsError::new(&e.to_string()))?;
        Self::events_to_json(&events)
    }

    /// Request publishing. Returns JSON array of emitted events.
    pub fn request_publish(&mut self, cmd_json: &str) -> Result<String, JsError> {
        let cmd: RequestPublish =
            serde_json::from_str(cmd_json).map_err(|e| JsError::new(&e.to_string()))?;
        let events = self
            .inner
            .request_publish(cmd)
            .map_err(|e| JsError::new(&e.to_string()))?;
        Self::events_to_json(&events)
    }

    /// Mark published. Returns JSON array of emitted events.
    pub fn mark_published(&mut self, cmd_json: &str) -> Result<String, JsError> {
        let cmd: MarkPublished =
            serde_json::from_str(cmd_json).map_err(|e| JsError::new(&e.to_string()))?;
        let events = self
            .inner
            .mark_published(cmd)
            .map_err(|e| JsError::new(&e.to_string()))?;
        Self::events_to_json(&events)
    }

    /// Mark failed. Returns JSON array of emitted events.
    pub fn mark_failed(&mut self, cmd_json: &str) -> Result<String, JsError> {
        let cmd: MarkFailed =
            serde_json::from_str(cmd_json).map_err(|e| JsError::new(&e.to_string()))?;
        let events = self
            .inner
            .mark_failed(cmd)
            .map_err(|e| JsError::new(&e.to_string()))?;
        Self::events_to_json(&events)
    }

    /// Update metadata. Returns JSON array of emitted events.
    pub fn update_metadata(&mut self, cmd_json: &str) -> Result<String, JsError> {
        let cmd: UpdateMetadata =
            serde_json::from_str(cmd_json).map_err(|e| JsError::new(&e.to_string()))?;
        let events = self
            .inner
            .update_metadata(cmd)
            .map_err(|e| JsError::new(&e.to_string()))?;
        Self::events_to_json(&events)
    }

    /// Add a note. Returns JSON array of emitted events.
    pub fn add_note(&mut self, cmd_json: &str) -> Result<String, JsError> {
        let cmd: AddNote =
            serde_json::from_str(cmd_json).map_err(|e| JsError::new(&e.to_string()))?;
        let events = self
            .inner
            .add_note(cmd)
            .map_err(|e| JsError::new(&e.to_string()))?;
        Self::events_to_json(&events)
    }

    /// Assign owners. Returns JSON array of emitted events.
    pub fn assign_owners(&mut self, cmd_json: &str) -> Result<String, JsError> {
        let cmd: AssignOwners =
            serde_json::from_str(cmd_json).map_err(|e| JsError::new(&e.to_string()))?;
        let events = self
            .inner
            .assign_owners(cmd)
            .map_err(|e| JsError::new(&e.to_string()))?;
        Self::events_to_json(&events)
    }

    /// Assign moderators. Returns JSON array of emitted events.
    pub fn assign_moderators(&mut self, cmd_json: &str) -> Result<String, JsError> {
        let cmd: AssignModerators =
            serde_json::from_str(cmd_json).map_err(|e| JsError::new(&e.to_string()))?;
        let events = self
            .inner
            .assign_moderators(cmd)
            .map_err(|e| JsError::new(&e.to_string()))?;
        Self::events_to_json(&events)
    }

    /// Get notes as JSON array.
    pub fn notes(&self) -> Result<String, JsError> {
        serde_json::to_string(&self.inner.notes).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Get tags as JSON array.
    pub fn tags(&self) -> Result<String, JsError> {
        serde_json::to_string(&self.inner.tags).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Get owners as JSON array of UUID strings.
    pub fn owners(&self) -> Result<String, JsError> {
        serde_json::to_string(&self.inner.owners).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Get moderators as JSON array of UUID strings.
    pub fn moderators(&self) -> Result<String, JsError> {
        serde_json::to_string(&self.inner.moderators)
            .map_err(|e| JsError::new(&e.to_string()))
    }

    /// Get locations as JSON array.
    pub fn locations(&self) -> Result<String, JsError> {
        serde_json::to_string(&self.inner.locations)
            .map_err(|e| JsError::new(&e.to_string()))
    }

    /// Add a platform location. Returns JSON array of emitted events.
    pub fn add_location(&mut self, cmd_json: &str) -> Result<String, JsError> {
        let cmd: AddLocation =
            serde_json::from_str(cmd_json).map_err(|e| JsError::new(&e.to_string()))?;
        let events = self
            .inner
            .add_location(cmd)
            .map_err(|e| JsError::new(&e.to_string()))?;
        Self::events_to_json(&events)
    }

    /// Remove a platform location. Returns JSON array of emitted events.
    pub fn remove_location(&mut self, cmd_json: &str) -> Result<String, JsError> {
        let cmd: RemoveLocation =
            serde_json::from_str(cmd_json).map_err(|e| JsError::new(&e.to_string()))?;
        let events = self
            .inner
            .remove_location(cmd)
            .map_err(|e| JsError::new(&e.to_string()))?;
        Self::events_to_json(&events)
    }
}

impl WasmVideoRecord {
    fn events_to_json(events: &[CatalogEvent]) -> Result<String, JsError> {
        serde_json::to_string(events).map_err(|e| JsError::new(&e.to_string()))
    }
}
