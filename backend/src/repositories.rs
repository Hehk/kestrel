use url::Url;

#[derive(Debug, Eq, PartialEq)]
pub(crate) struct ParsedRepository {
    pub owner: String,
    pub name: String,
}

pub(crate) fn parse_repository_input(
    input: &str,
) -> Result<ParsedRepository, RepositoryParseError> {
    let input = input.trim();
    if input.is_empty() {
        return Err(RepositoryParseError);
    }

    let path = if input.starts_with("http://") || input.starts_with("https://") {
        parse_github_url(input)?
    } else if input.starts_with("github.com/") {
        parse_github_url(&format!("https://{input}"))?
    } else {
        input.to_string()
    };

    parse_repository_path(&path)
}

fn parse_github_url(input: &str) -> Result<String, RepositoryParseError> {
    let url = Url::parse(input).map_err(|_| RepositoryParseError)?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(RepositoryParseError);
    }
    if url.host_str() != Some("github.com") {
        return Err(RepositoryParseError);
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(RepositoryParseError);
    }

    Ok(url.path().trim_start_matches('/').to_string())
}

fn parse_repository_path(path: &str) -> Result<ParsedRepository, RepositoryParseError> {
    let path = path.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let mut parts = path.split('/');
    let owner = parts.next().ok_or(RepositoryParseError)?;
    let name = parts.next().ok_or(RepositoryParseError)?;
    if parts.next().is_some() || !valid_owner(owner) || !valid_repo_name(name) {
        return Err(RepositoryParseError);
    }

    Ok(ParsedRepository {
        owner: owner.to_lowercase(),
        name: name.to_lowercase(),
    })
}

fn valid_owner(owner: &str) -> bool {
    !owner.is_empty()
        && owner.len() <= 39
        && !owner.starts_with('-')
        && !owner.ends_with('-')
        && owner
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn valid_repo_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) struct RepositoryParseError;

impl std::fmt::Display for RepositoryParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "invalid GitHub repository")
    }
}

impl std::error::Error for RepositoryParseError {}

#[cfg(test)]
mod tests {
    use super::{parse_repository_input, ParsedRepository, RepositoryParseError};

    fn parsed(owner: &str, name: &str) -> ParsedRepository {
        ParsedRepository {
            owner: owner.to_string(),
            name: name.to_string(),
        }
    }

    #[test]
    fn parses_owner_and_repo() {
        assert_eq!(
            parse_repository_input("Kestrel/App"),
            Ok(parsed("kestrel", "app")),
        );
    }

    #[test]
    fn parses_github_urls() {
        assert_eq!(
            parse_repository_input("https://github.com/Kestrel/App"),
            Ok(parsed("kestrel", "app")),
        );
        assert_eq!(
            parse_repository_input("http://github.com/Kestrel/App/"),
            Ok(parsed("kestrel", "app")),
        );
        assert_eq!(
            parse_repository_input("github.com/Kestrel/App"),
            Ok(parsed("kestrel", "app")),
        );
    }

    #[test]
    fn trims_whitespace_and_git_suffix() {
        assert_eq!(
            parse_repository_input(" https://github.com/Kestrel/App.git "),
            Ok(parsed("kestrel", "app")),
        );
    }

    #[test]
    fn allows_common_repository_name_characters() {
        assert_eq!(
            parse_repository_input("Owner/repo.name_with-chars"),
            Ok(parsed("owner", "repo.name_with-chars")),
        );
    }

    #[test]
    fn rejects_invalid_input() {
        for input in [
            "",
            "owner",
            "/owner/name",
            "owner/name/issues",
            "owner/",
            "/name",
            "-owner/name",
            "owner-/name",
            "owner/.name",
            "owner/name with spaces",
            "https://example.com/owner/name",
            "https://github.com/owner/name/issues",
            "https://github.com/owner/name?tab=readme",
        ] {
            assert_eq!(parse_repository_input(input), Err(RepositoryParseError));
        }
    }
}
