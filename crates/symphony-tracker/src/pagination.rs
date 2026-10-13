use crate::{PageInfo, TrackerError};
use std::collections::HashSet;

pub(crate) const MAX_PAGES: usize = 50;

/// Validates progress before a page can contribute to a complete collection.
#[derive(Default)]
pub(crate) struct Pagination {
    seen_cursors: HashSet<String>,
    pages: usize,
}

impl Pagination {
    pub(crate) fn advance(
        &mut self,
        page: &PageInfo,
        node_count: usize,
        collection: &str,
    ) -> Result<Option<String>, TrackerError> {
        self.pages += 1;
        let invalid = |reason| TrackerError::Invalid(format!("incomplete {collection}: {reason}"));
        if node_count == 0 && (page.has_next_page || page.end_cursor.is_some()) {
            return Err(invalid("empty page claims a cursor or following page"));
        }
        if let Some(cursor) = &page.end_cursor {
            if cursor.trim().is_empty() || !self.seen_cursors.insert(cursor.clone()) {
                return Err(invalid("empty or repeated endCursor"));
            }
        } else if node_count > 0 || page.has_next_page {
            return Err(invalid("nonempty page omitted endCursor"));
        }
        if page.has_next_page && self.pages >= MAX_PAGES {
            return Err(invalid("pagination limit reached before completion"));
        }
        Ok(page
            .has_next_page
            .then(|| page.end_cursor.clone())
            .flatten())
    }
}
