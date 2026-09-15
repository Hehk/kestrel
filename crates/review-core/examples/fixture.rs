use automerge::ActorId;
use review_core::{Capability, Command, Contribution, Importance, Result, Workspace};
use std::{env, fs};

fn main() -> Result<()> {
    let args: Vec<_> = env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("bootstrap") => fs::write(&args[2], Workspace::bootstrap()?.save())?,
        Some("agent") => {
            let mut doc = Workspace::load_trusted(&fs::read(&args[2])?, ActorId::random())?;
            doc.apply(
                Capability::Agent,
                Command::Assess {
                    contribution: Contribution {
                        id: "native-job-1".into(),
                        version: "v1".into(),
                        agent: "native-rust-agent".into(),
                        run: "run-1".into(),
                        importance: Importance::Unimportant,
                        evidence: vec!["snapshot-1:v1:4".into()],
                        context: "Native agent context".into(),
                    },
                },
            )?;
            fs::write(&args[3], doc.save())?;
        }
        Some("view") => {
            let doc = Workspace::load_trusted(&fs::read(&args[2])?, ActorId::random())?;
            println!("{}", serde_json::to_string(&doc.view("v1")?)?);
        }
        _ => {
            return Err("usage: fixture bootstrap OUTPUT | agent INPUT OUTPUT | view INPUT".into())
        }
    }
    Ok(())
}
