//! Shared review domain. Network writes are reconstructed from bounded typed proposals.
mod proposal;
use automerge::{
    sync::{Message, State, SyncDoc},
    transaction::Transactable,
    ActorId, Automerge, ObjId, ObjType, ReadDoc, ROOT,
};
pub use proposal::Proposal;
use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;
pub const PROTOCOL_VERSION: u32 = 1;
const MAPS: [&str; 5] = [
    "reviewed",
    "collapsed",
    "humanImportance",
    "agentAssessments",
    "context",
];
pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "api-schema", derive(utoipa::ToSchema))]
pub enum Importance {
    Important,
    Unimportant,
    Inherit,
}

impl Importance {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Important => "important",
            Self::Unimportant => "unimportant",
            Self::Inherit => "inherit",
        }
    }

    fn parse(value: &str) -> Result<Self> {
        match value {
            "important" => Ok(Self::Important),
            "unimportant" => Ok(Self::Unimportant),
            "inherit" => Ok(Self::Inherit),
            _ => Err("invalid importance".into()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "api-schema", derive(utoipa::ToSchema))]
pub struct Contribution {
    pub id: String,
    pub version: String,
    pub agent: String,
    pub run: String,
    pub importance: Importance,
    pub evidence: Vec<String>,
    pub context: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "api-schema", derive(utoipa::ToSchema))]
pub enum Command {
    Review { version: String, value: bool },
    ReassertReview { version: String, value: bool },
    Collapse { version: String, value: bool },
    Importance { version: String, value: Importance },
    ReassertImportance { version: String, value: Importance },
    Assess { contribution: Contribution },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
pub struct View {
    pub reviewed: bool,
    pub collapsed: bool,
    pub review_alternatives: Vec<bool>,
    pub human_importance: Importance,
    pub importance_alternatives: Vec<Importance>,
    pub effective_importance: Option<Importance>,
    pub assessments: Vec<Contribution>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Capability {
    Human,
    Agent,
}

#[derive(Clone)]
pub struct Workspace {
    doc: Automerge,
}

impl Workspace {
    pub fn bootstrap() -> Result<Self> {
        let mut doc = Automerge::new();
        let mut tx = doc.transaction();
        tx.put(ROOT, "schemaVersion", SCHEMA_VERSION)?;
        for name in MAPS {
            tx.put_object(ROOT, name, ObjType::Map)?;
        }
        tx.commit();
        Ok(Self { doc })
    }

    /// The caller must supply a fresh, exclusively owned actor, never an authenticated identity.
    pub fn load_trusted(bytes: &[u8], actor: ActorId) -> Result<Self> {
        let mut doc = Automerge::load(bytes)?;
        doc.set_actor(actor);
        let workspace = Self { doc };
        workspace.check_schema()?;
        Ok(workspace)
    }

    pub fn fork(&self) -> Self {
        Self {
            doc: self.doc.fork(),
        }
    }

    pub fn save(&self) -> Vec<u8> {
        self.doc.save()
    }

    pub fn document(&self) -> &Automerge {
        &self.doc
    }

    /// Only for local experiments with replicas of known provenance.
    pub fn merge_trusted(&mut self, other: &mut Self) -> Result<()> {
        for name in MAPS {
            if self.map(name)? != other.map(name)? {
                return Err("workspace ancestry changed; export and recover local commands".into());
            }
        }
        let mut candidate = self.doc.clone();
        candidate.merge(&mut other.doc)?;
        let candidate = Self { doc: candidate };
        candidate.check_schema()?;
        *self = candidate;
        Ok(())
    }

    pub fn receive_sync_trusted(&mut self, peer: &mut State, message: Message) -> Result<()> {
        let mut candidate = self.clone();
        let mut candidate_peer = peer.clone();
        candidate
            .doc
            .receive_sync_message(&mut candidate_peer, message)?;
        candidate.check_schema()?;
        *self = candidate;
        *peer = candidate_peer;
        Ok(())
    }

    fn check_schema(&self) -> Result<()> {
        if self
            .doc
            .get(ROOT, "schemaVersion")?
            .and_then(|(v, _)| v.to_u64())
            != Some(SCHEMA_VERSION as u64)
        {
            return Err("unsupported schema; preserve the original bytes".into());
        }
        for name in MAPS {
            self.map(name)?;
        }
        Ok(())
    }

    fn map(&self, name: &str) -> Result<ObjId> {
        match self.doc.get(ROOT, name)? {
            Some((automerge::Value::Object(ObjType::Map), id)) => Ok(id),
            _ => Err(format!("missing map: {name}").into()),
        }
    }

    fn flag(&self, map: &ObjId, version: &str) -> Result<bool> {
        match self.doc.get(map, version)? {
            None => Ok(false),
            Some((value, _)) => value.to_bool().ok_or_else(|| "expected boolean".into()),
        }
    }

    pub fn view(&self, version: &str) -> Result<View> {
        self.views(&[version.to_owned()])
            .map(|mut views| views.remove(0))
    }

