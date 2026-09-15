#![cfg(target_arch = "wasm32")]

use review_core::{CommandRequest, ReviewView, Workspace};
use tsify::Ts;
use wasm_bindgen::prelude::*;

fn js_error(error: review_core::Error) -> JsError {
    JsError::new(&error.to_string())
}

/// Local review domain boundary. No network or storage side effects.
#[wasm_bindgen]
pub struct ReviewWorkspace(Workspace);

#[wasm_bindgen]
impl ReviewWorkspace {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Result<ReviewWorkspace, JsError> {
        Workspace::new().map(Self).map_err(js_error)
    }

    #[wasm_bindgen(js_name = restoreTrusted)]
    pub fn restore_trusted(snapshot: &[u8]) -> Result<ReviewWorkspace, JsError> {
        Workspace::restore_trusted(snapshot)
            .map(Self)
            .map_err(js_error)
    }

    pub fn snapshot(&self) -> Result<Vec<u8>, JsError> {
        self.0.snapshot().map_err(js_error)
    }

    pub fn version(&self) -> Vec<u8> {
        self.0.version()
    }

    #[wasm_bindgen(js_name = peerId)]
    pub fn peer_id(&self) -> String {
        self.0.peer_id()
    }

    pub fn covers(&self, version: &[u8]) -> Result<bool, JsError> {
        self.0.covers(version).map_err(js_error)
    }

    #[wasm_bindgen(js_name = updatesSince)]
    pub fn updates_since(&self, version: &[u8]) -> Result<Vec<u8>, JsError> {
        self.0.updates_since(version).map_err(js_error)
    }

    #[wasm_bindgen(js_name = importTrusted)]
    pub fn import_trusted(&self, update: &[u8]) -> Result<ReviewWorkspace, JsError> {
        self.0.import_trusted(update).map(Self).map_err(js_error)
    }

    pub fn command(&self, request: Ts<CommandRequest>) -> Result<ReviewWorkspace, JsError> {
        self.0
            .command(&request.to_rust()?)
            .map(Self)
            .map_err(js_error)
    }

    pub fn view(&self, version: &str, stream: Option<String>) -> Result<Ts<ReviewView>, JsError> {
        Ok(Ts::from_rust(
            &self.0.view(version, stream.as_deref()).map_err(js_error)?,
        )?)
    }
}
