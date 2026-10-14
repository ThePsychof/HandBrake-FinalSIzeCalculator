use anyhow::{Context, Result};
use directories::ProjectDirs;
use std::{fs, path::PathBuf};

use crate::model::CalibrationRecord;

fn file_path() -> Result<PathBuf> {
    let dirs = ProjectDirs::from("com", "ThePsychof", "HandBrakeSizePredictor")
        .context("Could not locate the app's local data directory.")?;
    fs::create_dir_all(dirs.data_local_dir())
        .context("Could not create local app data directory.")?;
    Ok(dirs.data_local_dir().join("calibration.json"))
}

pub fn load() -> Result<Vec<CalibrationRecord>> {
    let path = file_path()?;
    match fs::read_to_string(path) {
        Ok(contents) => {
            serde_json::from_str(&contents).context("Local calibration data is malformed.")
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error).context("Could not read local calibration data."),
    }
}

pub fn append(record: CalibrationRecord) -> Result<Vec<CalibrationRecord>> {
    let mut records = load()?;
    records.insert(0, record);
    records.truncate(200);
    let path = file_path()?;
    let contents = serde_json::to_string_pretty(&records)?;
    fs::write(path, contents).context("Could not save local calibration data.")?;
    Ok(records)
}
