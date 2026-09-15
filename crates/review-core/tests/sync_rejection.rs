use automerge::{
    sync::{State, SyncDoc},
    transaction::Transactable,
    ROOT,
};
use review_core::Workspace;

#[test]
fn rejected_schema_does_not_advance_document_or_peer_state() {
    let mut receiver = Workspace::bootstrap().unwrap();
    let mut sender = receiver.document().fork();
    let mut tx = sender.transaction();
    tx.put(ROOT, "schemaVersion", 999u32).unwrap();
    tx.commit();
    let mut sending = State::new();
    let mut receiving = State::new();
    for _ in 0..20 {
        if let Some(message) = sender.generate_sync_message(&mut sending) {
            let heads = receiver.document().get_heads();
            let peer = receiving.clone();
            if receiver
                .receive_sync_trusted(&mut receiving, message)
                .is_err()
            {
                assert_eq!(receiver.document().get_heads(), heads);
                assert_eq!(receiving, peer);
                return;
            }
        }
        if let Some(message) = receiver.document().generate_sync_message(&mut receiving) {
            sender.receive_sync_message(&mut sending, message).unwrap();
        }
    }
    panic!("invalid schema was not rejected");
}
