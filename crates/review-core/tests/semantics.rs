use automerge::{
    sync::{Message, State, SyncDoc},
    transaction::Transactable,
    ActorId, Automerge, ReadDoc, ROOT,
};
use review_core::{
    Capability::{Agent, Human},
    Command, Contribution, Importance, Workspace,
};

fn review(doc: &mut Workspace, value: bool) -> bool {
    doc.apply(
        Human,
        Command::Review {
            version: "v1".into(),
            value,
        },
    )
    .unwrap()
}

fn collapse(doc: &mut Workspace, value: bool) {
    doc.apply(
        Human,
        Command::Collapse {
            version: "v1".into(),
            value,
        },
    )
    .unwrap();
}

fn assessment() -> Command {
    Command::Assess {
        contribution: Contribution {
            id: "job-1".into(),
            version: "v1".into(),
            agent: "fake-rust-agent".into(),
            run: "run-1".into(),
            importance: Importance::Unimportant,
            evidence: vec!["snapshot-1:v1:line-4".into()],
            context: "Generated fixture".into(),
        },
    }
}

#[test]
fn review_transitions_are_atomic_and_repetition_does_not_change_visibility() {
    for reviewed in [false, true] {
        for collapsed in [false, true] {
            for requested in [false, true] {
                let mut doc = Workspace::bootstrap().unwrap();
                review(&mut doc, reviewed);
                collapse(&mut doc, collapsed);
                let before = doc.document().get_heads();
                assert_eq!(review(&mut doc, requested), requested != reviewed);
                let view = doc.view("v1").unwrap();
                assert_eq!(view.reviewed, requested);
                assert_eq!(
                    view.collapsed,
                    if requested == reviewed {
                        collapsed
                    } else {
                        requested
                    }
                );
                let changes = doc.document().get_changes(&before);
                assert_eq!(changes.len(), usize::from(requested != reviewed));
                if let Some(change) = changes.first() {
                    assert!((1..=2).contains(&change.decode().operations.len()));
                }
            }
        }
    }
}

#[test]
fn versions_never_inherit_and_explicit_unreview_survives_return() {
    let mut doc = Workspace::bootstrap().unwrap();
    review(&mut doc, true);
    assert!(!doc.view("v2").unwrap().reviewed);
    assert!(!doc.view("v2").unwrap().collapsed);
    assert!(doc.view("v1").unwrap().reviewed);
    review(&mut doc, false);
    let reloaded = Workspace::load_trusted(&doc.save(), ActorId::random()).unwrap();
    assert!(!reloaded.view("v1").unwrap().reviewed);
}

#[test]
fn three_offline_writers_reload_and_preserve_human_and_agent_contributions() {
    let base = Workspace::bootstrap().unwrap();
    let mut browser = base.fork();
    let mut tab = base.fork();
    let mut agent = base.fork();
    assert_ne!(browser.document().get_actor(), tab.document().get_actor());
    assert_ne!(browser.document().get_actor(), agent.document().get_actor());
    browser
        .apply(
            Human,
            Command::Importance {
                version: "v1".into(),
                value: Importance::Important,
            },
        )
        .unwrap();
    review(&mut tab, true);
    assert!(agent.apply(Agent, assessment()).unwrap());
    assert!(!agent.apply(Agent, assessment()).unwrap());
    browser = Workspace::load_trusted(&browser.save(), ActorId::random()).unwrap();
    browser.merge_trusted(&mut agent).unwrap();
    browser.merge_trusted(&mut tab).unwrap();
    agent.merge_trusted(&mut browser).unwrap();
    tab.merge_trusted(&mut agent).unwrap();
    let view = browser.view("v1").unwrap();
    assert_eq!(view, agent.view("v1").unwrap());
    assert_eq!(view, tab.view("v1").unwrap());
    assert_eq!(view.human_importance, Importance::Important);
    assert_eq!(view.effective_importance, Some(Importance::Important));
    assert_eq!(view.assessments.len(), 1);
    assert_eq!(view.assessments[0].importance, Importance::Unimportant);
    assert_eq!(view.assessments[0].agent, "fake-rust-agent");
    assert_eq!(view.assessments[0].context, "Generated fixture");
    assert!(view.reviewed);
    assert!(browser.view("unseen").unwrap().assessments.is_empty());
    browser
        .apply(
            Human,
            Command::Importance {
                version: "v1".into(),
                value: Importance::Inherit,
            },
        )
        .unwrap();
    assert_eq!(
        browser.view("v1").unwrap().human_importance,
        Importance::Inherit
    );
    assert_eq!(
        browser.view("v1").unwrap().effective_importance,
        Some(Importance::Unimportant)
    );
}

#[test]
fn concurrent_decisions_converge_and_only_reassert_resolves_observed_conflicts() {
    let mut base = Workspace::bootstrap().unwrap();
    review(&mut base, true);
    let mut a = base.fork();
    let mut b = base.fork();
    review(&mut a, false);
    review(&mut b, false);
    review(&mut b, true);
    let mut reverse = b.clone();
    reverse.merge_trusted(&mut a.clone()).unwrap();
    a.merge_trusted(&mut b).unwrap();
    assert_eq!(a.view("v1").unwrap(), reverse.view("v1").unwrap());
    let view = a.view("v1").unwrap();
    assert_eq!(view.review_alternatives, vec![false, true]);
    assert!(!review(&mut a, view.reviewed));
    assert_eq!(a.view("v1").unwrap().review_alternatives.len(), 2);
    a.apply(
        Human,
        Command::ReassertReview {
            version: "v1".into(),
            value: view.reviewed,
        },
    )
    .unwrap();
    reverse.merge_trusted(&mut a).unwrap();
    assert_eq!(
        reverse.view("v1").unwrap().review_alternatives,
        vec![view.reviewed]
    );
}

