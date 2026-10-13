use symphony_storage::StorageEvent;
use tokio::sync::broadcast::{error::RecvError, Receiver};

pub async fn next_event(receiver: &mut Receiver<StorageEvent>) -> Option<StorageEvent> {
    match receiver.recv().await {
        Ok(event) => Some(event),
        Err(RecvError::Lagged(skipped)) => {
            tracing::warn!(
                skipped,
                "desktop event receiver lagged; resynchronizing dashboard"
            );
            Some(StorageEvent::DbChanged {
                table: "*".to_string(),
                op: "resync".to_string(),
            })
        }
        Err(RecvError::Closed) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::broadcast;

    #[tokio::test]
    async fn lag_requests_resync_and_keeps_receiving() {
        let (sender, mut receiver) = broadcast::channel(2);
        for _ in 0..3 {
            sender.send(StorageEvent::WorkflowReady).unwrap();
        }
        assert!(matches!(next_event(&mut receiver).await,
            Some(StorageEvent::DbChanged { table, op }) if table == "*" && op == "resync"));
        for _ in 0..2 {
            assert!(matches!(
                next_event(&mut receiver).await,
                Some(StorageEvent::WorkflowReady)
            ));
        }
        sender
            .send(StorageEvent::RateLimitChanged {
                source: "codex".to_string(),
            })
            .unwrap();
        assert!(matches!(next_event(&mut receiver).await,
            Some(StorageEvent::RateLimitChanged { source }) if source == "codex"));
        drop(sender);
        assert!(next_event(&mut receiver).await.is_none());
    }
}
