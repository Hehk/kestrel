//! Converts GitHub-style git diffs into an owned application model.
//!
//! Diffy exposes only modes from explicit extended headers, not the optional mode on an `index`
//! line. Binary payloads are intentionally classified and discarded rather than decoded. Combined
//! merge diffs are outside the supported pull request diff format.

use diffy::{
    patch_set::{FileMode, FileOperation, FilePatch, ParseOptions, PatchKind, PatchSet},
    Hunk, Line,
};

pub(crate) const MAX_DIFF_BYTES: usize = 64 * 1024 * 1024;
const MAX_PHYSICAL_LINES: usize = 300_000;
const MAX_FILES: usize = 10_000;
const MAX_HUNKS: usize = 100_000;
const MAX_SEMANTIC_LINES: usize = 200_000;
const MAX_PATH_BYTES: usize = 16 * 1024;
const MAX_UNQUOTED_PATH_SPACES: usize = 256;
const MAX_PATH_COMPLEXITY: usize = 32 * 1024 * 1024;
const MAX_SOURCE_LINE_BYTES: usize = 512 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PullRequestDiffFile {
    pub(crate) additions: u32,
    pub(crate) content: PullRequestDiffContent,
    pub(crate) deletions: u32,
    pub(crate) operation: PullRequestDiffFileOperation,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum PullRequestDiffContent {
    Text { hunks: Vec<PullRequestDiffHunk> },
    Binary,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum PullRequestDiffFileOperation {
    Added {
        path: String,
        mode: PullRequestDiffFileMode,
    },
    Deleted {
        path: String,
        mode: PullRequestDiffFileMode,
    },
    Modified {
        path: String,
        mode_change: PullRequestDiffModeChange,
    },
    Renamed {
        old_path: String,
        new_path: String,
        mode_change: PullRequestDiffModeChange,
    },
    Copied {
        old_path: String,
        new_path: String,
        mode_change: PullRequestDiffModeChange,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PullRequestDiffModeChange {
    Unchanged,
    Changed {
        old_mode: PullRequestDiffFileMode,
        new_mode: PullRequestDiffFileMode,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PullRequestDiffFileMode {
    Regular,
    Executable,
    Symlink,
    Gitlink,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PullRequestDiffHunk {
    pub(crate) context: Option<String>,
    pub(crate) lines: Vec<PullRequestDiffLine>,
    pub(crate) new_count: u32,
    pub(crate) new_start: u32,
    pub(crate) old_count: u32,
    pub(crate) old_start: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PullRequestDiffLine {
    pub(crate) content: String,
    pub(crate) kind: PullRequestDiffLineKind,
    pub(crate) missing_newline: bool,
    pub(crate) new_line: Option<u32>,
    pub(crate) old_line: Option<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PullRequestDiffLineKind {
    Context,
    Addition,
    Deletion,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum DiffParseError {
    InvalidDiff(String),
    LimitExceeded(DiffParseLimit),
    NumberOutOfRange,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DiffParseLimit {
    Bytes,
    Files,
    Hunks,
    Lines,
    PathBytes,
    PathComplexity,
    PhysicalLines,
    SourceLineBytes,
}

impl std::fmt::Display for DiffParseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidDiff(message) => write!(formatter, "invalid pull request diff: {message}"),
            Self::LimitExceeded(limit) => {
                write!(formatter, "pull request diff exceeds {limit}")
            }
            Self::NumberOutOfRange => {
                formatter.write_str("invalid pull request diff: number exceeds u32 range")
            }
        }
    }
}

impl std::error::Error for DiffParseError {}

impl std::fmt::Display for DiffParseLimit {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let name = match self {
            Self::Bytes => "byte limit",
            Self::Files => "file limit",
            Self::Hunks => "hunk limit",
            Self::Lines => "semantic line limit",
            Self::PathBytes => "path length limit",
            Self::PathComplexity => "unquoted path complexity limit",
            Self::PhysicalLines => "physical line limit",
            Self::SourceLineBytes => "source line length limit",
        };
        formatter.write_str(name)
    }
}

#[derive(Default)]
struct ParseBudget {
    files: usize,
    hunks: usize,
    lines: usize,
}

pub(crate) fn parse_pull_request_diff(
    raw: &str,
) -> Result<Vec<PullRequestDiffFile>, DiffParseError> {
    if raw.is_empty() {
        return Ok(Vec::new());
    }

    validate_raw_diff(raw)?;
    let mut budget = ParseBudget::default();
    PatchSet::parse(raw, ParseOptions::gitdiff())
        .map(|file| {
            let file = file.map_err(|error| DiffParseError::InvalidDiff(error.to_string()))?;
            increment_with_limit(&mut budget.files, MAX_FILES, DiffParseLimit::Files)?;
            map_file(file, &mut budget)
        })
        .collect()
}

fn map_file(
    file: FilePatch<'_, str>,
    budget: &mut ParseBudget,
) -> Result<PullRequestDiffFile, DiffParseError> {
    let old_mode = file.old_mode().copied().map(map_mode);
    let new_mode = file.new_mode().copied().map(map_mode);
    let operation = map_operation(file.operation(), old_mode, new_mode)?;
    let mut additions = 0;
    let mut deletions = 0;

    let content = match file.patch() {
        PatchKind::Binary(_) => PullRequestDiffContent::Binary,
        PatchKind::Text(patch) => {
            validate_text_paths(&operation, patch)?;
            let hunks = patch
                .hunks()
                .iter()
                .map(|hunk| map_hunk(hunk, &mut additions, &mut deletions, budget))
                .collect::<Result<Vec<_>, _>>()?;
            PullRequestDiffContent::Text { hunks }
        }
    };

    Ok(PullRequestDiffFile {
        additions,
        content,
        deletions,
        operation,
    })
}

fn validate_text_paths(
    operation: &PullRequestDiffFileOperation,
    patch: &diffy::Patch<'_, str>,
) -> Result<(), DiffParseError> {
    if patch.hunks().is_empty() {
        return Ok(());
    }
    let patch_old_path = normalize_patch_path(patch.original(), "a/");
    let patch_new_path = normalize_patch_path(patch.modified(), "b/");
    let paths_match = match operation {
        PullRequestDiffFileOperation::Added { path, .. } => {
            patch_old_path.is_none() && patch_new_path == Some(path.as_str())
        }
        PullRequestDiffFileOperation::Deleted { path, .. } => {
            patch_old_path == Some(path.as_str()) && patch_new_path.is_none()
        }
        PullRequestDiffFileOperation::Modified { path, .. } => {
            patch_old_path == Some(path.as_str()) && patch_new_path == Some(path.as_str())
        }
        PullRequestDiffFileOperation::Renamed {
            old_path, new_path, ..
        }
        | PullRequestDiffFileOperation::Copied {
            old_path, new_path, ..
        } => patch_old_path == Some(old_path.as_str()) && patch_new_path == Some(new_path.as_str()),
    };
    if !paths_match {
        return Err(DiffParseError::InvalidDiff(
            "file operation metadata does not match text paths".to_string(),
        ));
    }
    Ok(())
}

fn normalize_patch_path<'a>(path: Option<&'a str>, prefix: &str) -> Option<&'a str> {
    path.filter(|path| *path != "/dev/null")
        .map(|path| path.strip_prefix(prefix).unwrap_or(path))
}

fn map_operation(
    operation: &FileOperation<'_, str>,
    old_mode: Option<PullRequestDiffFileMode>,
    new_mode: Option<PullRequestDiffFileMode>,
) -> Result<PullRequestDiffFileOperation, DiffParseError> {
    match operation {
        FileOperation::Create(path) => match (old_mode, new_mode) {
            (None, Some(mode)) => Ok(PullRequestDiffFileOperation::Added {
                path: owned_path(path, "b/")?,
                mode,
            }),
            _ => inconsistent_mode_headers(),
        },
        FileOperation::Delete(path) => match (old_mode, new_mode) {
            (Some(mode), None) => Ok(PullRequestDiffFileOperation::Deleted {
                path: owned_path(path, "a/")?,
                mode,
            }),
            _ => inconsistent_mode_headers(),
        },
        FileOperation::Modify { original, modified } => {
            let old_path = checked_path(original, "a/")?;
            let new_path = checked_path(modified, "b/")?;
            if old_path != new_path {
                return Err(DiffParseError::InvalidDiff(
                    "different paths require explicit rename or copy metadata".to_string(),
                ));
            }
            Ok(PullRequestDiffFileOperation::Modified {
                path: old_path.to_owned(),
                mode_change: map_mode_change(old_mode, new_mode)?,
            })
        }
        FileOperation::Rename { from, to } => Ok(PullRequestDiffFileOperation::Renamed {
            old_path: owned_path(from, "")?,
            new_path: owned_path(to, "")?,
            mode_change: map_mode_change(old_mode, new_mode)?,
        }),
        FileOperation::Copy { from, to } => Ok(PullRequestDiffFileOperation::Copied {
            old_path: owned_path(from, "")?,
            new_path: owned_path(to, "")?,
            mode_change: map_mode_change(old_mode, new_mode)?,
        }),
    }
}

fn map_mode_change(
    old_mode: Option<PullRequestDiffFileMode>,
    new_mode: Option<PullRequestDiffFileMode>,
) -> Result<PullRequestDiffModeChange, DiffParseError> {
    match (old_mode, new_mode) {
        (None, None) => Ok(PullRequestDiffModeChange::Unchanged),
        (Some(old_mode), Some(new_mode)) => {
            Ok(PullRequestDiffModeChange::Changed { old_mode, new_mode })
        }
        _ => inconsistent_mode_headers(),
    }
}

fn inconsistent_mode_headers<T>() -> Result<T, DiffParseError> {
    Err(DiffParseError::InvalidDiff(
        "file operation has inconsistent mode headers".to_string(),
    ))
}

fn owned_path(path: &str, prefix: &str) -> Result<String, DiffParseError> {
    Ok(checked_path(path, prefix)?.to_owned())
}

fn checked_path<'a>(path: &'a str, prefix: &str) -> Result<&'a str, DiffParseError> {
    let path = path.strip_prefix(prefix).unwrap_or(path);
    if path.len() > MAX_PATH_BYTES {
        return Err(DiffParseError::LimitExceeded(DiffParseLimit::PathBytes));
    }
    Ok(path)
}

fn map_mode(mode: FileMode) -> PullRequestDiffFileMode {
    match mode {
        FileMode::Regular => PullRequestDiffFileMode::Regular,
        FileMode::Executable => PullRequestDiffFileMode::Executable,
        FileMode::Symlink => PullRequestDiffFileMode::Symlink,
        FileMode::Gitlink => PullRequestDiffFileMode::Gitlink,
    }
}

fn map_hunk(
    hunk: &Hunk<'_, str>,
    additions: &mut u32,
    deletions: &mut u32,
    budget: &mut ParseBudget,
) -> Result<PullRequestDiffHunk, DiffParseError> {
    let old_range = hunk.old_range();
    let new_range = hunk.new_range();
    let old_start = to_u32(old_range.start())?;
    let new_start = to_u32(new_range.start())?;
    let old_count = to_u32(old_range.len())?;
    let new_count = to_u32(new_range.len())?;
    let mut old_line = u64::from(old_start);
    let mut new_line = u64::from(new_start);
    let mut lines = Vec::with_capacity(hunk.lines().len());
    increment_with_limit(&mut budget.hunks, MAX_HUNKS, DiffParseLimit::Hunks)?;

    for line in hunk.lines() {
        increment_with_limit(&mut budget.lines, MAX_SEMANTIC_LINES, DiffParseLimit::Lines)?;
        let (content, kind, mapped_old_line, mapped_new_line) = match line {
            Line::Context(content) => {
                let mapped = (
                    content,
                    PullRequestDiffLineKind::Context,
                    Some(to_u32(old_line)?),
                    Some(to_u32(new_line)?),
                );
                old_line += 1;
                new_line += 1;
                mapped
            }
            Line::Delete(content) => {
                let mapped = (
                    content,
                    PullRequestDiffLineKind::Deletion,
                    Some(to_u32(old_line)?),
                    None,
                );
                old_line += 1;
                *deletions = next_line_number(*deletions)?;
                mapped
            }
            Line::Insert(content) => {
                let mapped = (
                    content,
                    PullRequestDiffLineKind::Addition,
                    None,
                    Some(to_u32(new_line)?),
                );
                new_line += 1;
                *additions = next_line_number(*additions)?;
                mapped
            }
        };
        let (content, missing_newline) = normalize_line(content)?;
        lines.push(PullRequestDiffLine {
            content,
            kind,
            missing_newline,
            new_line: mapped_new_line,
            old_line: mapped_old_line,
        });
    }

    Ok(PullRequestDiffHunk {
        context: hunk.function_context().and_then(normalize_context),
        lines,
        new_count,
        new_start,
        old_count,
        old_start,
    })
}

fn next_line_number(line: u32) -> Result<u32, DiffParseError> {
    line.checked_add(1).ok_or(DiffParseError::NumberOutOfRange)
}

fn normalize_line(content: &str) -> Result<(String, bool), DiffParseError> {
    let (content, missing_newline) = match content.strip_suffix('\n') {
        Some(content) => (content, false),
        None => (content, true),
    };
    if content.len() > MAX_SOURCE_LINE_BYTES {
        return Err(DiffParseError::LimitExceeded(
            DiffParseLimit::SourceLineBytes,
        ));
    }
    Ok((content.to_owned(), missing_newline))
}

fn normalize_context(context: &str) -> Option<String> {
    let context = context.strip_suffix('\n').unwrap_or(context);
    (!context.is_empty()).then(|| context.to_owned())
}

fn validate_raw_diff(raw: &str) -> Result<(), DiffParseError> {
    if raw.len() > MAX_DIFF_BYTES {
        return Err(DiffParseError::LimitExceeded(DiffParseLimit::Bytes));
    }
    if raw.contains('\r') {
        return Err(DiffParseError::InvalidDiff(
            "only LF line endings are supported".to_string(),
        ));
    }

    let physical_lines = raw
        .as_bytes()
        .iter()
        .filter(|byte| **byte == b'\n')
        .count()
        .saturating_add(usize::from(!raw.ends_with('\n')));
    if physical_lines > MAX_PHYSICAL_LINES {
        return Err(DiffParseError::LimitExceeded(DiffParseLimit::PhysicalLines));
    }
    if raw
        .split('\n')
        .any(|line| line.len() > MAX_SOURCE_LINE_BYTES + 1)
    {
        return Err(DiffParseError::LimitExceeded(
            DiffParseLimit::SourceLineBytes,
        ));
    }

    validate_git_diff_structure(raw)
}

#[derive(Default, PartialEq, Eq)]
enum SectionPhase {
    #[default]
    ExtendedHeaders,
    OldTextPath,
    TextReady,
    Hunks,
    Sealed,
}

#[derive(Default)]
struct SectionValidation {
    binary: bool,
    copy_from: bool,
    copy_to: bool,
    deleted_file_mode: bool,
    new_file_mode: bool,
    new_mode: bool,
    new_path_header: bool,
    old_mode: bool,
    old_path_header: bool,
    phase: SectionPhase,
    rename_from: bool,
    rename_to: bool,
    saw_hunk: bool,
}

impl SectionValidation {
    fn finish(&self) -> Result<(), DiffParseError> {
        require_pair(self.rename_from, self.rename_to, "rename")?;
        require_pair(self.copy_from, self.copy_to, "copy")?;
        require_pair(self.old_mode, self.new_mode, "mode change")?;
        require_pair(self.old_path_header, self.new_path_header, "text path")?;

        let operation_count = usize::from(self.new_file_mode)
            + usize::from(self.deleted_file_mode)
            + usize::from(self.rename_from)
            + usize::from(self.copy_from);
        if operation_count > 1 {
            return invalid_structure("git diff section has conflicting operations");
        }
        if self.binary && self.saw_hunk {
            return invalid_structure("git diff section mixes binary and text content");
        }
        if self.binary && self.old_path_header {
            return invalid_structure("binary git diff section has text path headers");
        }
        if self.old_path_header && !self.saw_hunk {
            return invalid_structure("text path headers have no hunks");
        }
        if (self.new_file_mode || self.deleted_file_mode) && self.old_mode {
            return invalid_structure("create or delete operation has mode-change headers");
        }
        if !(self.binary
            || self.saw_hunk
            || self.new_file_mode
            || self.deleted_file_mode
            || self.rename_from
            || self.copy_from
            || self.old_mode)
        {
            return invalid_structure("git diff section has no patch content");
        }
        Ok(())
    }
}

enum BinaryValidationState {
    Format { blocks_left: u8 },
    Data { blocks_left: u8, saw_data: bool },
}

fn validate_git_diff_structure(raw: &str) -> Result<(), DiffParseError> {
    let mut section: Option<SectionValidation> = None;
    let mut hunk_remaining: Option<(usize, usize)> = None;
    let mut binary_state: Option<BinaryValidationState> = None;
    let mut allow_no_newline_marker = false;
    let mut file_count = 0_usize;
    let mut path_complexity = 0_usize;

    for line in raw.split('\n') {
        if let Some(state) = binary_state.take() {
            binary_state = validate_binary_line(state, line)?;
            continue;
        }

        if line == "\\ No newline at end of file" {
            if !allow_no_newline_marker {
                return invalid_structure("newline marker does not follow a source line");
            }
            allow_no_newline_marker = false;
            continue;
        }

        if let Some((old_remaining, new_remaining)) = hunk_remaining.as_mut() {
            if *old_remaining == 0 && *new_remaining == 0 {
                hunk_remaining = None;
            } else {
                match line.as_bytes().first() {
                    Some(b' ') if *old_remaining > 0 && *new_remaining > 0 => {
                        *old_remaining -= 1;
                        *new_remaining -= 1;
                    }
                    Some(b'-') if *old_remaining > 0 => *old_remaining -= 1,
                    Some(b'+') if *new_remaining > 0 => *new_remaining -= 1,
                    _ => return invalid_structure("hunk lines do not match declared ranges"),
                }
                allow_no_newline_marker = true;
                continue;
            }
        }
        allow_no_newline_marker = false;

        if line.starts_with("diff --git ") {
            if let Some(previous) = section.take() {
                previous.finish()?;
            }
            validate_path_header(line, &mut path_complexity)?;
            increment_with_limit(&mut file_count, MAX_FILES, DiffParseLimit::Files)?;
            section = Some(SectionValidation::default());
            continue;
        }

        let Some(section) = section.as_mut() else {
            return invalid_structure("git diff must begin with a diff --git header");
        };

        if line.starts_with("diff --") {
            return invalid_structure("unsupported git diff header");
        }
        if line.is_empty() {
            match section.phase {
                SectionPhase::OldTextPath | SectionPhase::TextReady => {
                    return invalid_structure("blank line interrupts text patch headers");
                }
                SectionPhase::ExtendedHeaders | SectionPhase::Hunks | SectionPhase::Sealed => {
                    section.phase = SectionPhase::Sealed
                }
            }
            continue;
        }
        if line.starts_with("@@") {
            if line.starts_with("@@@") {
                return invalid_structure("combined merge hunks are unsupported");
            }
            if !matches!(section.phase, SectionPhase::TextReady | SectionPhase::Hunks) {
                return invalid_structure("hunk is out of order or has no text paths");
            }
            let counts = parse_hunk_counts(line)?;
            section.saw_hunk = true;
            section.phase = SectionPhase::Hunks;
            hunk_remaining = Some(counts);
            continue;
        }
        if line.starts_with("+++ ") {
            if section.phase != SectionPhase::OldTextPath {
                return invalid_structure("new text path does not follow old text path");
            }
            validate_path_header(line, &mut path_complexity)?;
            set_once(&mut section.new_path_header, "new text path")?;
            section.phase = SectionPhase::TextReady;
            continue;
        }
        if section.phase != SectionPhase::ExtendedHeaders {
            return invalid_structure("git diff headers are out of order");
        }

        if line.starts_with("index ")
            || line.starts_with("similarity index ")
            || line.starts_with("dissimilarity index ")
        {
            continue;
        }
        if line.starts_with("--- ") {
            validate_path_header(line, &mut path_complexity)?;
            set_once(&mut section.old_path_header, "old text path")?;
            section.phase = SectionPhase::OldTextPath;
            continue;
        }
        if line == "GIT binary patch" {
            set_once(&mut section.binary, "binary patch")?;
            section.phase = SectionPhase::Sealed;
            binary_state = Some(BinaryValidationState::Format { blocks_left: 2 });
            continue;
        }
        if line.starts_with("Binary files ") {
            validate_path_header(line, &mut path_complexity)?;
            set_once(&mut section.binary, "binary marker")?;
            section.phase = SectionPhase::Sealed;
            continue;
        }

        let flag = if line.starts_with("old mode ") {
            &mut section.old_mode
        } else if line.starts_with("new mode ") {
            &mut section.new_mode
        } else if line.starts_with("new file mode ") {
            &mut section.new_file_mode
        } else if line.starts_with("deleted file mode ") {
            &mut section.deleted_file_mode
        } else if line.starts_with("rename from ") {
            validate_path_header(line, &mut path_complexity)?;
            &mut section.rename_from
        } else if line.starts_with("rename to ") {
            validate_path_header(line, &mut path_complexity)?;
            &mut section.rename_to
        } else if line.starts_with("copy from ") {
            validate_path_header(line, &mut path_complexity)?;
            &mut section.copy_from
        } else if line.starts_with("copy to ") {
            validate_path_header(line, &mut path_complexity)?;
            &mut section.copy_to
        } else {
            return invalid_structure("unexpected content in git diff headers");
        };
        set_once(flag, "extended header")?;
    }

    if binary_state.is_some() {
        return invalid_structure("binary patch is missing a block or terminator");
    }
    if hunk_remaining.is_some_and(|(old, new)| old != 0 || new != 0) {
        return invalid_structure("hunk lines do not match declared ranges");
    }
    section
        .ok_or_else(|| DiffParseError::InvalidDiff("git diff has no file sections".to_string()))?
        .finish()
}

fn validate_binary_line(
    state: BinaryValidationState,
    line: &str,
) -> Result<Option<BinaryValidationState>, DiffParseError> {
    match state {
        BinaryValidationState::Format { blocks_left } => {
            let Some((kind, size)) = line.split_once(' ') else {
                return invalid_structure("binary patch block has no format header");
            };
            if !matches!(kind, "literal" | "delta") || size.parse::<u64>().is_err() {
                return invalid_structure("binary patch block has an invalid format header");
            }
            Ok(Some(BinaryValidationState::Data {
                blocks_left,
                saw_data: false,
            }))
        }
        BinaryValidationState::Data {
            blocks_left,
            saw_data,
        } => {
            if line.is_empty() {
                if !saw_data {
                    return invalid_structure("binary patch block has no encoded data");
                }
                if blocks_left == 1 {
                    Ok(None)
                } else {
                    Ok(Some(BinaryValidationState::Format {
                        blocks_left: blocks_left - 1,
                    }))
                }
            } else if line.starts_with("diff --git ")
                || line.bytes().any(|byte| byte.is_ascii_whitespace())
            {
                invalid_structure("binary patch block has invalid encoded data")
            } else {
                Ok(Some(BinaryValidationState::Data {
                    blocks_left,
                    saw_data: true,
                }))
            }
        }
    }
}

fn parse_hunk_counts(header: &str) -> Result<(usize, usize), DiffParseError> {
    let body = header
        .strip_prefix("@@ -")
        .ok_or_else(|| DiffParseError::InvalidDiff("invalid hunk header".to_string()))?;
    let (old_range, body) = body
        .split_once(" +")
        .ok_or_else(|| DiffParseError::InvalidDiff("invalid hunk header".to_string()))?;
    let (new_range, _) = body
        .split_once(" @@")
        .ok_or_else(|| DiffParseError::InvalidDiff("invalid hunk header".to_string()))?;
    Ok((parse_range_count(old_range)?, parse_range_count(new_range)?))
}

fn parse_range_count(range: &str) -> Result<usize, DiffParseError> {
    let (start, count) = range.split_once(',').unwrap_or((range, "1"));
    start
        .parse::<usize>()
        .map_err(|_| DiffParseError::InvalidDiff("invalid hunk range".to_string()))?;
    count
        .parse::<usize>()
        .map_err(|_| DiffParseError::InvalidDiff("invalid hunk range".to_string()))
}

fn validate_path_header(line: &str, total_complexity: &mut usize) -> Result<(), DiffParseError> {
    if let Some(paths) = line.strip_prefix("diff --git ") {
        let raw_limit =
            if paths.starts_with('"') || paths.ends_with('"') {
                MAX_PATH_BYTES * 8
            } else {
                let spaces = paths.bytes().filter(|byte| *byte == b' ').count();
                if spaces > MAX_UNQUOTED_PATH_SPACES {
                    return Err(DiffParseError::LimitExceeded(
                        DiffParseLimit::PathComplexity,
                    ));
                }
                let complexity =
                    paths
                        .len()
                        .checked_mul(spaces)
                        .ok_or(DiffParseError::LimitExceeded(
                            DiffParseLimit::PathComplexity,
                        ))?;
                *total_complexity = total_complexity.checked_add(complexity).ok_or(
                    DiffParseError::LimitExceeded(DiffParseLimit::PathComplexity),
                )?;
                ensure_at_most(
                    *total_complexity,
                    MAX_PATH_COMPLEXITY,
                    DiffParseLimit::PathComplexity,
                )?;
                MAX_PATH_BYTES * 2 + 3
            };
        ensure_at_most(paths.len(), raw_limit, DiffParseLimit::PathBytes)?;
    } else if let Some(path) = line
        .strip_prefix("--- ")
        .or_else(|| line.strip_prefix("+++ "))
        .or_else(|| line.strip_prefix("rename from "))
        .or_else(|| line.strip_prefix("rename to "))
        .or_else(|| line.strip_prefix("copy from "))
        .or_else(|| line.strip_prefix("copy to "))
    {
        ensure_at_most(path.len(), MAX_PATH_BYTES * 4, DiffParseLimit::PathBytes)?;
    } else if let Some(paths) = line.strip_prefix("Binary files ") {
        ensure_at_most(paths.len(), MAX_PATH_BYTES * 8, DiffParseLimit::PathBytes)?;
    }
    Ok(())
}

fn set_once(flag: &mut bool, name: &str) -> Result<(), DiffParseError> {
    if *flag {
        return invalid_structure(&format!("duplicate {name}"));
    }
    *flag = true;
    Ok(())
}

fn require_pair(first: bool, second: bool, name: &str) -> Result<(), DiffParseError> {
    if first != second {
        return invalid_structure(&format!("incomplete {name} headers"));
    }
    Ok(())
}

fn invalid_structure<T>(message: &str) -> Result<T, DiffParseError> {
    Err(DiffParseError::InvalidDiff(message.to_string()))
}

fn ensure_at_most(value: usize, limit: usize, kind: DiffParseLimit) -> Result<(), DiffParseError> {
    if value > limit {
        return Err(DiffParseError::LimitExceeded(kind));
    }
    Ok(())
}

fn increment_with_limit(
    value: &mut usize,
    limit: usize,
    kind: DiffParseLimit,
) -> Result<(), DiffParseError> {
    *value = value
        .checked_add(1)
        .ok_or(DiffParseError::LimitExceeded(kind))?;
    if *value > limit {
        return Err(DiffParseError::LimitExceeded(kind));
    }
    Ok(())
}

fn to_u32<T>(value: T) -> Result<u32, DiffParseError>
where
    T: TryInto<u32>,
{
    value
        .try_into()
        .map_err(|_| DiffParseError::NumberOutOfRange)
}

#[cfg(test)]
mod tests {
    use std::fmt::Write;

    use super::{
        ensure_at_most, increment_with_limit, parse_pull_request_diff, DiffParseError,
        DiffParseLimit, PullRequestDiffContent, PullRequestDiffFileMode,
        PullRequestDiffFileOperation, PullRequestDiffLineKind, PullRequestDiffModeChange,
        MAX_PATH_BYTES, MAX_PHYSICAL_LINES, MAX_SOURCE_LINE_BYTES, MAX_UNQUOTED_PATH_SPACES,
    };

    const ADDED_FILE: &str = include_str!("../tests/fixtures/pull_request_diffs/added-file.diff");
    const BINARY_FILES: &str =
        include_str!("../tests/fixtures/pull_request_diffs/binary-files.diff");
    const COPIED_FILE: &str = include_str!("../tests/fixtures/pull_request_diffs/copied-file.diff");
    const DELETED_FILE: &str =
        include_str!("../tests/fixtures/pull_request_diffs/deleted-file.diff");
    const HUNKLESS_FILES: &str =
        include_str!("../tests/fixtures/pull_request_diffs/hunkless-files.diff");
    const LONG_LINE: &str = include_str!("../tests/fixtures/pull_request_diffs/long-line.diff");
    const MALFORMED: &str = include_str!("../tests/fixtures/pull_request_diffs/malformed.diff");
    const MISSING_NEWLINE: &str =
        include_str!("../tests/fixtures/pull_request_diffs/missing-newline.diff");
    const MODE_ONLY: &str = include_str!("../tests/fixtures/pull_request_diffs/mode-only.diff");
    const MULTI_FILE: &str = include_str!("../tests/fixtures/pull_request_diffs/multi-file.diff");
    const QUOTED_PATHS: &str =
        include_str!("../tests/fixtures/pull_request_diffs/quoted-paths.diff");
    const RENAMED_FILE: &str =
        include_str!("../tests/fixtures/pull_request_diffs/renamed-file.diff");

    const VALID_FIXTURES: &[(&str, &str)] = &[
        ("added-file.diff", ADDED_FILE),
        ("binary-files.diff", BINARY_FILES),
        ("copied-file.diff", COPIED_FILE),
        ("deleted-file.diff", DELETED_FILE),
        ("hunkless-files.diff", HUNKLESS_FILES),
        ("long-line.diff", LONG_LINE),
        ("missing-newline.diff", MISSING_NEWLINE),
        ("mode-only.diff", MODE_ONLY),
        ("multi-file.diff", MULTI_FILE),
        ("quoted-paths.diff", QUOTED_PATHS),
        ("renamed-file.diff", RENAMED_FILE),
    ];

    fn text_hunks(file: &super::PullRequestDiffFile) -> &[super::PullRequestDiffHunk] {
        match &file.content {
            PullRequestDiffContent::Text { hunks } => hunks,
            PullRequestDiffContent::Binary => panic!("expected text diff"),
        }
    }

    fn generated_text_diff(
        file_count: usize,
        hunks_per_file: usize,
        changes_per_side: usize,
    ) -> String {
        let mut raw = String::new();
        for file_index in 0..file_count {
            writeln!(
                raw,
                "diff --git a/file-{file_index}.txt b/file-{file_index}.txt"
            )
            .expect("diff header should write");
            raw.push_str("index 1111111..2222222 100644\n");
            writeln!(raw, "--- a/file-{file_index}.txt").expect("old path should write");
            writeln!(raw, "+++ b/file-{file_index}.txt").expect("new path should write");
            for hunk_index in 0..hunks_per_file {
                let start = hunk_index * changes_per_side + 1;
                writeln!(
                    raw,
                    "@@ -{start},{changes_per_side} +{start},{changes_per_side} @@"
                )
                .expect("hunk header should write");
                for line_index in 0..changes_per_side {
                    writeln!(raw, "-old-{file_index}-{hunk_index}-{line_index}")
                        .expect("deletion should write");
                }
                for line_index in 0..changes_per_side {
                    writeln!(raw, "+new-{file_index}-{hunk_index}-{line_index}")
                        .expect("addition should write");
                }
            }
        }
        raw
    }

    #[test]
    fn parse_pull_request_diff_parses_every_valid_fixture() {
        for (name, raw) in VALID_FIXTURES {
            let parsed = parse_pull_request_diff(raw)
                .unwrap_or_else(|error| panic!("{name} should parse: {error}"));
            assert!(!parsed.is_empty(), "{name} should contain a file");
        }
    }

    #[test]
    fn parse_pull_request_diff_accepts_an_empty_diff() {
        assert_eq!(parse_pull_request_diff(""), Ok(Vec::new()));
    }

    #[test]
    fn parse_pull_request_diff_maps_hunks_lines_and_totals() {
        let files = parse_pull_request_diff(MULTI_FILE).expect("multi-file diff should parse");

        assert_eq!(files.len(), 2);
        let file = &files[0];
        assert_eq!(
            file.operation,
            PullRequestDiffFileOperation::Modified {
                path: "src/math.rs".to_string(),
                mode_change: PullRequestDiffModeChange::Unchanged,
            }
        );
        assert_eq!(file.additions, 3);
        assert_eq!(file.deletions, 2);

        let hunks = text_hunks(file);
        assert_eq!(hunks.len(), 2);
        assert_eq!(hunks[0].old_start, 1);
        assert_eq!(hunks[0].old_count, 3);
        assert_eq!(hunks[0].new_start, 1);
        assert_eq!(hunks[0].new_count, 4);
        assert_eq!(
            hunks[0].context.as_deref(),
            Some("pub fn add(left: u32, right: u32) -> u32 {")
        );
        assert_eq!(hunks[0].lines[0].kind, PullRequestDiffLineKind::Context);
        assert_eq!(hunks[0].lines[0].old_line, Some(1));
        assert_eq!(hunks[0].lines[0].new_line, Some(1));
        assert_eq!(hunks[0].lines[1].kind, PullRequestDiffLineKind::Deletion);
        assert_eq!(hunks[0].lines[1].old_line, Some(2));
        assert_eq!(hunks[0].lines[1].new_line, None);
        assert_eq!(hunks[0].lines[2].kind, PullRequestDiffLineKind::Addition);
        assert_eq!(hunks[0].lines[2].old_line, None);
        assert_eq!(hunks[0].lines[2].new_line, Some(2));
        assert_eq!(hunks[0].lines[4].content, "");
        assert!(!hunks[0].lines[4].missing_newline);
        assert_eq!(hunks[1].lines[0].old_line, Some(5));
        assert_eq!(hunks[1].lines[0].new_line, Some(6));
    }

    #[test]
    fn parse_pull_request_diff_maps_file_operations_and_explicit_modes() {
        let added = parse_pull_request_diff(ADDED_FILE).expect("added file should parse");
        assert_eq!(
            added[0].operation,
            PullRequestDiffFileOperation::Added {
                path: "src/greeting.rs".to_string(),
                mode: PullRequestDiffFileMode::Regular,
            }
        );
        let added_lines = &text_hunks(&added[0])[0].lines;
        assert_eq!(added_lines[0].old_line, None);
        assert_eq!(added_lines[0].new_line, Some(1));
        assert_eq!(added_lines[3].new_line, Some(4));

        let deleted = parse_pull_request_diff(DELETED_FILE).expect("deleted file should parse");
        assert_eq!(
            deleted[0].operation,
            PullRequestDiffFileOperation::Deleted {
                path: "src/legacy.rs".to_string(),
                mode: PullRequestDiffFileMode::Regular,
            }
        );
        let deleted_lines = &text_hunks(&deleted[0])[0].lines;
        assert_eq!(deleted_lines[0].old_line, Some(1));
        assert_eq!(deleted_lines[0].new_line, None);
        assert_eq!(deleted_lines[3].old_line, Some(4));

        let renamed = parse_pull_request_diff(RENAMED_FILE).expect("renamed file should parse");
        assert_eq!(
            renamed[0].operation,
            PullRequestDiffFileOperation::Renamed {
                old_path: "docs/old-name.md".to_string(),
                new_path: "docs/new-name.md".to_string(),
                mode_change: PullRequestDiffModeChange::Unchanged,
            }
        );

        let copied = parse_pull_request_diff(COPIED_FILE).expect("copied file should parse");
        assert_eq!(
            copied[0].operation,
            PullRequestDiffFileOperation::Copied {
                old_path: "config/example.toml".to_string(),
                new_path: "config/development.toml".to_string(),
                mode_change: PullRequestDiffModeChange::Unchanged,
            }
        );

        let mode_only = parse_pull_request_diff(MODE_ONLY).expect("mode-only file should parse");
        assert_eq!(
            mode_only[0].operation,
            PullRequestDiffFileOperation::Modified {
                path: "scripts/check.sh".to_string(),
                mode_change: PullRequestDiffModeChange::Changed {
                    old_mode: PullRequestDiffFileMode::Regular,
                    new_mode: PullRequestDiffFileMode::Executable,
                },
            }
        );
        assert!(text_hunks(&mode_only[0]).is_empty());
    }

    #[test]
    fn parse_pull_request_diff_maps_symlink_and_gitlink_modes() {
        let raw = "diff --git a/path b/path\nold mode 120000\nnew mode 160000\n";
        let files = parse_pull_request_diff(raw).expect("type change should parse");

        assert_eq!(
            files[0].operation,
            PullRequestDiffFileOperation::Modified {
                path: "path".to_string(),
                mode_change: PullRequestDiffModeChange::Changed {
                    old_mode: PullRequestDiffFileMode::Symlink,
                    new_mode: PullRequestDiffFileMode::Gitlink,
                },
            }
        );
        assert!(text_hunks(&files[0]).is_empty());
    }

    #[test]
    fn parse_pull_request_diff_maps_hunkless_operations() {
        let files = parse_pull_request_diff(HUNKLESS_FILES).expect("hunkless files should parse");

        assert_eq!(files.len(), 4);
        assert!(matches!(
            files[0].operation,
            PullRequestDiffFileOperation::Added { .. }
        ));
        assert!(matches!(
            files[1].operation,
            PullRequestDiffFileOperation::Deleted { .. }
        ));
        assert!(matches!(
            files[2].operation,
            PullRequestDiffFileOperation::Renamed { .. }
        ));
        assert!(matches!(
            files[3].operation,
            PullRequestDiffFileOperation::Copied { .. }
        ));
        assert!(files.iter().all(|file| text_hunks(file).is_empty()));
    }

    #[test]
    fn parse_pull_request_diff_maps_binary_without_retaining_payloads() {
        let files = parse_pull_request_diff(BINARY_FILES).expect("binary files should parse");

        assert_eq!(files.len(), 3);
        assert!(files
            .iter()
            .all(|file| file.content == PullRequestDiffContent::Binary));
        assert!(matches!(
            files[0].operation,
            PullRequestDiffFileOperation::Modified { .. }
        ));
        assert!(matches!(
            files[1].operation,
            PullRequestDiffFileOperation::Added { .. }
        ));
        assert!(matches!(
            files[2].operation,
            PullRequestDiffFileOperation::Added { .. }
        ));
        assert!(files
            .iter()
            .all(|file| file.additions == 0 && file.deletions == 0));
    }

    #[test]
    fn parse_pull_request_diff_decodes_git_quoted_paths() {
        let files = parse_pull_request_diff(QUOTED_PATHS).expect("quoted paths should parse");

        assert!(matches!(
            &files[0].operation,
            PullRequestDiffFileOperation::Modified { path, .. } if path == "docs/setup guide.md"
        ));
        assert!(matches!(
            &files[1].operation,
            PullRequestDiffFileOperation::Modified { path, .. } if path == "docs/caf\u{e9}.txt"
        ));
        assert!(matches!(
            &files[2].operation,
            PullRequestDiffFileOperation::Modified { path, .. }
                if path == "docs/quote\"-backslash\\-tab\t.txt"
        ));
    }

    #[test]
    fn parse_pull_request_diff_preserves_missing_newline_markers() {
        let files =
            parse_pull_request_diff(MISSING_NEWLINE).expect("missing newlines should parse");

        let both_sides = &text_hunks(&files[0])[0].lines;
        assert!(both_sides[0].missing_newline);
        assert!(both_sides[1].missing_newline);

        let one_side = &text_hunks(&files[1])[0].lines;
        assert!(!one_side[0].missing_newline);
        assert!(one_side[1].missing_newline);

        let context = &text_hunks(&files[2])[0].lines;
        assert_eq!(context[2].kind, PullRequestDiffLineKind::Context);
        assert!(context[2].missing_newline);
    }

    #[test]
    fn parse_pull_request_diff_preserves_long_lines() {
        let files = parse_pull_request_diff(LONG_LINE).expect("long line should parse");
        let lines = &text_hunks(&files[0])[0].lines;

        assert_eq!(text_hunks(&files[0])[0].context, None);
        assert!(lines[1].content.len() > 150);
        assert!(lines[1].content.ends_with("synchronized_at;"));
    }

    #[test]
    fn parse_pull_request_diff_handles_generated_long_lines() {
        let old_line = "a".repeat(64 * 1024);
        let new_line = format!("{}z", "b".repeat(64 * 1024));
        let raw = format!(
            "diff --git a/large.txt b/large.txt\nindex 1111111..2222222 100644\n--- a/large.txt\n+++ b/large.txt\n@@ -1 +1 @@\n-{old_line}\n+{new_line}\n"
        );

        let files = parse_pull_request_diff(&raw).expect("generated long lines should parse");
        let lines = &text_hunks(&files[0])[0].lines;
        assert_eq!(lines[0].content.len(), 64 * 1024);
        assert_eq!(lines[1].content.len(), 64 * 1024 + 1);
    }

    #[test]
    fn parse_pull_request_diff_accepts_the_source_line_byte_boundary() {
        let source = "\t".repeat(MAX_SOURCE_LINE_BYTES);
        let raw = format!(
            "diff --git a/large.txt b/large.txt\nindex 1111111..2222222 100644\n--- a/large.txt\n+++ b/large.txt\n@@ -1 +1 @@\n {source}\n"
        );

        let files = parse_pull_request_diff(&raw).expect("boundary source line should parse");
        assert_eq!(
            text_hunks(&files[0])[0].lines[0].content.len(),
            MAX_SOURCE_LINE_BYTES
        );
    }

    #[test]
    fn parse_pull_request_diff_discards_generated_binary_payloads() {
        let literal_payload = "LcmZQzWcm*P0SW;F\n".repeat(16_384);
        let delta_payload = "ccmV+t0PX*P2!IH%^Z^9`00000v-trB0x!=5aR2}S\n".repeat(16_384);
        let raw = format!(
            "diff --git a/large.bin b/large.bin\nindex 1111111..2222222 100644\nGIT binary patch\nliteral 1048576\n{literal_payload}\ndelta 1048576\n{delta_payload}\n"
        );
        assert!(raw.len() > 500_000);

        let files = parse_pull_request_diff(&raw).expect("generated binary patch should parse");
        drop(raw);
        assert_eq!(files[0].content, PullRequestDiffContent::Binary);
    }

    #[test]
    fn parse_pull_request_diff_handles_100_000_semantic_lines() {
        let one_hunk_raw = generated_text_diff(1, 1, 50_000);
        let one_hunk = parse_pull_request_diff(&one_hunk_raw).expect("one large hunk should parse");
        let lines = &text_hunks(&one_hunk[0])[0].lines;
        assert_eq!(lines.len(), 100_000);
        assert_eq!(one_hunk[0].additions, 50_000);
        assert_eq!(one_hunk[0].deletions, 50_000);
        assert_eq!(lines[49_999].old_line, Some(50_000));
        assert_eq!(lines[99_999].new_line, Some(50_000));
        drop(one_hunk);
        drop(one_hunk_raw);

        let many_files_raw = generated_text_diff(100, 10, 50);
        let many_files =
            parse_pull_request_diff(&many_files_raw).expect("many files and hunks should parse");
        assert_eq!(many_files.len(), 100);
        assert_eq!(
            many_files
                .iter()
                .map(|file| text_hunks(file)
                    .iter()
                    .map(|hunk| hunk.lines.len())
                    .sum::<usize>())
                .sum::<usize>(),
            100_000
        );
        assert_eq!(text_hunks(&many_files[99]).len(), 10);
        assert_eq!(text_hunks(&many_files[99])[9].lines[99].new_line, Some(500));
    }

    #[test]
    fn parse_pull_request_diff_enforces_resource_limits() {
        let too_many_lines = "\n".repeat(MAX_PHYSICAL_LINES + 1);
        assert_eq!(
            parse_pull_request_diff(&too_many_lines),
            Err(DiffParseError::LimitExceeded(DiffParseLimit::PhysicalLines))
        );

        let oversized_line = "a".repeat(MAX_SOURCE_LINE_BYTES + 1);
        let raw = format!(
            "diff --git a/large.txt b/large.txt\n--- a/large.txt\n+++ b/large.txt\n@@ -1 +1 @@\n-{oversized_line}\n+small\n"
        );
        assert_eq!(
            parse_pull_request_diff(&raw),
            Err(DiffParseError::LimitExceeded(
                DiffParseLimit::SourceLineBytes
            ))
        );

        let oversized_path = "p".repeat(MAX_PATH_BYTES + 1);
        let raw = format!(
            "diff --git a/{oversized_path} b/{oversized_path}\nnew file mode 100644\nindex 0000000..e69de29\n"
        );
        assert_eq!(
            parse_pull_request_diff(&raw),
            Err(DiffParseError::LimitExceeded(DiffParseLimit::PathBytes))
        );
    }

    #[test]
    fn parse_pull_request_diff_rejects_skipped_or_partial_sections() {
        let junk_between_files = format!("{LONG_LINE}junk\n{MODE_ONLY}");
        assert!(matches!(
            parse_pull_request_diff(&junk_between_files),
            Err(DiffParseError::InvalidDiff(_))
        ));

        let partial_final_header = format!("{LONG_LINE}diff --git a/partial b/partial\n");
        assert!(matches!(
            parse_pull_request_diff(&partial_final_header),
            Err(DiffParseError::InvalidDiff(_))
        ));

        let combined_before_supported = format!(
            "diff --cc merge.txt\nindex 1111111,2222222..3333333\n--- a/merge.txt\n+++ b/merge.txt\n@@@ -1,1 -1,1 +1,1 @@@\n-old\n++new\n{LONG_LINE}"
        );
        assert!(matches!(
            parse_pull_request_diff(&combined_before_supported),
            Err(DiffParseError::InvalidDiff(_))
        ));

        for extra_line in ["+junk\n", "--- junk\n"] {
            let trailing = format!("{LONG_LINE}{extra_line}");
            assert!(matches!(
                parse_pull_request_diff(&trailing),
                Err(DiffParseError::InvalidDiff(_))
            ));

            let between_files = format!("{LONG_LINE}{extra_line}{MODE_ONLY}");
            assert!(matches!(
                parse_pull_request_diff(&between_files),
                Err(DiffParseError::InvalidDiff(_))
            ));
        }

        let unterminated_binary = format!(
            "diff --git a/data.bin b/data.bin\nindex 1111111..2222222 100644\nGIT binary patch\nliteral 4\nLcmZQzWcm*P0SW;F\n\nliteral 0\nHcmV?d00001\n{MODE_ONLY}"
        );
        assert!(matches!(
            parse_pull_request_diff(&unterminated_binary),
            Err(DiffParseError::InvalidDiff(_))
        ));
    }

    #[test]
    fn parse_pull_request_diff_rejects_implicit_renames_and_out_of_range_numbers() {
        let implicit_rename = "diff --git a/old.txt b/new.txt\n--- a/old.txt\n+++ b/new.txt\n@@ -1 +1 @@\n-old\n+new\n";
        assert!(matches!(
            parse_pull_request_diff(implicit_rename),
            Err(DiffParseError::InvalidDiff(_))
        ));

        let out_of_range = format!(
            "diff --git a/range.txt b/range.txt\n--- a/range.txt\n+++ b/range.txt\n@@ -{},1 +1,1 @@\n-old\n+new\n",
            u64::from(u32::MAX) + 1
        );
        assert_eq!(
            parse_pull_request_diff(&out_of_range),
            Err(DiffParseError::NumberOutOfRange)
        );

        let maximum_line = format!(
            "diff --git a/range.txt b/range.txt\n--- a/range.txt\n+++ b/range.txt\n@@ -{0} +{0} @@\n-old\n+new\n",
            u32::MAX
        );
        let files = parse_pull_request_diff(&maximum_line)
            .expect("the maximum representable line should parse");
        let lines = &text_hunks(&files[0])[0].lines;
        assert_eq!(lines[0].old_line, Some(u32::MAX));
        assert_eq!(lines[1].new_line, Some(u32::MAX));
    }

    #[test]
    fn parse_pull_request_diff_rejects_incomplete_extended_headers() {
        for header in [
            "rename from old.txt\n",
            "copy to copied.txt\n",
            "old mode 100644\n",
        ] {
            let raw = format!("diff --git a/file.txt b/file.txt\n{header}");
            assert!(matches!(
                parse_pull_request_diff(&raw),
                Err(DiffParseError::InvalidDiff(_))
            ));
        }
    }

    #[test]
    fn parse_pull_request_diff_rejects_out_of_order_sections() {
        let blank_before_paths = "diff --git a/file.txt b/file.txt\nindex 1111111..2222222 100644\n\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n";
        let blank_between_hunks = "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n\n@@ -3 +3 @@\n-old-2\n+new-2\n";
        let mode_after_paths = "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\nnew file mode 100644\n@@ -0,0 +1 @@\n+new\n";
        let binary_after_paths = "diff --git a/file.bin b/file.bin\n--- a/file.bin\n+++ b/file.bin\nGIT binary patch\nliteral 0\nHcmV?d00001\n\nliteral 0\nHcmV?d00001\n\n";

        for raw in [
            blank_before_paths,
            blank_between_hunks,
            mode_after_paths,
            binary_after_paths,
        ] {
            assert!(matches!(
                parse_pull_request_diff(raw),
                Err(DiffParseError::InvalidDiff(_))
            ));
        }
    }

    #[test]
    fn parse_pull_request_diff_rejects_inconsistent_operation_metadata() {
        let create_with_ordinary_paths = "diff --git a/file.txt b/file.txt\nnew file mode 100644\n--- a/file.txt\n+++ b/file.txt\n@@ -0,0 +1 @@\n+new\n";
        let create_with_mode_change = "diff --git a/file.txt b/file.txt\nnew file mode 100644\nold mode 100644\nnew mode 100755\n";
        let mismatched_rename = "diff --git a/old.txt b/new.txt\nsimilarity index 50%\nrename from old.txt\nrename to other.txt\n--- a/old.txt\n+++ b/new.txt\n@@ -1 +1 @@\n-old\n+new\n";

        for raw in [
            create_with_ordinary_paths,
            create_with_mode_change,
            mismatched_rename,
        ] {
            assert!(matches!(
                parse_pull_request_diff(raw),
                Err(DiffParseError::InvalidDiff(_))
            ));
        }
    }

    #[test]
    fn parse_pull_request_diff_seals_completed_binary_sections() {
        let payload = "GIT binary patch\nliteral 0\nHcmV?d00001\n\nliteral 0\nHcmV?d00001\n\n";
        let extended_after_binary = format!(
            "diff --git a/file.bin b/file.bin\nindex 1111111..2222222 100644\n{payload}old mode 100644\nnew mode 100755\n"
        );
        let text_paths_after_marker = "diff --git a/file.bin b/file.bin\nBinary files a/file.bin and b/file.bin differ\n--- a/file.bin\n+++ b/file.bin\n";

        for raw in [extended_after_binary.as_str(), text_paths_after_marker] {
            assert!(matches!(
                parse_pull_request_diff(raw),
                Err(DiffParseError::InvalidDiff(_))
            ));
        }
    }

    #[test]
    fn parse_pull_request_diff_rejects_space_heavy_path_headers_before_diffy() {
        let path = "segment ".repeat(MAX_UNQUOTED_PATH_SPACES + 1);
        let raw = format!("diff --git a/{path} b/{path}\nold mode 100644\nnew mode 100755\n");

        assert_eq!(
            parse_pull_request_diff(&raw),
            Err(DiffParseError::LimitExceeded(
                DiffParseLimit::PathComplexity
            ))
        );
    }

    #[test]
    fn parse_pull_request_diff_enforces_aggregate_path_complexity() {
        let padding = "x".repeat(MAX_PATH_BYTES - 2_048);
        let path = format!("{}{padding}", "segment ".repeat(127));
        let mut raw = String::new();
        for file_index in 0..5 {
            writeln!(raw, "diff --git a/{path}{file_index} b/{path}{file_index}")
                .expect("path header should write");
            raw.push_str("old mode 100644\nnew mode 100755\n");
        }

        assert_eq!(
            parse_pull_request_diff(&raw),
            Err(DiffParseError::LimitExceeded(
                DiffParseLimit::PathComplexity
            ))
        );
    }

    #[test]
    fn parse_pull_request_diff_accepts_mixed_quoted_path_headers() {
        let raw = "diff --git a/plain.txt \"b/plain.txt\"\nold mode 100644\nnew mode 100755\n";
        let files = parse_pull_request_diff(raw).expect("mixed quoted paths should parse");

        assert!(matches!(
            &files[0].operation,
            PullRequestDiffFileOperation::Modified { path, .. } if path == "plain.txt"
        ));
    }

    #[test]
    fn parse_limit_helpers_accept_boundaries_and_reject_excess() {
        let limits = [
            DiffParseLimit::Bytes,
            DiffParseLimit::Files,
            DiffParseLimit::Hunks,
            DiffParseLimit::Lines,
            DiffParseLimit::PathBytes,
            DiffParseLimit::PathComplexity,
            DiffParseLimit::PhysicalLines,
            DiffParseLimit::SourceLineBytes,
        ];
        for limit in limits {
            assert_eq!(ensure_at_most(3, 3, limit), Ok(()));
            assert_eq!(
                ensure_at_most(4, 3, limit),
                Err(DiffParseError::LimitExceeded(limit))
            );

            let mut count = 0;
            assert_eq!(increment_with_limit(&mut count, 1, limit), Ok(()));
            assert_eq!(
                increment_with_limit(&mut count, 1, limit),
                Err(DiffParseError::LimitExceeded(limit))
            );
        }
    }

    #[test]
    fn parse_pull_request_diff_returns_typed_errors_without_panicking() {
        assert!(matches!(
            parse_pull_request_diff(MALFORMED),
            Err(DiffParseError::InvalidDiff(_))
        ));
        assert!(matches!(
            parse_pull_request_diff("not a diff"),
            Err(DiffParseError::InvalidDiff(_))
        ));

        let overflow = format!(
            "diff --git a/overflow.txt b/overflow.txt\n--- a/overflow.txt\n+++ b/overflow.txt\n@@ -{},1 +1,1 @@\n-old\n+new\n",
            usize::MAX
        );
        assert!(parse_pull_request_diff(&overflow).is_err());
    }
}
