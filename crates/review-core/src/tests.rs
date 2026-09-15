use super::*;
use loro::{
    json::{JsonOpContent, MapOp},
    ContainerID, ContainerType,
};
use proptest::prelude::*;

fn target() -> Target {
    Target {
        snapshot: "snapshot:1".into(),
        version: "file:v1".into(),
    }
}

fn human(command: Command) -> CommandRequest {
    CommandRequest {
        displayed: command.target().clone(),
        command,
        actor: Actor::Human,
    }
}

fn review(reviewed: bool) -> CommandRequest {
    human(Command::Review {
        target: target(),
        reviewed,
    })
}

fn collapse(collapsed: bool) -> CommandRequest {
    human(Command::Collapse {
        target: target(),
        collapsed,
    })
}

fn importance(importance: Importance) -> CommandRequest {
    human(Command::SetImportance {
        target: target(),
        importance,
    })
}

fn assessment(id: &str, supersedes: Option<&str>) -> CommandRequest {
    CommandRequest {
        displayed: target(),
        actor: Actor::Agent {
            agent: "agent:1".into(),
            run: "run:1".into(),
        },
        command: Command::Assess {
            assessment: Assessment {
                id: id.into(),
                target: target(),
                agent: "agent:1".into(),
                run: "run:1".into(),
                stream: "security".into(),
                importance: AssessmentValue::Unimportant,
                evidence: vec!["evidence:1".into()],
                supersedes: supersedes.map(str::to_owned),
            },
        },
    }
}

fn view(workspace: &Workspace) -> ReviewView {
    workspace.view("file:v1", Some("security")).unwrap()
}

fn reload(workspace: &Workspace) -> Workspace {
    Workspace::restore_trusted(&workspace.snapshot().unwrap()).unwrap()
}

fn merge(a: &Workspace, b: &Workspace) -> Workspace {
    a.import_trusted(&b.updates_since(&a.version()).unwrap())
        .unwrap()
}

#[test]
fn transition_table_and_no_op_visibility() {
    for reviewed in [false, true] {
        for collapsed in [false, true] {
            for next in [false, true] {
                let a = Workspace::new()
                    .unwrap()
                    .command(&review(reviewed))
                    .unwrap()
                    .command(&collapse(collapsed))
                    .unwrap();
                let b = a.command(&review(next)).unwrap();
                assert_eq!(view(&b).reviewed, next);
                assert_eq!(
                    view(&b).collapsed,
                    if reviewed == next { collapsed } else { next }
                );
                if reviewed == next {
                    assert_eq!(a.version(), b.version());
                }
                let c = b.command(&collapse(!view(&b).collapsed)).unwrap();
                assert_eq!(view(&c).reviewed, next);
            }
        }
    }
}

#[test]
fn candidate_failure_does_not_roll_back_prior_durable_work() {
    let durable = Workspace::new().unwrap().command(&review(true)).unwrap();
    let candidate = durable.command(&review(false)).unwrap();
    assert!(!view(&candidate).reviewed);
    // Simulated failed disk save: discard candidate, not an inverse CRDT command.
    drop(candidate);
    assert!(view(&durable).reviewed);
    assert!(view(&reload(&durable)).reviewed);
}

#[test]
fn commands_preserve_peer_but_reloads_and_forks_do_not() {
    let a = Workspace::new().unwrap();
    let b = a.command(&review(true)).unwrap();
    assert_eq!(a.peer_id(), b.peer_id());
    assert_ne!(b.peer_id(), reload(&b).peer_id());
    assert_ne!(reload(&b).peer_id(), reload(&b).peer_id());
    assert_ne!(b.doc.fork().peer_id(), b.doc.peer_id());
}

