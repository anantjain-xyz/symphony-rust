use anyhow::{bail, Context, Result};
use std::path::PathBuf;

fn main() -> Result<()> {
    let mut args = std::env::args_os();
    let program = args.next().unwrap_or_else(|| "export-bindings".into());
    let Some(destination) = args.next() else {
        bail!("usage: {} <destination>", PathBuf::from(program).display());
    };
    if args.next().is_some() {
        bail!("export-bindings accepts exactly one destination");
    }
    let destination = PathBuf::from(destination);
    symphony_contracts::export_bindings(&destination)
        .with_context(|| format!("export bindings to {}", destination.display()))
}
