use automerge::{ActorId, ReadDoc};
use proptest::prelude::*;
use review_core::{Capability, Command, Workspace};

proptest! {
    #[test]
    fn disconnected_replicas_converge_without_losing_reachable_history(
        schedule in prop::collection::vec((0usize..3, 0usize..3, 0u8..7, any::<bool>()), 0..80)
    ) {
        let base = Workspace::bootstrap().unwrap();
        let mut replicas = [base.fork(), base.fork(), base.fork()];
        for (writer, peer, action, value) in schedule {
            match action {
                0 | 1 => {
                    let command = if action == 0 {
                        Command::Review { version: "v1".into(), value }
                    } else {
                        Command::Collapse { version: "v1".into(), value }
                    };
                    replicas[writer].apply(Capability::Human, command).unwrap();
                }
                2 | 3 => {
                    let mut remote = replicas[peer].clone();
                    replicas[writer].merge_trusted(&mut remote).unwrap();
                    // Duplicate delivery is harmless; these are changes, not reordered sync frames.
                    replicas[writer].merge_trusted(&mut remote).unwrap();
                }
                4 => {
                    replicas[writer] = Workspace::load_trusted(
                        &replicas[writer].save(), ActorId::random()
                    ).unwrap();
                }
                5 => {
                    let heads = replicas[writer].document().get_heads();
                    let _ = replicas[writer].apply_durable(Capability::Human,
                        Command::Review { version: "v1".into(), value }, |_| Err("quota".into()));
                    prop_assert_eq!(replicas[writer].document().get_heads(), heads);
                }
                _ => {
                    replicas[writer].apply(Capability::Human,
                        Command::ReassertReview { version: "v1".into(), value }).unwrap();
                }
            }
        }
        let histories: Vec<_> = replicas.iter().flat_map(|r| r.document().get_changes(&[]))
            .map(|change| change.hash()).collect();
        let mut merged = base.fork();
        for replica in &replicas {
            merged.merge_trusted(&mut replica.clone()).unwrap();
        }
        for replica in &mut replicas {
            replica.merge_trusted(&mut merged).unwrap();
            prop_assert_eq!(replica.view("v1").unwrap(), merged.view("v1").unwrap());
            for hash in &histories {
                prop_assert!(replica.document().get_change_by_hash(hash).is_some());
            }
            prop_assert!(!replica.view("v2").unwrap().reviewed);
        }
    }
}
