use std::fs;

pub fn write_private(path: &std::path::Path, content: impl AsRef<[u8]>) -> Result<(), String> {
    fs::write(path, content).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}