#[test]
fn offline_human_and_agent_survive_reload_before_reconnection() {
    let seed = Workspace::new().unwrap();
    let human = reload(&seed)
        .command(&importance(Importance::Important))
        .unwrap();
    let human = reload(&human);
    let agent = reload(&seed)
        .command(&assessment("assessment:1", None))
        .unwrap();
    let agent = agent
        .command(&CommandRequest {
            displayed: target(),
            actor: Actor::Agent {
                agent: "agent:1".into(),
                run: "run:1".into(),
            },
            command: Command::AddContext {
                context: Context {
                    id: "context:1".into(),
                    target: target(),
                    agent: "agent:1".into(),
                    run: "run:1".into(),
                    text: "Analyzed snapshot 1".into(),
                },
            },
        })
        .unwrap();
    let second_tab = reload(&seed).command(&review(true)).unwrap();
    let merged = merge(&merge(&human, &agent), &second_tab);
    let opposite = merge(&merge(&second_tab, &agent), &human);
    assert_eq!(view(&merged), view(&opposite));
    assert_eq!(
        view(&merged).effective_importance,
        Some(AssessmentValue::Important)
    );
    assert_eq!(view(&merged).assessments.len(), 1);
    assert_eq!(view(&merged).context.len(), 1);
    assert!(view(&merged).reviewed);
    let inherited = merged.command(&importance(Importance::Inherit)).unwrap();
    assert_eq!(
        view(&inherited).effective_importance,
        Some(AssessmentValue::Unimportant)
    );
}

#[test]
fn retries_are_idempotent_and_original_contributions_immutable() {
    let a = Workspace::new()
        .unwrap()
        .command(&assessment("assessment:1", None))
        .unwrap();
    let b = a.command(&assessment("assessment:1", None)).unwrap();
    assert_eq!(a.version(), b.version());
    let mut amended = assessment("assessment:1", None);
    if let Command::Assess { assessment } = &mut amended.command {
        assessment.evidence.clear();
    }
    assert!(a.command(&amended).is_err());
    let c = a
        .command(&assessment("assessment:2", Some("assessment:1")))
        .unwrap();
    assert_eq!(view(&c).assessments.len(), 2);
    assert_eq!(
        view(&c).effective_importance,
        Some(AssessmentValue::Unimportant)
    );
    let d = merge(&a, &c);
    let e = merge(&d, &c);
    assert_eq!(d.version(), e.version());
    assert_eq!(view(&d), view(&e));
}

#[test]
fn concurrent_stream_heads_do_not_invent_consensus() {
    let a = Workspace::new()
        .unwrap()
        .command(&assessment("assessment:1", None))
        .unwrap();
    let b = reload(&a)
        .command(&assessment("assessment:2", Some("assessment:1")))
        .unwrap();
    let c = reload(&a)
        .command(&assessment("assessment:3", Some("assessment:1")))
        .unwrap();
    let merged = merge(&b, &c);
    assert_eq!(view(&merged).effective_importance, None);
    assert_eq!(view(&merged).assessments.len(), 3);
}

#[test]
fn actor_and_displayed_target_are_checked_before_mutating() {
    let a = Workspace::new().unwrap();
    let before = a.version();
    let mut request = review(true);
    request.actor = Actor::Agent {
        agent: "agent:1".into(),
        run: "run:1".into(),
    };
    assert!(a.command(&request).is_err());
    let mut request = review(true);
    request.displayed.snapshot = "snapshot:2".into();
    assert!(a.command(&request).is_err());
    let mut request = assessment("assessment:1", None);
    request.actor = Actor::Agent {
        agent: "spoofed".into(),
        run: "run:1".into(),
    };
    assert!(a.command(&request).is_err());
    assert!(a
        .command(&assessment("assessment:1", Some("unknown")))
        .is_err());
    assert_eq!(a.version(), before);
}

#[test]
fn old_version_returns_with_explicit_unreview_not_an_earlier_review() {
    let a = Workspace::new()
        .unwrap()
        .command(&review(true))
        .unwrap()
        .command(&review(false))
        .unwrap();
    assert!(!a.view("file:v2", None).unwrap().reviewed);
    assert!(!a.view("file:v2", None).unwrap().collapsed);
    let old_agent = reload(&a).command(&assessment("late:1", None)).unwrap();
    let a = merge(&a, &old_agent);
    assert!(a.view("file:v2", None).unwrap().assessments.is_empty());
    assert!(!view(&reload(&a)).reviewed);
    assert_eq!(view(&a).assessments.len(), 1);
}

