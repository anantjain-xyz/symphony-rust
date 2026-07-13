use std::{env, fs, path::Path};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};

fn decode_base64_text(value: &str, label: &str) -> Result<String, Box<dyn std::error::Error>> {
    let decoded = STANDARD
        .decode(value.trim())
        .map_err(|error| format!("invalid base64 {label}: {error}"))?;
    String::from_utf8(decoded).map_err(|error| format!("invalid UTF-8 {label}: {error}").into())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args_os().skip(1);
    let bundle = args.next().ok_or("missing updater bundle path")?;
    let signature_path = args.next().ok_or("missing updater signature path")?;
    let config_path = args.next().ok_or("missing Tauri config path")?;
    if args.next().is_some() {
        return Err("usage: verify-updater-signature <bundle> <signature> <tauri-config>".into());
    }

    let config: serde_json::Value = serde_json::from_slice(&fs::read(&config_path)?)?;
    let encoded_public_key = config
        .pointer("/plugins/updater/pubkey")
        .and_then(serde_json::Value::as_str)
        .ok_or("Tauri config is missing plugins.updater.pubkey")?;
    let encoded_signature = fs::read_to_string(&signature_path)?;

    let public_key = PublicKey::decode(&decode_base64_text(
        encoded_public_key,
        "updater public key",
    )?)?;
    let signature = Signature::decode(&decode_base64_text(
        &encoded_signature,
        "updater signature",
    )?)?;
    let artifact = fs::read(Path::new(&bundle))?;
    public_key.verify(&artifact, &signature, true)?;

    println!("verified updater signature against src-tauri/tauri.conf.json");
    Ok(())
}