#[test]
fn concurrent_visibility_and_review_can_produce_expanded_reviewed_file() {
    let mut base = Workspace::bootstrap().unwrap();
    collapse(&mut base, true);
    let mut a = base.fork();
    let mut b = base.fork();
    review(&mut a, true);
    collapse(&mut b, false);
    a.merge_trusted(&mut b).unwrap();
    assert!(a.view("v1").unwrap().reviewed);
    let alternatives = a
        .document()
        .get_all(
            a.document().get(ROOT, "collapsed").unwrap().unwrap().1,
            "v1",
        )
        .unwrap();
    // Automerge elides an unchanged collapsed=true put in A's review command.
    assert_eq!(alternatives.len(), 1);
    assert!(a.view("v1").unwrap().reviewed);
    assert!(!a.view("v1").unwrap().collapsed);
}

#[test]
fn failed_persistence_does_not_publish_candidate_or_undo_prior_remote_work() {
    let mut doc = Workspace::bootstrap().unwrap();
    let mut agent = doc.fork();
    agent.apply(Agent, assessment()).unwrap();
    doc.merge_trusted(&mut agent).unwrap();
    let heads = doc.document().get_heads();
    let command = Command::Review {
        version: "v1".into(),
        value: true,
    };
    assert!(doc
        .apply_durable(Human, command.clone(), |_| Err("quota".into()))
        .is_err());
    assert_eq!(doc.document().get_heads(), heads);
    assert!(!doc.view("v1").unwrap().reviewed);
    assert_eq!(doc.view("v1").unwrap().assessments.len(), 1);
    let mut durable = Vec::new();
    doc.apply_durable(Human, command, |bytes| {
        durable = bytes.to_vec();
        Ok(())
    })
    .unwrap();
    let restored = Workspace::load_trusted(&durable, ActorId::random()).unwrap();
    assert_eq!(doc.view("v1").unwrap(), restored.view("v1").unwrap());
}

#[test]
fn command_capabilities_and_immutable_retry_ids() {
    let mut doc = Workspace::bootstrap().unwrap();
    assert!(doc
        .apply(
            Agent,
            Command::Review {
                version: "v1".into(),
                value: true
            }
        )
        .is_err());
    assert!(doc.apply(Human, assessment()).is_err());
    doc.apply(Agent, assessment()).unwrap();
    let Command::Assess { mut contribution } = assessment() else {
        unreachable!()
    };
    contribution.context = "changed payload".into();
    assert!(doc.apply(Agent, Command::Assess { contribution }).is_err());
}

#[test]
fn visible_state_validation_misses_forbidden_deleted_history() {
    let base = Workspace::bootstrap().unwrap();
    let mut malicious = base.document().fork();
    let reviewed = malicious.get(ROOT, "reviewed").unwrap().unwrap().1;
    let mut tx = malicious.transaction();
    tx.put(&reviewed, "v1", true).unwrap();
    tx.commit();
    let mut tx = malicious.transaction();
    tx.delete(&reviewed, "v1").unwrap();
    tx.commit();
    let loaded = Workspace::load_trusted(&malicious.save(), ActorId::random()).unwrap();
    assert_eq!(base.view("v1").unwrap(), loaded.view("v1").unwrap());
    let changes = malicious.get_changes(&base.document().get_heads());
    assert_eq!(changes.len(), 2);
    assert_eq!(
        changes
            .iter()
            .map(|c| c.decode().operations.len())
            .sum::<usize>(),
        2
    );
    // Public operation inspection exists; final-state shape checks are NOT authorization.
    assert!(format!("{:?}", changes[0].decode().operations[0].action).contains("Put"));
}

#[test]
fn ordered_sync_recovers_after_lost_reply_with_a_new_session() {
    let base = Workspace::bootstrap().unwrap();
    let mut browser = base.fork();
    review(&mut browser, true);
    let mut a = browser.document().clone();
    let mut b = base.document().clone();
    let mut sa = State::new();
    let mut sb = State::new();
    let mut lost_reply = false;
    for _ in 0..20 {
        if let Some(message) = a.generate_sync_message(&mut sa) {
            b.receive_sync_message(&mut sb, Message::decode(&message.encode()).unwrap())
                .unwrap();
        }
        if b.get_heads() == a.get_heads() {
            let _lost = b.generate_sync_message(&mut sb);
            b = Automerge::load(&b.save()).unwrap();
            lost_reply = true;
            break;
        }
        if let Some(message) = b.generate_sync_message(&mut sb) {
            a.receive_sync_message(&mut sa, message).unwrap();
        }
    }
    assert!(lost_reply);
    sa = State::new();
    sb = State::new();
    let mut settled = false;
    for _ in 0..20 {
        let ab = a.generate_sync_message(&mut sa);
        let ba = b.generate_sync_message(&mut sb);
        if ab.is_none() && ba.is_none() {
            settled = true;
            break;
        }
        if let Some(m) = ab {
            b.receive_sync_message(&mut sb, m).unwrap();
        }
        if let Some(m) = ba {
            a.receive_sync_message(&mut sa, m).unwrap();
        }
    }
    assert!(settled);
    assert_eq!(a.get_heads(), b.get_heads());
}

#[test]
fn unsupported_schema_is_not_silently_reset() {
    let mut doc = Workspace::bootstrap().unwrap().document().clone();
    let mut tx = doc.transaction();
    tx.put(ROOT, "schemaVersion", 999u32).unwrap();
    tx.commit();
    assert!(Workspace::load_trusted(&doc.save(), ActorId::random()).is_err());
}