#[test]
fn missing_dependencies_are_not_persisted_or_acknowledged() {
    let seed = Workspace::new().unwrap();
    let writer = reload(&seed).command(&review(true)).unwrap();
    let later = writer.command(&review(false)).unwrap();
    let suffix = later.updates_since(&writer.version()).unwrap();
    let before = seed.version();
    assert!(matches!(
        seed.import_trusted(&suffix),
        Err(Error::MissingDependencies)
    ));
    assert_eq!(seed.version(), before);
    assert!(!seed.covers(&later.version()).unwrap());
    // Fresh VV exchange requests ALL missing history instead of retaining unbounded pending blobs.
    let recovered = merge(&seed, &later);
    assert!(recovered.covers(&later.version()).unwrap());
    assert_eq!(view(&recovered), view(&later));
}

#[test]
fn lost_receipt_and_restart_are_recovered_by_coverage_not_arrival() {
    let server = Workspace::new().unwrap();
    let browser = reload(&server).command(&review(true)).unwrap();
    let saved = merge(&server, &browser);
    let restarted = reload(&saved);
    let retry = merge(&restarted, &browser);
    assert_eq!(restarted.version(), retry.version());
    assert!(retry.covers(&browser.version()).unwrap());
    assert_eq!(view(&retry), view(&browser));
}

#[test]
fn full_history_snapshots_and_schema_fences() {
    let a = Workspace::new().unwrap().command(&review(true)).unwrap();
    let snapshot = a.snapshot().unwrap();
    assert!(matches!(
        LoroDoc::decode_import_blob_meta(&snapshot, true)
            .unwrap()
            .mode,
        EncodedBlobMode::Snapshot
    ));
    let restored = reload(&a);
    assert!(restored.covers(&a.version()).unwrap());
    let shallow = a
        .doc
        .export(ExportMode::shallow_snapshot(&a.doc.state_frontiers()))
        .unwrap();
    assert!(matches!(
        Workspace::restore_trusted(&shallow),
        Err(Error::Incompatible)
    ));
    assert!(matches!(
        a.import_trusted(&shallow),
        Err(Error::Incompatible)
    ));
    let future = a.candidate().unwrap();
    future.put("meta", "schema", SCHEMA_VERSION + 1).unwrap();
    future.doc.commit();
    assert!(matches!(
        Workspace::restore_trusted(&future.snapshot().unwrap()),
        Err(Error::Incompatible)
    ));
}

#[test]
fn limits_and_malformed_blobs_leave_the_original_unchanged() {
    let a = Workspace::new().unwrap();
    let before = a.version();
    assert!(a.import_trusted(&vec![0; MAX_BLOB_BYTES + 1]).is_err());
    assert!(a.import_trusted(b"not a loro update").is_err());
    let mut request = review(true);
    request.displayed.version = "x".repeat(257);
    assert!(a.command(&request).is_err());
    assert_eq!(a.version(), before);
}

#[test]
fn native_lww_uses_lamport_then_peer_not_wall_clock_or_import_order() {
    let seed = Workspace::new().unwrap();
    let low = reload(&seed);
    let high = reload(&seed);
    low.doc.set_peer_id(10).unwrap();
    high.doc.set_peer_id(20).unwrap();
    low.doc.set_next_commit_timestamp(9000);
    low.put("humanImportance", "file:v1", Importance::Important)
        .unwrap();
    low.doc.commit();
    high.doc.set_next_commit_timestamp(1);
    high.put("humanImportance", "file:v1", Importance::Unimportant)
        .unwrap();
    high.doc.commit();
    let low_change = low.doc.get_change(loro::ID::new(10, 0)).unwrap();
    let high_change = high.doc.get_change(loro::ID::new(20, 0)).unwrap();
    assert!(low_change.timestamp > high_change.timestamp);
    let merged = merge(&low, &high);
    assert_eq!(view(&merged), view(&merge(&high, &low)));
    assert_eq!(view(&merged).human_importance, Importance::Unimportant);
    // A lower peer wins after observing the competing operation (higher Lamport).
    let later = merged.command(&importance(Importance::Important)).unwrap();
    assert_eq!(
        view(&merge(&high, &later)).human_importance,
        Importance::Important
    );
}

#[test]
fn same_value_insert_is_skipped_but_explicit_reassert_resolves() {
    let a = Workspace::new().unwrap().command(&review(true)).unwrap();
    let before = a.version();
    a.doc.get_map("reviewed").insert("file:v1", true).unwrap();
    a.doc.commit();
    assert_eq!(a.version(), before);
    let b = a
        .command(&human(Command::ReassertReview {
            target: target(),
            reviewed: true,
        }))
        .unwrap();
    assert_ne!(b.version(), before);
    assert!(b.covers(&before).unwrap());
    assert_eq!(view(&a), view(&b));
}

