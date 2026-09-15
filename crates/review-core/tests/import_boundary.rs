//! Counterexamples, not a validator. No opaque browser/agent history is authorized by this spike.
use automerge::{transaction::Transactable, ActorId, ReadDoc, ROOT};
use review_core::{Capability, Command, Contribution, Importance, Workspace};

#[test]
fn losing_conflicting_payload_remains_in_public_operation_history() {
    let base = Workspace::bootstrap().unwrap();
    let reviewed = base.document().get(ROOT, "reviewed").unwrap().unwrap().1;
    let mut low = base.document().fork();
    let mut high = base.document().fork();
    low.set_actor(ActorId::from(vec![1]));
    high.set_actor(ActorId::from(vec![2]));
    let mut tx = low.transaction();
    tx.put(&reviewed, "v1", "forbidden-payload").unwrap();
    tx.commit();
    let mut tx = high.transaction();
    tx.put(&reviewed, "v1", false).unwrap();
    tx.commit();
    high.merge(&mut low).unwrap();
    assert_eq!(
        high.get(&reviewed, "v1").unwrap().unwrap().0.to_bool(),
        Some(false)
    );
    assert_eq!(high.get_all(&reviewed, "v1").unwrap().len(), 2);
    assert!(high
        .get_changes(&base.document().get_heads())
        .iter()
        .any(|change| format!("{:?}", change.decode().operations).contains("forbidden-payload")));
}

#[test]
fn local_immutable_checks_do_not_authorize_concurrent_duplicate_ids() {
    let base = Workspace::bootstrap().unwrap();
    let mut a = base.fork();
    let mut b = base.fork();
    for (replica, context) in [(&mut a, "first"), (&mut b, "different")] {
        replica
            .apply(
                Capability::Agent,
                Command::Assess {
                    contribution: Contribution {
                        id: "same-job".into(),
                        version: "v1".into(),
                        agent: "agent".into(),
                        run: "run".into(),
                        importance: Importance::Important,
                        evidence: vec![],
                        context: context.into(),
                    },
                },
            )
            .unwrap();
    }
    a.merge_trusted(&mut b).unwrap();
    let map = a
        .document()
        .get(ROOT, "agentAssessments")
        .unwrap()
        .unwrap()
        .1;
    assert_eq!(a.document().get_all(map, "same-job").unwrap().len(), 2);
    assert_eq!(a.view("v1").unwrap().assessments.len(), 1);
}
