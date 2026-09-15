use review_core::{Command, Importance, Workspace};

#[test]
fn importance_conflicts_are_visible_and_explicitly_resolved() {
    let mut server = Workspace::bootstrap().unwrap();
    let mut a = server.fork();
    let mut b = server.fork();
    for (replica, value) in [
        (&mut a, Importance::Important),
        (&mut b, Importance::Unimportant),
    ] {
        let proposal = replica
            .propose(Command::Importance {
                version: "v1".into(),
                value,
            })
            .unwrap()
            .unwrap();
        server.accept(&proposal).unwrap();
    }
    let view = server.view("v1").unwrap();
    assert_eq!(
        view.importance_alternatives,
        vec![Importance::Important, Importance::Unimportant]
    );
    let proposal = server
        .propose(Command::ReassertImportance {
            version: "v1".into(),
            value: view.human_importance.clone(),
        })
        .unwrap();
    assert!(proposal.is_some());
    assert_eq!(
        server.view("v1").unwrap().importance_alternatives,
        vec![view.human_importance]
    );
}

fn review(value: bool) -> Command {
    Command::Review {
        version: "v1".into(),
        value,
    }
}

#[test]
fn proposals_reproduce_exact_changes_and_retries_do_not_duplicate_history() {
    let mut server = Workspace::bootstrap().unwrap();
    let mut browser = server.fork();
    let proposal = browser.propose(review(true)).unwrap().unwrap();
    assert!(server.accept(&proposal).unwrap());
    assert!(!server.accept(&proposal).unwrap());
    assert_eq!(
        server.document().get_heads(),
        browser.document().get_heads()
    );
    assert_eq!(server.view("v1").unwrap(), browser.view("v1").unwrap());
    let second = browser.propose(review(false)).unwrap().unwrap();
    assert!(server.accept(&second).unwrap());
    assert_eq!(
        server.document().get_heads(),
        browser.document().get_heads()
    );
}

#[test]
fn reconstruction_uses_original_causal_frontier_not_server_arrival_order() {
    let mut base = Workspace::bootstrap().unwrap();
    base.propose(review(true)).unwrap();
    let mut a = base.fork();
    let mut b = base.fork();
    let a1 = a.propose(review(false)).unwrap().unwrap();
    let b1 = b.propose(review(false)).unwrap().unwrap();
    let b2 = b.propose(review(true)).unwrap().unwrap();
    let mut first = base.clone();
    let mut second = base;
    for p in [&a1, &b1, &b2] {
        first.accept(p).unwrap();
    }
    for p in [&b1, &b2, &a1] {
        second.accept(p).unwrap();
    }
    assert_eq!(first.view("v1").unwrap(), second.view("v1").unwrap());
    assert_eq!(
        first.view("v1").unwrap().review_alternatives,
        vec![false, true]
    );
    a.merge_trusted(&mut b).unwrap();
    assert_eq!(a.view("v1").unwrap(), first.view("v1").unwrap());
}

#[test]
fn changed_payload_actor_scope_and_protocol_are_rejected_without_mutation() {
    let mut server = Workspace::bootstrap().unwrap();
    let mut browser = server.fork();
    let proposal = browser.propose(review(true)).unwrap().unwrap();
    let heads = server.document().get_heads();
    let mut bad = proposal.clone();
    bad.command = review(false);
    assert!(server.accept(&bad).is_err());
    let mut bad = proposal.clone();
    bad.actor = "ff".repeat(16);
    assert!(server.accept(&bad).is_err());
    let mut bad = proposal.clone();
    bad.protocol = 999;
    assert!(server.accept(&bad).is_err());
    let mut bad = proposal.clone();
    bad.dependencies.clear();
    assert!(server.accept(&bad).is_err());
    let mut unrelated = Workspace::bootstrap().unwrap();
    assert!(unrelated.accept(&proposal).is_err());
    assert!(unrelated.merge_trusted(&mut server).is_err());
    assert_eq!(server.document().get_heads(), heads);
}