#[test]
fn commit_is_not_a_multi_field_conflict_transaction() {
    let seed = Workspace::new().unwrap();
    let human = reload(&seed).command(&review(true)).unwrap();
    let tab = reload(&seed);
    // Raise Lamport using an unrelated decision, then concurrently explicitly open.
    let tab = tab
        .command(&importance(Importance::Important))
        .unwrap()
        .command(&collapse(true))
        .unwrap()
        .command(&collapse(false))
        .unwrap();
    let merged = merge(&human, &tab);
    assert!(view(&merged).reviewed);
    assert!(!view(&merged).collapsed);
}

#[test]
fn supported_history_inspection_exposes_overwritten_and_deleted_forbidden_writes() {
    let server = Workspace::new().unwrap();
    let agent = reload(&server);
    let map = agent.doc.get_map("reviewed");
    map.insert("file:v1", "forbidden payload").unwrap();
    map.insert("file:v1", true).unwrap();
    map.delete("file:v1").unwrap();
    agent.doc.commit();
    let candidate = merge(&server, &agent);
    assert_eq!(view(&candidate), view(&server));
    let ops = candidate.doc.export_json_updates_without_peer_compression(
        &server.doc.oplog_vv(),
        &candidate.doc.oplog_vv(),
    );
    let forbidden: Vec<_> = ops
        .changes
        .iter()
        .flat_map(|change| &change.ops)
        .filter(|op| op.container == ContainerID::new_root("reviewed", ContainerType::Map))
        .collect();
    assert_eq!(forbidden.len(), 3);
    assert!(
        matches!(&forbidden[0].content, JsonOpContent::Map(MapOp::Insert { value: LoroValue::String(s), .. }) if s.as_str() == "forbidden payload")
    );
    // A final-state-only validator would accept this. This experiment is intentionally NOT one.
}

#[test]
fn binary_size_cap_does_not_bound_decoded_payload_size() {
    let attacker = LoroDoc::new();
    let payload = "x".repeat(MAX_BLOB_BYTES * 2);
    attacker
        .get_map("context")
        .insert("oversized", payload.as_str())
        .unwrap();
    attacker.commit();
    let bytes = attacker.export(ExportMode::Snapshot).unwrap();
    assert!(bytes.len() < MAX_BLOB_BYTES);
    let candidate = LoroDoc::new();
    candidate.import(&bytes).unwrap();
    assert_eq!(
        candidate
            .get_map("context")
            .get("oversized")
            .unwrap()
            .get_deep_value()
            .as_string()
            .unwrap()
            .len(),
        payload.len()
    );
    // A byte cap and post-import operation checks cannot protect the decoder itself.
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]
    #[test]
    fn replicas_converge_under_commands_reloads_duplicates_and_partial_delivery(
        schedule in prop::collection::vec((0usize..3, 0u8..8, any::<bool>()), 1..70)
    ) {
        let seed = Workspace::new().unwrap();
        let mut replicas = [reload(&seed), reload(&seed), reload(&seed)];
        for (index, action, flag) in schedule {
            let next = (index + 1) % 3;
            replicas[index] = match action {
                0 => replicas[index].command(&review(flag)).unwrap(),
                1 => replicas[index].command(&collapse(flag)).unwrap(),
                2 => replicas[index].command(&importance(if flag { Importance::Important } else { Importance::Unimportant })).unwrap(),
                3 => reload(&replicas[index]),
                4..=6 => merge(&replicas[index], &replicas[next]),
                _ => {
                    let update = replicas[next].updates_since(&replicas[index].version()).unwrap();
                    let once = replicas[index].import_trusted(&update).unwrap();
                    once.import_trusted(&update).unwrap()
                }
            };
        }
        let combined = merge(&merge(&replicas[0], &replicas[1]), &replicas[2]);
        for replica in replicas {
            let final_replica = merge(&replica, &combined);
            prop_assert_eq!(view(&final_replica), view(&combined));
            prop_assert!(final_replica.covers(&combined.version()).unwrap());
            prop_assert!(combined.covers(&final_replica.version()).unwrap());
        }
    }
}