    pub fn views(&self, versions: &[String]) -> Result<Vec<View>> {
        let mut assessments = std::collections::HashMap::<String, Vec<Contribution>>::new();
        for entry in self.doc.map_range(self.map("agentAssessments")?, ..) {
            let value = automerge::Value::from(entry.value);
            let contribution: Contribution =
                serde_json::from_str(value.to_str().ok_or("expected contribution")?)?;
            assessments
                .entry(contribution.version.clone())
                .or_default()
                .push(contribution);
        }
        versions
            .iter()
            .map(|version| {
                self.project(
                    version,
                    assessments.get(version).cloned().unwrap_or_default(),
                )
            })
            .collect()
    }

    fn project(&self, version: &str, assessments: Vec<Contribution>) -> Result<View> {
        let reviewed = self.map("reviewed")?;
        let mut alternatives = self
            .doc
            .get_all(&reviewed, version)?
            .into_iter()
            .map(|(v, _)| v.to_bool().ok_or("expected boolean"))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        alternatives.sort();
        // Keep duplicate values: two equal concurrent decisions still need explicit resolution.
        let human_importance = match self.doc.get(self.map("humanImportance")?, version)? {
            Some((v, _)) => Importance::parse(v.to_str().ok_or("expected importance")?)?,
            None => Importance::Inherit,
        };
        let mut importance_alternatives = self
            .doc
            .get_all(self.map("humanImportance")?, version)?
            .into_iter()
            .map(|(value, _)| Importance::parse(value.to_str().ok_or("expected importance")?))
            .collect::<Result<Vec<_>>>()?;
        importance_alternatives.sort_by_key(Importance::as_str);
        let effective_importance = if human_importance != Importance::Inherit {
            Some(human_importance.clone())
        } else if assessments.len() == 1 {
            Some(assessments[0].importance.clone())
        } else {
            None
        };
        Ok(View {
            reviewed: self.flag(&reviewed, version)?,
            collapsed: self.flag(&self.map("collapsed")?, version)?,
            review_alternatives: alternatives,
            human_importance,
            importance_alternatives,
            effective_importance,
            assessments,
        })
    }

    /// Capability checks protect this command API, not imported Automerge history.
    pub fn apply(&mut self, capability: Capability, command: Command) -> Result<bool> {
        if (capability == Capability::Agent) != matches!(command, Command::Assess { .. }) {
            return Err("command is outside this writer's capability".into());
        }
        let reassert_importance = matches!(command, Command::ReassertImportance { .. });
        match command {
            Command::Review { version, .. } | Command::ReassertReview { version, .. }
                if version.is_empty() =>
            {
                Err("empty version".into())
            }
            Command::Review { version, value } => self.review(&version, value, false),
            Command::ReassertReview { version, value } => self.review(&version, value, true),
            Command::Collapse { version, value } => {
                if version.is_empty() {
                    return Err("empty version".into());
                }
                let map = self.map("collapsed")?;
                if self.flag(&map, &version)? == value {
                    return Ok(false);
                }
                let mut tx = self.doc.transaction();
                tx.put(map, version, value)?;
                tx.commit();
                Ok(true)
            }
            Command::Importance { version, value }
            | Command::ReassertImportance { version, value } => {
                if version.is_empty() {
                    return Err("empty version".into());
                }
                let view = self.view(&version)?;
                if view.human_importance == value
                    && (!reassert_importance || view.importance_alternatives.len() <= 1)
                {
                    return Ok(false);
                }
                let map = self.map("humanImportance")?;
                let mut tx = self.doc.transaction();
                tx.put(map, version, value.as_str())?;
                tx.commit();
                Ok(true)
            }
            Command::Assess { contribution } => {
                if contribution.id.is_empty()
                    || contribution.version.is_empty()
                    || contribution.agent.is_empty()
                    || contribution.run.is_empty()
                    || contribution.importance == Importance::Inherit
                {
                    return Err("invalid contribution".into());
                }
                let map = self.map("agentAssessments")?;
                let json = serde_json::to_string(&contribution)?;
                if let Some((old, _)) = self.doc.get(&map, &contribution.id)? {
                    return if old.to_str() == Some(json.as_str()) {
                        Ok(false)
                    } else {
                        Err("contribution IDs are immutable".into())
                    };
                }
                let context = self.map("context")?;
                let mut tx = self.doc.transaction();
                tx.put(map, &contribution.id, json.as_str())?;
                // Store attributed context, not an unbound string.
                tx.put(context, &contribution.id, json)?;
                tx.commit();
                Ok(true)
            }
        }
    }

    fn review(&mut self, version: &str, value: bool, reassert: bool) -> Result<bool> {
        let map = self.map("reviewed")?;
        if self.flag(&map, version)? == value
            && (!reassert || self.doc.get_all(&map, version)?.len() <= 1)
        {
            return Ok(false);
        }
        let collapsed = self.map("collapsed")?;
        let mut tx = self.doc.transaction();
        tx.put(map, version, value)?;
        tx.put(collapsed, version, value)?;
        tx.commit();
        Ok(true)
    }

    /// A persistence adapter commits bytes+journal atomically before publishing this candidate.
    pub fn apply_durable(
        &mut self,
        capability: Capability,
        command: Command,
        persist: impl FnOnce(&[u8]) -> Result<()>,
    ) -> Result<bool> {
        let mut candidate = self.clone();
        let changed = candidate.apply(capability, command)?;
        if changed {
            persist(&candidate.save())?;
            *self = candidate;
        }
        Ok(changed)
    }
}
