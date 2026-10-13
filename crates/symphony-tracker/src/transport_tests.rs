use super::*;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread::{self, JoinHandle};

/// Exercise the production HTTP/JSON boundary without Linear credentials or writes.
struct Server {
    address: SocketAddr,
    requests: Arc<Mutex<Vec<Value>>>,
    stopping: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Server {
    fn new(responses: Vec<Value>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stopping = Arc::new(AtomicBool::new(false));
        let recorded = Arc::clone(&requests);
        let stop = Arc::clone(&stopping);
        let thread = thread::spawn(move || {
            let mut responses = VecDeque::from(responses);
            for stream in listener.incoming() {
                if stop.load(Ordering::Acquire) {
                    break;
                }
                let mut stream = stream.unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut reader = BufReader::new(&mut stream);
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                assert!(line.starts_with("POST /graphql "));
                let mut length = None;
                loop {
                    line.clear();
                    assert_ne!(reader.read_line(&mut line).unwrap(), 0);
                    if line == "\r\n" {
                        break;
                    }
                    if let Some((name, value)) = line.split_once(':') {
                        if name.eq_ignore_ascii_case("content-length") {
                            length = Some(value.trim().parse::<usize>().unwrap());
                        }
                    }
                }
                let mut body = vec![0; length.expect("request body length")];
                reader.read_exact(&mut body).unwrap();
                recorded
                    .lock()
                    .unwrap()
                    .push(serde_json::from_slice(&body).unwrap());
                let (status, response) = match responses.pop_front() {
                    Some(response) => ("200 OK", response),
                    None => ("400 Bad Request", json!({"error": "unexpected request"})),
                };
                let body = response.to_string();
                write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        Self {
            address,
            requests,
            stopping,
            thread: Some(thread),
        }
    }

    fn tracker(&self) -> LinearTracker {
        let mut tracker = LinearTracker::new(TrackerConfig {
            endpoint: format!("http://{}/graphql", self.address),
            api_key: "test-only".into(),
            team_keys: vec!["ENG".into()],
            active_states: vec!["Todo".into()],
            terminal_states: vec!["Done".into()],
            ..Default::default()
        });
        tracker.request_timeout_ms = 2_000;
        tracker
    }

    fn requests(&self) -> Vec<Value> {
        self.requests.lock().unwrap().clone()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Release);
        let _ = TcpStream::connect(self.address);
        let result = self.thread.take().unwrap().join();
        if !thread::panicking() {
            result.unwrap();
        }
    }
}

fn connection(nodes: Vec<Value>, next: bool, cursor: Option<&str>) -> Value {
    json!({"nodes": nodes, "pageInfo": {"hasNextPage": next, "endCursor": cursor}})
}

fn issue(id: &str) -> Value {
    json!({
        "id": id, "identifier": format!("ENG-{id}"), "title": "Fixture", "priority": 1,
        "state": {"name": "Todo"},
        "labels": connection(vec![], false, None),
        "inverseRelations": connection(vec![], false, None)
    })
}

fn relation(kind: &str, identifier: &str, state: &str) -> Value {
    json!({"type": kind, "issue": {"identifier": identifier, "state": {"type": state}}})
}

fn issues_response(nodes: Vec<Value>, next: bool, cursor: Option<&str>) -> Value {
    json!({"data": {"issues": connection(nodes, next, cursor)}})
}

#[derive(Clone, Copy, Debug)]
enum Fetch {
    Active,
    Terminal,
    Board,
    ById,
    Dispatch,
}

impl Fetch {
    fn initial_response(self, node: Value) -> Value {
        match self {
            Self::ById | Self::Dispatch => json!({"data": {"issue": node}}),
            _ => issues_response(vec![node], false, Some("issues-last")),
        }
    }

    async fn run(self, tracker: &LinearTracker) -> Result<Vec<Issue>, TrackerError> {
        match self {
            Self::Active => tracker.fetch_active().await,
            Self::Terminal => tracker.fetch_terminal().await,
            Self::Board => tracker.fetch_board_issues().await,
            Self::ById => Ok(tracker.fetch_by_id("1").await?.into_iter().collect()),
            Self::Dispatch => Ok(tracker
                .fetch_by_id_for_dispatch("1")
                .await?
                .into_iter()
                .collect()),
        }
    }
}

#[tokio::test]
async fn every_issue_fetch_includes_labels_and_blockers_after_twenty_five() {
    for fetch in [
        Fetch::Active,
        Fetch::Terminal,
        Fetch::Board,
        Fetch::ById,
        Fetch::Dispatch,
    ] {
        let mut node = issue("1");
        node["labels"] = connection(
            (0..25)
                .map(|n| json!({"name": format!("label-{n}")}))
                .collect(),
            true,
            Some("label-25"),
        );
        node["inverseRelations"] = connection(
            (0..25)
                .map(|n| relation("blocks", &format!("OLD-{n}"), "completed"))
                .collect(),
            true,
            Some("relation-25"),
        );
        let continuation = json!({"data": {"issue": {
            "id": "1",
            "labels": connection(vec![json!({"name": "manual-only"})], false, Some("label-26")),
            "inverseRelations": connection(vec![
                relation("blocks", "ENG-BLOCKER", "unstarted"),
                relation("blocks", "CANCELED", "canceled"),
                relation("related", "UNRELATED", "started")
            ], false, Some("relation-28"))
        }}});
        let server = Server::new(vec![fetch.initial_response(node), continuation]);
        let result = fetch.run(&server.tracker()).await.unwrap();
        assert_eq!(result.len(), 1, "{fetch:?}");
        assert_eq!(result[0].labels.len(), 26, "{fetch:?}");
        assert!(result[0].labels.contains(&"manual-only".to_string()));
        assert_eq!(result[0].blockers, ["ENG-BLOCKER"]);
        let requests = server.requests();
        assert_eq!(requests.len(), 2);
        assert!(requests[1]["query"]
            .as_str()
            .unwrap()
            .contains("SymphonyIssueCollections"));
        assert_eq!(
            requests[1]["variables"],
            json!({
                "id": "1", "labelsCursor": "label-25", "relationsCursor": "relation-25",
                "fetchLabels": true, "fetchRelations": true
            })
        );
    }
}

#[tokio::test]
async fn complete_nested_collections_do_not_add_per_issue_requests() {
    let server = Server::new(vec![issues_response(
        vec![issue("1"), issue("2")],
        false,
        Some("last"),
    )]);
    assert_eq!(server.tracker().fetch_active().await.unwrap().len(), 2);
    assert_eq!(server.requests().len(), 1);
}

#[tokio::test]
async fn only_unfinished_connections_continue_after_each_page() {
    let mut node = issue("1");
    node["labels"] = connection(vec![json!({"name": "first"})], true, Some("l1"));
    node["inverseRelations"] =
        connection(vec![relation("blocks", "B1", "started")], true, Some("r1"));
    let server = Server::new(vec![
        Fetch::ById.initial_response(node),
        json!({"data": {"issue": {"id": "1",
            "labels": connection(vec![json!({"name": "last"})], false, Some("l2")),
            "inverseRelations": connection(vec![relation("blocks", "B2", "started")], true, Some("r2"))
        }}}),
        json!({"data": {"issue": {"id": "1",
            "inverseRelations": connection(vec![relation("blocks", "B3", "started")], false, Some("r3"))
        }}}),
    ]);
    let issue = server.tracker().fetch_by_id("1").await.unwrap().unwrap();
    assert_eq!(issue.labels, ["first", "last"]);
    assert_eq!(issue.blockers, ["B1", "B2", "B3"]);
    let requests = server.requests();
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[2]["variables"]["fetchLabels"], false);
    assert_eq!(requests[2]["variables"]["labelsCursor"], Value::Null);
    assert_eq!(requests[2]["variables"]["relationsCursor"], "r2");
}

#[tokio::test]
async fn malformed_dispatch_data_fails_without_retry_or_partial_result() {
    let invalid_nodes = [
        {
            let mut node = issue("1");
            node.as_object_mut().unwrap().remove("inverseRelations");
            node
        },
        {
            let mut node = issue("1");
            node["inverseRelations"] = json!({"nodes": []});
            node
        },
        {
            let mut node = issue("1");
            node["inverseRelations"]["pageInfo"]["hasNextPage"] = json!("false");
            node
        },
        {
            let mut node = issue("1");
            node["inverseRelations"]["pageInfo"]
                .as_object_mut()
                .unwrap()
                .remove("endCursor");
            node
        },
        {
            let mut node = issue("1");
            node["inverseRelations"] =
                connection(vec![json!({"type": "blocks"})], false, Some("r1"));
            node
        },
        {
            let mut node = issue("1");
            node["inverseRelations"] = connection(
                vec![json!({"type": "blocks", "issue": {"identifier": "B1"}})],
                false,
                Some("r1"),
            );
            node
        },
        {
            let mut node = issue("1");
            node["state"] = Value::Null;
            node
        },
        {
            let mut node = issue("1");
            node["labels"] = Value::Null;
            node
        },
    ];
    for node in invalid_nodes {
        for fetch in [Fetch::Active, Fetch::Dispatch] {
            let server = Server::new(vec![fetch.initial_response(node.clone())]);
            let result = fetch.run(&server.tracker()).await;
            assert!(
                matches!(result, Err(TrackerError::Invalid(_))),
                "{result:?}"
            );
            assert_eq!(server.requests().len(), 1);
        }
    }
}

#[tokio::test]
async fn requested_continuation_must_preserve_issue_identity_and_connections() {
    for response in [
        json!({"data": {"issue": null}}),
        json!({"data": {"issue": {"id": "other"}}}),
        json!({"data": {"issue": {"id": "1"}}}),
        json!({"data": {"issue": {"id": "1", "inverseRelations": {"nodes": []}}}}),
    ] {
        let mut node = issue("1");
        node["inverseRelations"] =
            connection(vec![relation("related", "B1", "started")], true, Some("r1"));
        let server = Server::new(vec![Fetch::Dispatch.initial_response(node), response]);
        let result = server.tracker().fetch_by_id_for_dispatch("1").await;
        assert!(
            matches!(result, Err(TrackerError::Invalid(_))),
            "{result:?}"
        );
        assert_eq!(server.requests().len(), 2);
    }
}

#[tokio::test]
async fn list_pagination_rejects_missing_or_inconsistent_page_info() {
    for page in [
        json!({"nodes": [issue("1")]}),
        connection(vec![issue("1")], true, None),
        connection(vec![issue("1")], false, None),
        connection(vec![issue("1")], true, Some("")),
        connection(vec![], true, Some("next")),
        connection(vec![], false, Some("unexpected")),
        json!({"nodes": [], "pageInfo": {"hasNextPage": false}}),
    ] {
        for fetch in [Fetch::Active, Fetch::Terminal, Fetch::Board] {
            let server = Server::new(vec![json!({"data": {"issues": page}})]);
            let result = fetch.run(&server.tracker()).await;
            assert!(
                matches!(result, Err(TrackerError::Invalid(_))),
                "{result:?}"
            );
            assert_eq!(server.requests().len(), 1);
        }
    }
}

#[tokio::test]
async fn list_pagination_rejects_cursor_cycles_even_on_final_page() {
    for final_has_next in [false, true] {
        let server = Server::new(vec![
            issues_response(vec![issue("1")], true, Some("a")),
            issues_response(vec![issue("2")], true, Some("b")),
            issues_response(vec![issue("3")], final_has_next, Some("a")),
        ]);
        let result = server.tracker().fetch_active().await;
        assert!(
            matches!(result, Err(TrackerError::Invalid(_))),
            "{result:?}"
        );
        assert_eq!(server.requests().len(), 3);
    }
}

#[tokio::test]
async fn list_pagination_returns_all_pages_and_accepts_empty_final_page() {
    let server = Server::new(vec![
        issues_response(vec![issue("2")], true, Some("a")),
        issues_response(vec![issue("1")], true, Some("b")),
        issues_response(vec![], false, None),
    ]);
    let result = server.tracker().fetch_active().await.unwrap();
    assert_eq!(
        result
            .iter()
            .map(|issue| issue.id.as_str())
            .collect::<Vec<_>>(),
        ["1", "2"]
    );
    let requests = server.requests();
    assert_eq!(requests[0]["variables"]["cursor"], Value::Null);
    assert_eq!(requests[1]["variables"]["cursor"], "a");
    assert_eq!(requests[2]["variables"]["cursor"], "b");
}

#[tokio::test]
async fn page_cap_is_an_error_instead_of_partial_success() {
    for final_has_next in [false, true] {
        let responses = (1..=pagination::MAX_PAGES)
            .map(|n| {
                issues_response(
                    vec![issue(&n.to_string())],
                    n < pagination::MAX_PAGES || final_has_next,
                    Some(&format!("p{n}")),
                )
            })
            .collect();
        let server = Server::new(responses);
        let result = server.tracker().fetch_board_issues().await;
        if final_has_next {
            assert!(
                matches!(result, Err(TrackerError::Invalid(_))),
                "{result:?}"
            );
        } else {
            assert_eq!(result.unwrap().len(), pagination::MAX_PAGES);
        }
        assert_eq!(server.requests().len(), pagination::MAX_PAGES);
    }
}

#[tokio::test]
async fn nested_connections_reject_repeated_and_missing_cursors() {
    for field in ["labels", "inverseRelations"] {
        let item = if field == "labels" {
            json!({"name": "label"})
        } else {
            relation("blocks", "B1", "started")
        };
        for cursor in [None, Some("same")] {
            let mut node = issue("1");
            node[field] = connection(vec![item.clone()], true, Some("same"));
            let mut continuation = json!({"id": "1"});
            continuation[field] = connection(vec![item.clone()], true, cursor);
            let server = Server::new(vec![
                Fetch::Dispatch.initial_response(node),
                json!({"data": {"issue": continuation}}),
            ]);
            let result = server.tracker().fetch_by_id_for_dispatch("1").await;
            assert!(
                matches!(result, Err(TrackerError::Invalid(_))),
                "{result:?}"
            );
            assert_eq!(server.requests().len(), 2);
        }
    }
}

#[tokio::test]
async fn nested_page_cap_is_an_error_instead_of_partial_issue() {
    for field in ["labels", "inverseRelations"] {
        let item = if field == "labels" {
            json!({"name": "label"})
        } else {
            relation("blocks", "B1", "started")
        };
        let mut node = issue("1");
        node[field] = connection(vec![item.clone()], true, Some("p1"));
        let mut responses = vec![Fetch::Dispatch.initial_response(node)];
        for n in 2..=pagination::MAX_PAGES {
            let mut continuation = json!({"id": "1"});
            continuation[field] = connection(vec![item.clone()], true, Some(&format!("p{n}")));
            responses.push(json!({"data": {"issue": continuation}}));
        }
        let server = Server::new(responses);
        let result = server.tracker().fetch_by_id_for_dispatch("1").await;
        assert!(
            matches!(result, Err(TrackerError::Invalid(_))),
            "{result:?}"
        );
        assert_eq!(server.requests().len(), pagination::MAX_PAGES);
    }
}

#[tokio::test]
async fn continuation_graphql_failure_does_not_return_initial_partial_issue() {
    let mut node = issue("1");
    node["inverseRelations"] =
        connection(vec![relation("related", "B1", "started")], true, Some("r1"));
    let server = Server::new(vec![
        Fetch::Dispatch.initial_response(node),
        json!({"errors": [{"message": "cannot read next page"}]}),
    ]);
    let result = server.tracker().fetch_by_id_for_dispatch("1").await;
    assert!(
        matches!(result, Err(TrackerError::Graphql(_))),
        "{result:?}"
    );
    assert_eq!(server.requests().len(), 2);
}

#[tokio::test]
async fn initial_missing_issue_still_returns_none() {
    let server = Server::new(vec![json!({"data": {"issue": null}})]);
    assert!(server
        .tracker()
        .fetch_by_id_for_dispatch("missing")
        .await
        .unwrap()
        .is_none());
    assert_eq!(server.requests().len(), 1);
}
