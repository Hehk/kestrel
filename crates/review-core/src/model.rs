use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;
pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(target_arch = "wasm32", derive(tsify::Tsify))]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub snapshot: String,
    pub version: String,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(target_arch = "wasm32", derive(tsify::Tsify))]
#[serde(rename_all = "camelCase")]
pub enum Importance {
    Important,
    Unimportant,
    Inherit,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(target_arch = "wasm32", derive(tsify::Tsify))]
#[serde(rename_all = "camelCase")]
pub enum AssessmentValue {
    Important,
    Unimportant,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(target_arch = "wasm32", derive(tsify::Tsify))]
#[serde(deny_unknown_fields)]
pub struct Assessment {
    pub id: String,
    pub target: Target,
    pub agent: String,
    pub run: String,
    pub stream: String,
    pub importance: AssessmentValue,
    pub evidence: Vec<String>,
    pub supersedes: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(target_arch = "wasm32", derive(tsify::Tsify))]
#[serde(deny_unknown_fields)]
pub struct Context {
    pub id: String,
    pub target: Target,
    pub agent: String,
    pub run: String,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(target_arch = "wasm32", derive(tsify::Tsify))]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Command {
    Review {
        target: Target,
        reviewed: bool,
    },
    ReassertReview {
        target: Target,
        reviewed: bool,
    },
    Collapse {
        target: Target,
        collapsed: bool,
    },
    SetImportance {
        target: Target,
        importance: Importance,
    },
    Assess {
        assessment: Assessment,
    },
    AddContext {
        context: Context,
    },
}

impl Command {
    pub fn target(&self) -> &Target {
        match self {
            Self::Review { target, .. }
            | Self::ReassertReview { target, .. }
            | Self::Collapse { target, .. }
            | Self::SetImportance { target, .. } => target,
            Self::Assess { assessment } => &assessment.target,
            Self::AddContext { context } => &context.target,
        }
    }
}

/// Supplied by the authenticated service, never inferred from a document or command.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(target_arch = "wasm32", derive(tsify::Tsify))]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Actor {
    Human,
    Agent { agent: String, run: String },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(target_arch = "wasm32", derive(tsify::Tsify))]
#[serde(deny_unknown_fields)]
pub struct CommandRequest {
    pub command: Command,
    pub actor: Actor,
    /// The caller must verify this target against its immutable snapshot manifest.
    pub displayed: Target,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(target_arch = "wasm32", derive(tsify::Tsify))]
pub struct ReviewView {
    pub reviewed: bool,
    pub collapsed: bool,
    pub human_importance: Importance,
    pub effective_importance: Option<AssessmentValue>,
    pub assessments: Vec<Assessment>,
    pub context: Vec<Context>,
}
