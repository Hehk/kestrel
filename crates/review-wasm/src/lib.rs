use automerge::{
    sync::{Message, State, SyncDoc},
    ActorId,
};
use review_core::{Capability, Command, Proposal, View, Workspace};
use tsify::{Ts, Tsify};
use wasm_bindgen::prelude::*;

fn error(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

/// Trusted-only spike harness. Do not connect this API to a network endpoint.
#[wasm_bindgen]
pub struct ReviewReplica {
    workspace: Workspace,
    peer: State,
}

#[wasm_bindgen]
impl ReviewReplica {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8]) -> Result<ReviewReplica, JsError> {
        Ok(Self {
            workspace: Workspace::load_trusted(bytes, ActorId::random()).map_err(error)?,
            peer: State::new(),
        })
    }

    pub fn bootstrap() -> Result<Vec<u8>, JsError> {
        Ok(Workspace::bootstrap().map_err(error)?.save())
    }

    pub fn propose(&mut self, command: Ts<Command>) -> Result<Option<Ts<Proposal>>, JsError> {
        self.workspace
            .propose(command.to_rust().map_err(error)?)
            .map_err(error)?
            .map(|proposal| proposal.into_ts().map_err(error))
            .transpose()
    }

    #[wasm_bindgen(js_name = mergeTrusted)]
    pub fn merge_trusted(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        let mut remote = Workspace::load_trusted(bytes, ActorId::random()).map_err(error)?;
        self.workspace.merge_trusted(&mut remote).map_err(error)
    }

    pub fn save(&self) -> Vec<u8> {
        self.workspace.save()
    }

    pub fn view(&self, version: &str) -> Result<Ts<View>, JsError> {
        self.workspace
            .view(version)
            .map_err(error)?
            .into_ts()
            .map_err(error)
    }

    pub fn views(&self, versions: Vec<String>) -> Result<Vec<Ts<View>>, JsError> {
        self.workspace
            .views(&versions)
            .map_err(error)?
            .into_iter()
            .map(|view| view.into_ts().map_err(error))
            .collect()
    }

    pub fn apply(&mut self, command: Ts<Command>) -> Result<bool, JsError> {
        self.workspace
            .apply(Capability::Human, command.to_rust().map_err(error)?)
            .map_err(error)
    }

    #[wasm_bindgen(js_name = generateSync)]
    pub fn generate_sync(&mut self) -> Option<Vec<u8>> {
        self.workspace
            .document()
            .generate_sync_message(&mut self.peer)
            .map(|m| m.encode())
    }

    #[wasm_bindgen(js_name = receiveSyncTrusted)]
    pub fn receive_sync_trusted(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        self.workspace
            .receive_sync_trusted(&mut self.peer, Message::decode(bytes).map_err(error)?)
            .map_err(error)
    }

    #[wasm_bindgen(js_name = resetSync)]
    pub fn reset_sync(&mut self) {
        self.peer = State::new();
    }
}
