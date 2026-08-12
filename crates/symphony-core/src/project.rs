#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinearProjectRef {
    Id(String),
    SlugId(String),
}

impl LinearProjectRef {
    pub fn parse(input: &str) -> Option<Self> {
        let value = input.trim();
        if value.is_empty() {
            return None;
        }
        if let Some(slug_id) = project_slug_id_from_url(value) {
            return Some(Self::SlugId(slug_id.to_string()));
        }
        if let Some(slug_id) = project_slug_id_from_slug(value) {
            return Some(Self::SlugId(slug_id.to_string()));
        }
        Some(Self::Id(value.to_string()))
    }

    pub fn id(&self) -> Option<&str> {
        match self {
            Self::Id(id) => Some(id),
            Self::SlugId(_) => None,
        }
    }

    pub fn slug_id(&self) -> Option<&str> {
        match self {
            Self::Id(_) => None,
            Self::SlugId(slug_id) => Some(slug_id),
        }
    }

    pub fn canonical_key(&self) -> String {
        match self {
            Self::Id(id) => format!("id:{id}"),
            Self::SlugId(slug_id) => format!("slug:{slug_id}"),
        }
    }

    pub fn matches_project(&self, project_id: Option<&str>, project_slug_id: Option<&str>) -> bool {
        match self {
            Self::Id(id) => project_id == Some(id.as_str()),
            Self::SlugId(slug_id) => project_slug_id == Some(slug_id.as_str()),
        }
    }
}

fn project_slug_id_from_url(value: &str) -> Option<&str> {
    let without_suffix = value
        .split(['?', '#'])
        .next()
        .unwrap_or(value)
        .trim_end_matches('/');
    let path = without_suffix
        .strip_prefix("https://linear.app/")
        .or_else(|| without_suffix.strip_prefix("http://linear.app/"))
        .or_else(|| without_suffix.strip_prefix("linear.app/"))?;
    let mut parts = path.split('/');
    while let Some(part) = parts.next() {
        if part == "project" {
            return parts.next().and_then(project_slug_id_from_slug);
        }
    }
    None
}

fn project_slug_id_from_slug(value: &str) -> Option<&str> {
    if value.contains('/') || value.contains("://") || looks_like_uuid(value) {
        return None;
    }
    let slug_id = value
        .rsplit_once('-')
        .map(|(_, suffix)| suffix)
        .unwrap_or(value);
    (slug_id.len() == 12 && slug_id.chars().all(|ch| ch.is_ascii_hexdigit())).then_some(slug_id)
}

fn looks_like_uuid(value: &str) -> bool {
    if value.len() != 36 {
        return false;
    }
    value.chars().enumerate().all(|(idx, ch)| match idx {
        8 | 13 | 18 | 23 => ch == '-',
        _ => ch.is_ascii_hexdigit(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_linear_project_urls_to_slug_ids() {
        let refs = [
            "https://linear.app/optimism-llc/project/phase-1-pre-launch-fixes-00bdaf30dd39/overview",
            "http://linear.app/optimism-llc/project/phase-1-pre-launch-fixes-00bdaf30dd39",
            "linear.app/optimism-llc/project/phase-1-pre-launch-fixes-00bdaf30dd39/updates?x=1",
        ];
        for value in refs {
            let parsed = LinearProjectRef::parse(value).expect("project ref");
            assert_eq!(parsed.slug_id(), Some("00bdaf30dd39"));
        }
    }

    #[test]
    fn keeps_ids_and_plain_slug_ids_distinct() {
        let id = "20dfac82-9e4e-4189-93f9-89c393acbf49";
        assert_eq!(
            LinearProjectRef::parse(id).and_then(|p| p.id().map(str::to_string)),
            Some(id.to_string())
        );

        let slug = "phase-1-pre-launch-fixes-00bdaf30dd39";
        assert_eq!(
            LinearProjectRef::parse(slug).and_then(|p| p.slug_id().map(str::to_string)),
            Some("00bdaf30dd39".to_string())
        );
        assert_eq!(
            LinearProjectRef::parse("00bdaf30dd39").and_then(|p| p.slug_id().map(str::to_string)),
            Some("00bdaf30dd39".to_string())
        );
    }

    #[test]
    fn matches_the_corresponding_issue_project_field() {
        let id_ref = LinearProjectRef::parse("proj-1").unwrap();
        assert!(id_ref.matches_project(Some("proj-1"), Some("phase-00bdaf30dd39")));
        assert!(!id_ref.matches_project(Some("other"), Some("phase-00bdaf30dd39")));

        let slug_ref = LinearProjectRef::parse(
            "https://linear.app/acme/project/phase-1-pre-launch-fixes-00bdaf30dd39/overview",
        )
        .unwrap();
        assert!(slug_ref.matches_project(Some("proj-1"), Some("00bdaf30dd39")));
        assert!(!slug_ref.matches_project(Some("proj-1"), Some("3171f2ba1c70")));
    }
}
