//! Experimental shared review domain, not an untrusted synchronization endpoint.
//!
//! A runtime must serialize commands/imports and persist candidates before replacing the durable
//! replica. Independent writers must use `restore_trusted`, never keep multiple command candidates.
mod model;
pub use model::*;

use loro::{EncodedBlobMode, ExportMode, LoroDoc, LoroValue, ToJson, VersionVector};
use serde::{de::DeserializeOwned, Serialize};

pub const MAX_BLOB_BYTES: usize = 4 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 16 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Loro(#[from] loro::LoroError),
    #[error(transparent)]
    Encode(#[from] loro::LoroEncodeError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("invalid review data: {0}")]
    Invalid(&'static str),
    #[error("missing history; exchange fresh durable versions and retry")]
    MissingDependencies,
    #[error("unsupported schema or shallow history; preserve this branch for recovery")]
    Incompatible,
}

pub type Result<T> = std::result::Result<T, Error>;

pub struct Workspace {
    doc: LoroDoc,
}

impl Workspace {
    pub fn new() -> Result<Self> {
        let doc = LoroDoc::new();
        doc.get_map("meta").insert("schema", SCHEMA_VERSION)?;
        doc.commit();
        Ok(Self { doc })
    }

    /// Full-history local storage only. Every restore gets a fresh writer identity.
    pub fn restore_trusted(snapshot: &[u8]) -> Result<Self> {
        check_blob(snapshot)?;
        let meta = LoroDoc::decode_import_blob_meta(snapshot, true)?;
        if !matches!(meta.mode, EncodedBlobMode::Snapshot) {
            return Err(Error::Incompatible);
        }
        let doc = LoroDoc::new();
        check_complete(doc.import(snapshot)?)?;
        let workspace = Self { doc };
        workspace.check_schema()?;
        Ok(workspace)
    }

    pub fn snapshot(&self) -> Result<Vec<u8>> {
        let snapshot = self.doc.export(ExportMode::Snapshot)?;
        check_blob(&snapshot)?;
        Ok(snapshot)
    }

    pub fn version(&self) -> Vec<u8> {
        self.doc.oplog_vv().encode()
    }

    pub fn peer_id(&self) -> String {
        self.doc.peer_id().to_string()
    }

    /// This is coverage only, not a durability acknowledgment. Call after storage commit.
    pub fn covers(&self, version: &[u8]) -> Result<bool> {
        check_blob(version)?;
        Ok(self
            .doc
            .oplog_vv()
            .includes_vv(&VersionVector::decode(version)?))
    }

    pub fn updates_since(&self, version: &[u8]) -> Result<Vec<u8>> {
        check_blob(version)?;
        Ok(self
            .doc
            .export(ExportMode::updates(&VersionVector::decode(version)?))?)
    }

    /// Trusted-only spike API: byte limits are NOT a decompression/allocation budget.
    /// Missing dependencies discard the entire candidate, including any pending imports.
    pub fn import_trusted(&self, update: &[u8]) -> Result<Self> {
        check_blob(update)?;
        let meta = LoroDoc::decode_import_blob_meta(update, true)?;
        if !matches!(
            meta.mode,
            EncodedBlobMode::Updates | EncodedBlobMode::Snapshot
        ) {
            return Err(Error::Incompatible);
        }
        let candidate = self.candidate()?;
        check_complete(candidate.doc.import(update)?)?;
        candidate.check_schema()?;
        Ok(candidate)
    }

    /// Apply a command to an isolated candidate, keeping the writer's peer/counter sequence.
    /// Publish only this returned view; never subscribe to intermediate container writes.
    pub fn command(&self, request: &CommandRequest) -> Result<Self> {
        validate_request(request)?;
        let candidate = self.candidate()?;
        candidate.apply(&request.command)?;
        candidate.doc.commit();
        Ok(candidate)
    }

    pub fn view(&self, version: &str, stream: Option<&str>) -> Result<ReviewView> {
        identifier(version)?;
        let human_importance = self
            .value("humanImportance", version)?
            .unwrap_or(Importance::Inherit);
        let assessments: Vec<Assessment> = self
            .collection("agentAssessments")?
            .into_iter()
            .filter(|a: &Assessment| a.target.version == version)
            .collect();
        let context = self
            .collection("context")?
            .into_iter()
            .filter(|c: &Context| c.target.version == version)
            .collect();
        let mut heads = assessments.iter().filter(|a| {
            Some(a.stream.as_str()) == stream
                && !assessments
                    .iter()
                    .any(|b| b.supersedes.as_deref() == Some(&a.id))
        });
        let head = heads.next();
        let inherited = if heads.next().is_none() {
            head.map(|a| a.importance)
        } else {
            None
        };
        Ok(ReviewView {
            reviewed: self.value("reviewed", version)?.unwrap_or(false),
            collapsed: self.value("collapsed", version)?.unwrap_or(false),
            human_importance,
            effective_importance: match human_importance {
                Importance::Important => Some(AssessmentValue::Important),
                Importance::Unimportant => Some(AssessmentValue::Unimportant),
                Importance::Inherit => inherited,
            },
            assessments,
            context,
        })
    }

    fn candidate(&self) -> Result<Self> {
        let doc = self.doc.fork();
        doc.set_peer_id(self.doc.peer_id())?;
        Ok(Self { doc })
    }

    fn check_schema(&self) -> Result<()> {
        if self.doc.is_shallow() || self.value::<u32>("meta", "schema")? != Some(SCHEMA_VERSION) {
            return Err(Error::Incompatible);
        }
        Ok(())
    }

    fn value<T: DeserializeOwned>(&self, root: &str, key: &str) -> Result<Option<T>> {
        self.doc
            .get_map(root)
            .get(key)
            .map(|value| {
                serde_json::from_value(value.get_deep_value().to_json_value()).map_err(Error::from)
            })
            .transpose()
    }

    fn collection<T: DeserializeOwned>(&self, root: &str) -> Result<Vec<T>> {
        let mut entries = std::collections::BTreeMap::new();
        self.doc.get_map(root).for_each(|key, value| {
            entries.insert(key.to_string(), value.get_deep_value().to_json_value());
        });
        entries
            .into_values()
            .map(|v| Ok(serde_json::from_value(v)?))
            .collect()
    }

    fn put(&self, root: &str, key: &str, value: impl Serialize) -> Result<()> {
        let value: LoroValue = serde_json::from_value(serde_json::to_value(value)?)?;
        self.doc.get_map(root).insert(key, value)?;
        Ok(())
    }

    fn immutable<T: Serialize + DeserializeOwned + PartialEq>(
        &self,
        root: &str,
        id: &str,
        value: &T,
    ) -> Result<()> {
        match self.value::<T>(root, id)? {
            Some(existing) if &existing == value => Ok(()),
            Some(_) => Err(Error::Invalid("contribution IDs are immutable")),
            None => self.put(root, id, value),
        }
    }

    fn apply(&self, command: &Command) -> Result<()> {
        let version = &command.target().version;
        match command {
            Command::Review { reviewed, .. } | Command::ReassertReview { reviewed, .. } => {
                let reassert = matches!(command, Command::ReassertReview { .. });
                if !reassert
                    && self.value::<bool>("reviewed", version)?.unwrap_or(false) == *reviewed
                {
                    return Ok(());
                }
                // Loro skips same-value inserts. A delete+insert in one explicit commit forces a
                // resolving write; observers only receive the final materialized candidate view.
                if reassert {
                    self.doc.get_map("reviewed").delete(version)?;
                    self.doc.get_map("collapsed").delete(version)?;
                }
                self.put("reviewed", version, reviewed)?;
                self.put("collapsed", version, reviewed)
            }
            Command::Collapse { collapsed, .. } => {
                if self.value::<bool>("collapsed", version)?.unwrap_or(false) == *collapsed {
                    return Ok(());
                }
                self.put("collapsed", version, collapsed)
            }
            Command::SetImportance { importance, .. } => {
                self.put("humanImportance", version, importance)
            }
            Command::Assess { assessment } => {
                if let Some(previous) = &assessment.supersedes {
                    let old: Assessment = self
                        .value("agentAssessments", previous)?
                        .ok_or(Error::Invalid("unknown assessment predecessor"))?;
                    if old.target != assessment.target
                        || old.stream != assessment.stream
                        || old.agent != assessment.agent
                        || old.id == assessment.id
                    {
                        return Err(Error::Invalid(
                            "assessment predecessor belongs to another stream or target",
                        ));
                    }
                }
                self.immutable("agentAssessments", &assessment.id, assessment)
            }
            Command::AddContext { context } => self.immutable("context", &context.id, context),
        }
    }
}

fn check_blob(bytes: &[u8]) -> Result<()> {
    if bytes.len() > MAX_BLOB_BYTES {
        return Err(Error::Invalid("binary payload limit"));
    }
    Ok(())
}

fn check_complete(status: loro::ImportStatus) -> Result<()> {
    if status.pending.is_some_and(|pending| !pending.is_empty()) {
        return Err(Error::MissingDependencies);
    }
    Ok(())
}

fn identifier(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 256
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:/".contains(&b))
    {
        return Err(Error::Invalid("identifier"));
    }
    Ok(())
}

fn validate_request(request: &CommandRequest) -> Result<()> {
    let target = request.command.target();
    identifier(&target.snapshot)?;
    identifier(&target.version)?;
    if target != &request.displayed {
        return Err(Error::Invalid(
            "command does not target the displayed snapshot/version",
        ));
    }
    match (&request.actor, &request.command) {
        (
            Actor::Human,
            Command::Review { .. }
            | Command::ReassertReview { .. }
            | Command::Collapse { .. }
            | Command::SetImportance { .. },
        ) => Ok(()),
        (Actor::Agent { agent, run }, Command::Assess { assessment: a }) => {
            attribution(agent, run, &a.agent, &a.run)?;
            identifier(&a.id)?;
            identifier(&a.stream)?;
            if let Some(id) = &a.supersedes {
                identifier(id)?;
            }
            if a.evidence.len() > 32 {
                return Err(Error::Invalid("evidence limit"));
            }
            for evidence in &a.evidence {
                identifier(evidence)?;
            }
            Ok(())
        }
        (Actor::Agent { agent, run }, Command::AddContext { context: c }) => {
            attribution(agent, run, &c.agent, &c.run)?;
            identifier(&c.id)?;
            if c.text.len() > MAX_TEXT_BYTES {
                return Err(Error::Invalid("context limit"));
            }
            Ok(())
        }
        _ => Err(Error::Invalid("actor cannot issue this command")),
    }
}

fn attribution(agent: &str, run: &str, claimed_agent: &str, claimed_run: &str) -> Result<()> {
    identifier(agent)?;
    identifier(run)?;
    if agent != claimed_agent || run != claimed_run {
        return Err(Error::Invalid("spoofed agent attribution"));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
