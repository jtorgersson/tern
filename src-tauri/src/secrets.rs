//! Secrets in the desktop keyring (gnome-keyring via Secret Service).
use anyhow::{Context, Result};

const SERVICE: &str = "tern";

fn entry(key: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, key).context("keyring unavailable")
}

pub fn set(key: &str, value: &str) -> Result<()> {
    entry(key)?.set_password(value).context("failed to write to keyring")
}

pub fn get(key: &str) -> Result<Option<String>> {
    match entry(key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e).context("failed to read keyring"),
    }
}

pub fn delete(key: &str) -> Result<()> {
    match entry(key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e).context("failed to delete from keyring"),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore = "touches the real keyring"]
    fn roundtrip() {
        super::set("test:roundtrip", "s3cret").unwrap();
        assert_eq!(super::get("test:roundtrip").unwrap().as_deref(), Some("s3cret"));
        super::delete("test:roundtrip").unwrap();
        assert_eq!(super::get("test:roundtrip").unwrap(), None);
    }
}
