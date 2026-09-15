use crate::{Capability, Command, Result, Workspace, PROTOCOL_VERSION};
use automerge::{ActorId, ChangeHash, ReadDoc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "api-schema", derive(utoipa::ToSchema))]
pub struct Proposal {
    pub protocol: u32,
    pub actor: String,
    pub dependencies: Vec<String>,
    pub hash: String,
    pub command: Command,
}

impl Workspace {
    pub fn propose(&mut self, command: Command) -> Result<Option<Proposal>> {
        let mut candidate = self.clone();
        let actor = ActorId::random();
        candidate.doc.set_actor(actor.clone());
        let dependencies = candidate.doc.get_heads();
        if !candidate.apply(Capability::Human, command.clone())? {
            return Ok(None);
        }
        let changes = candidate.doc.get_changes(&dependencies);
        if changes.len() != 1 {
            return Err("expected one command change".into());
        }
        let proposal = Proposal {
            protocol: PROTOCOL_VERSION,
            actor: actor.to_hex_string(),
            dependencies: dependencies.iter().map(ToString::to_string).collect(),
            hash: changes[0].hash().to_string(),
            command,
        };
        *self = candidate;
        Ok(Some(proposal))
    }

    /// Reconstruct exactly the proposed change at its original causal frontier.
    /// No client-supplied Automerge bytes or operations are ever decoded.
    pub fn accept(&mut self, proposal: &Proposal) -> Result<bool> {
        if proposal.protocol != PROTOCOL_VERSION
            || proposal.actor.len() != 32
            || proposal.dependencies.is_empty()
            || proposal.dependencies.len() > 64
            || proposal.hash.len() != 64
        {
            return Err("unsupported or invalid proposal".into());
        }
        let actor = proposal.actor.parse::<ActorId>()?;
        let hash: ChangeHash = proposal.hash.parse()?;
        let deps = proposal
            .dependencies
            .iter()
            .map(|s| s.parse::<ChangeHash>())
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut candidate = Self {
            doc: self.doc.fork_at(&deps)?,
        };
        if candidate
            .doc
            .get_changes(&[])
            .iter()
            .any(|change| change.actor_id() == &actor)
        {
            return Err("proposal actor is not fresh".into());
        }
        candidate.doc.set_actor(actor.clone());
        if !candidate.apply(Capability::Human, proposal.command.clone())? {
            return Err("proposal contains no change".into());
        }
        let changes = candidate.doc.get_changes(&deps);
        if changes.len() != 1 || changes[0].hash() != hash {
            return Err("proposal does not reproduce its change hash".into());
        }
        if self.doc.get_change_by_hash(&hash).is_some() {
            return Ok(false);
        }
        if self
            .doc
            .get_changes(&[])
            .iter()
            .any(|change| change.actor_id() == &actor)
        {
            return Err("actor collision".into());
        }
        self.merge_trusted(&mut candidate)?;
        Ok(true)
    }
}

impl Command {
    pub fn version(&self) -> &str {
        match self {
            Self::Review { version, .. }
            | Self::ReassertReview { version, .. }
            | Self::Collapse { version, .. }
            | Self::Importance { version, .. }
            | Self::ReassertImportance { version, .. } => version,
            Self::Assess { contribution } => &contribution.version,
        }
    }
}
