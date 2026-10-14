use anyhow::{Context, Result, bail};
use serde::Deserialize;
use std::{
    collections::HashMap,
    process::Command,
    sync::{Mutex, OnceLock},
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

use crate::model::{
    AudioCodec, AudioOutput, AudioTrack, Container, MediaInfo, OutputSettings, RateMode,
    SubtitleCodec, SubtitleOutput, SubtitleTrack, VideoCodec, VideoTrack,
};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiElement {
    pub id: Option<String>,
    pub name: Option<String>,
    pub value: Option<String>,
    pub selected: Option<String>,
    pub toggle: Option<String>,
    pub range: Option<f64>,
    pub is_selected: Option<bool>,
    #[serde(rename = "type")]
    pub control_type: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveWindow {
    pub process_id: u32,
    pub window_title: String,
    pub source_display_name: Option<String>,
    pub source_summary: Option<String>,
    pub duration_text: Option<String>,
    pub preset: Option<String>,
    pub destination: Option<String>,
    #[serde(default)]
    pub tabs: HashMap<String, Vec<UiElement>>,
}

#[derive(Clone, Debug)]
pub struct LiveReadout {
    pub process_id: u32,
    pub window_title: String,
    pub media: MediaInfo,
    pub settings: OutputSettings,
}

type TabCache = Mutex<HashMap<u32, HashMap<String, Vec<UiElement>>>>;
static TAB_CACHE: OnceLock<TabCache> = OnceLock::new();

pub fn read_windows() -> Result<Vec<LiveWindow>> {
    #[cfg(not(target_os = "windows"))]
    {
        Ok(Vec::new())
    }

    #[cfg(target_os = "windows")]
    {
        let cache = TAB_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
        let mut command = Command::new("powershell.exe");
        command.creation_flags(CREATE_NO_WINDOW).args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            UI_AUTOMATION_SCRIPT,
        ]);
        let output = command
            .output()
            .context("Could not start hidden Windows PowerShell for HandBrake live sync.")?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            bail!(
                "HandBrake UI Automation failed: {}",
                stderr.trim().trim_start_matches("#< CLIXML")
            );
        }
        let stdout = String::from_utf8(output.stdout)
            .context("HandBrake UI Automation returned non-UTF-8 output.")?;
        let mut windows: Vec<LiveWindow> = serde_json::from_str(stdout.trim())
            .context("HandBrake UI Automation returned invalid JSON.")?;

        let running = windows
            .iter()
            .map(|window| window.process_id)
            .collect::<std::collections::HashSet<_>>();
        let mut cache = cache
            .lock()
            .map_err(|_| anyhow::anyhow!("HandBrake UI cache lock was poisoned."))?;
        cache.retain(|process_id, _| running.contains(process_id));
        for window in &mut windows {
            let tabs = cache.entry(window.process_id).or_default();
            tabs.extend(window.tabs.drain());
            window.tabs = tabs.clone();
        }
        Ok(windows)
    }
}

pub fn scanned_source(process_id: u32, display_name: &str) -> Option<(String, Option<u32>)> {
    let app_data = std::env::var_os("APPDATA")?;
    let log_path = std::path::PathBuf::from(app_data)
        .join("HandBrake")
        .join("logs")
        .join(format!("activity_log_main.{process_id}.txt"));
    let contents = std::fs::read_to_string(log_path).ok()?;
    let displayed = basename_without_extension(display_name);

    contents.lines().rev().find_map(|line| {
        let lowercase = line.to_ascii_lowercase();
        let (_, rest) = lowercase.split_once("hb_scan: path=")?;
        let (_, title) = rest.split_once(", title_index=")?;
        let source = line
            .split_once("hb_scan: path=")?
            .1
            .split_once(", title_index=")?
            .0
            .trim();
        (basename_without_extension(source) == displayed).then(|| {
            (
                source.to_owned(),
                title.trim().parse::<u32>().ok().map(|index| index + 1),
            )
        })
    })
}

pub fn read_current() -> Result<Option<LiveReadout>> {
    let windows = read_windows()?;
    let Some(window) = windows
        .iter()
        .find(|window| window.source_display_name.is_some())
        .or_else(|| windows.first())
    else {
        return Ok(None);
    };
    let Some(source_name) = window.source_display_name.as_deref() else {
        return Ok(None);
    };
    let scanned = scanned_source(window.process_id, source_name);
    let source_path = scanned.as_ref().map(|(path, _)| path.clone());
    let source = source_path
        .clone()
        .unwrap_or_else(|| source_name.to_owned());
    let summary = window.source_summary.as_deref().unwrap_or_default();
    let duration = parse_duration(window.duration_text.as_deref());
    let (width, height) = dimensions(summary);
    let frame_rate = number_before(summary, "fps");
    let tabs = &window.tabs;
    let summary_tab = tab(tabs, "Summary");
    let video_tab = tab(tabs, "Video");
    let audio_tab = tab(tabs, "Audio");
    let subtitle_tab = tab(tabs, "Subtitles");
    let picture_tab = tab(tabs, "Dimensions");
    let chapters_tab = tab(tabs, "Chapters");
    let lines = text_lines(summary_tab);
    let (audio_lines, subtitle_lines) = summary_tracks(&lines);
    let source_audio = parse_audio_sources(audio_tab);
    let source_subtitles = parse_subtitle_sources(subtitle_tab);

    let encoder_name = control_value(video_tab, "Video Encoder");
    let codec = video_codec(encoder_name.as_deref().unwrap_or_default());
    let mode = video_rate_mode(video_tab);
    let bitrate = numeric_setting(video_tab, &["avg bitrate", "video bitrate", "bitrate"]);
    let quality = numeric_setting(
        video_tab,
        &["constant quality", "video quality", "quality", "rf"],
    );
    let video_bitrate_kbps = (mode == RateMode::AverageBitrate)
        .then_some(bitrate)
        .flatten();
    let quality_rf = (mode == RateMode::ConstantQuality)
        .then_some(quality)
        .flatten();
    let video_preset = preset(video_tab).or_else(|| window.preset.clone());
    let (output_width, output_height) = picture_dimensions(picture_tab);
    let frame_rate = control_value(video_tab, "Framerate (FPS)")
        .and_then(|value| parse_number(&value))
        .or(frame_rate);
    let two_pass = control(video_tab, "Multi-Pass Encoding")
        .and_then(|item| parse_toggle(item.toggle.as_deref()));
    let output_container = container(
        control_value(summary_tab, "Container")
            .or_else(|| control_value(summary_tab, "Format"))
            .as_deref()
            .unwrap_or_default(),
        window.destination.as_deref().unwrap_or_default(),
    );

    let audio = audio_lines
        .iter()
        .enumerate()
        .map(|(ordinal, line)| {
            let index = track_index(line).unwrap_or(ordinal);
            let passthrough = contains_any(line, &["passthru", "pass-through", "passthrough"]);
            AudioOutput {
                index,
                codec: AudioCodec::from_name(line),
                bitrate_kbps: number_before(line, "kbps"),
                quality: None,
                passthrough,
                enabled: true,
                source_track_match: Some(source_audio.iter().any(|track| track.index == index)),
                channels: source_audio
                    .iter()
                    .find(|track| track.index == index)
                    .and_then(|track| track.channels),
                mixdown: None,
                sample_rate: None,
                gain_db: None,
                drc: None,
                encoder_options: None,
            }
        })
        .collect();
    let subtitles = subtitle_lines
        .iter()
        .enumerate()
        .map(|(ordinal, line)| {
            let index = track_index(line).unwrap_or(ordinal);
            SubtitleOutput {
                index,
                codec: subtitle_codec(line),
                enabled: true,
                burn_in: contains_any(line, &["burned", "burn-in", "burn in"]),
                forced_only: None,
                default: None,
                track_name: None,
            }
        })
        .collect();

    let filter_signature = tab(tabs, "Filters")
        .iter()
        .filter(|item| {
            item.control_type.as_deref() == Some("ControlType.ComboBox")
                || item.control_type.as_deref() == Some("ControlType.CheckBox")
        })
        .filter_map(|item| {
            Some((
                item.name.as_deref().or(item.id.as_deref())?,
                item.selected
                    .as_deref()
                    .or(item.toggle.as_deref())
                    .or(item.value.as_deref())?,
            ))
        })
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>();

    let media = MediaInfo {
        file_path: source.clone(),
        duration_seconds: duration,
        width,
        height,
        frame_rate,
        container: source_container(&source),
        source_file_size_bytes: source_path
            .as_deref()
            .and_then(|path| std::fs::metadata(path).ok())
            .map(|metadata| metadata.len()),
        video_tracks: (width.is_some() || height.is_some())
            .then_some(vec![VideoTrack {
                width,
                height,
                frame_rate,
                codec,
                ..Default::default()
            }])
            .unwrap_or_default(),
        audio_tracks: source_audio,
        subtitle_tracks: source_subtitles,
        handbrake_version: None,
        scan_error: None,
    };
    let settings = OutputSettings {
        mode,
        container: output_container,
        video_codec: codec,
        video_bitrate_kbps,
        quality_rf,
        preset: video_preset.unwrap_or_else(|| "medium".to_owned()),
        video_encoder_name: encoder_name,
        encoder_tune: control_value(video_tab, "Encoder Tune"),
        encoder_profile: control_value(video_tab, "Encoder Profile"),
        encoder_level: control_value(video_tab, "Encoder Level"),
        encoder_options: control(video_tab, "Advanced Options").and_then(|item| item.value.clone()),
        output_width,
        output_height,
        frame_rate_mode: if selected_radio(video_tab, "Constant Framerate") {
            Some("constant".to_owned())
        } else if selected_radio(video_tab, "Variable Framerate") {
            Some("variable".to_owned())
        } else if selected_radio(video_tab, "Peak Framerate") {
            Some("peak".to_owned())
        } else {
            None
        },
        frame_rate,
        filter_signature: (!filter_signature.is_empty()).then(|| filter_signature.join("; ")),
        two_pass: two_pass.unwrap_or(false),
        overhead_percent: None,
        chapters: control(chapters_tab, "Create chapter markers")
            .and_then(|item| parse_toggle(item.toggle.as_deref())),
        metadata_passthrough: None,
        web_optimized: None,
        align_av_start: None,
        ipod_5g_support: None,
        audio,
        subtitles,
    };
    Ok(Some(LiveReadout {
        process_id: window.process_id,
        window_title: window.window_title.clone(),
        media,
        settings,
    }))
}

fn tab<'a>(tabs: &'a HashMap<String, Vec<UiElement>>, name: &str) -> &'a [UiElement] {
    tabs.iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, controls)| controls.as_slice())
        .unwrap_or_default()
}

fn control<'a>(controls: &'a [UiElement], needle: &str) -> Option<&'a UiElement> {
    controls.iter().find(|item| {
        format!(
            "{} {}",
            item.id.as_deref().unwrap_or_default(),
            item.name.as_deref().unwrap_or_default()
        )
        .to_ascii_lowercase()
        .contains(&needle.to_ascii_lowercase())
    })
}

fn control_value(controls: &[UiElement], needle: &str) -> Option<String> {
    let item = control(controls, needle)?;
    item.selected
        .as_deref()
        .or(item.value.as_deref())
        .or(item.name.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn selected_radio(controls: &[UiElement], needle: &str) -> bool {
    controls.iter().any(|item| {
        item.control_type.as_deref() == Some("ControlType.RadioButton")
            && item.is_selected == Some(true)
            && item.name.as_deref().is_some_and(|name| {
                name.to_ascii_lowercase()
                    .contains(&needle.to_ascii_lowercase())
            })
    })
}

fn text_lines(controls: &[UiElement]) -> Vec<String> {
    controls
        .iter()
        .filter(|item| item.control_type.as_deref() == Some("ControlType.Text"))
        .filter_map(|item| item.name.clone())
        .collect()
}

fn summary_tracks(lines: &[String]) -> (Vec<String>, Vec<String>) {
    let Some(start) = lines.iter().position(|line| line.trim() == "Tracks:") else {
        return (Vec::new(), Vec::new());
    };
    let end = lines[start + 1..]
        .iter()
        .position(|line| line.trim() == "Chapter Markers")
        .map_or(lines.len(), |offset| start + 1 + offset);
    let entries = &lines[start + 1..end];
    let audio = entries
        .iter()
        .filter(|line| {
            contains_any(
                line,
                &[
                    "passthru", "aac", "ac-3", "ac3", "e-ac-3", "opus", "flac", "mp3", "kbps",
                ],
            )
        })
        .cloned()
        .collect();
    let subtitles = entries
        .iter()
        .filter(|line| {
            contains_any(
                line,
                &[
                    "burned", "subtitle", "srt", "subrip", "pgs", "vobsub", "utf-8",
                ],
            )
        })
        .cloned()
        .collect();
    (audio, subtitles)
}

fn contains_any(value: &str, needles: &[&str]) -> bool {
    let value = value.to_ascii_lowercase();
    needles.iter().any(|needle| value.contains(needle))
}

fn parse_audio_sources(controls: &[UiElement]) -> Vec<AudioTrack> {
    controls
        .iter()
        .filter(|item| {
            matches!(
                item.control_type.as_deref(),
                Some("ControlType.DataItem") | Some("ControlType.ListItem")
            )
        })
        .filter_map(|item| {
            let name = item.name.as_deref()?;
            if !name.to_ascii_lowercase().contains("audio track:") {
                return None;
            }
            let index = track_index(name)?;
            let channels = number_before(name, "ch").map(|number| number as u32);
            Some(AudioTrack {
                index,
                codec: AudioCodec::from_name(name),
                channels,
                ..Default::default()
            })
        })
        .collect()
}

fn parse_subtitle_sources(controls: &[UiElement]) -> Vec<SubtitleTrack> {
    controls
        .iter()
        .filter(|item| {
            matches!(
                item.control_type.as_deref(),
                Some("ControlType.DataItem") | Some("ControlType.ListItem")
            )
        })
        .filter_map(|item| {
            let name = item.name.as_deref()?;
            if !name.to_ascii_lowercase().contains("subtitle track:") {
                return None;
            }
            let codec = subtitle_codec(name);
            Some(SubtitleTrack {
                index: track_index(name)?,
                codec,
                is_bitmap: codec == SubtitleCodec::Bitmap,
                ..Default::default()
            })
        })
        .collect()
}

fn track_index(value: &str) -> Option<usize> {
    let (before, rest) = value.split_once(':')?;
    before
        .trim()
        .parse::<usize>()
        .ok()
        .or_else(|| {
            rest.trim()
                .split(|character: char| !character.is_ascii_digit())
                .find(|part| !part.is_empty())?
                .parse::<usize>()
                .ok()
        })
        .map(|index| index.saturating_sub(1))
}

fn video_codec(value: &str) -> VideoCodec {
    let value = value.to_ascii_lowercase();
    if value.contains("x264") {
        VideoCodec::X264
    } else if value.contains("x265") {
        VideoCodec::X265
    } else if value.contains("av1") {
        VideoCodec::Av1
    } else if value.contains("vp9") {
        VideoCodec::Vp9
    } else if value.contains("hevc") || value.contains("h.265") {
        VideoCodec::Hevc
    } else if value.contains("h.264") || value.contains("h264") {
        VideoCodec::H264
    } else if value.contains("mpeg-4") || value.contains("mpeg4") {
        VideoCodec::Mpeg4
    } else if value.contains("mpeg-2") || value.contains("mpeg2") {
        VideoCodec::Mpeg2
    } else {
        VideoCodec::Unknown
    }
}

fn subtitle_codec(value: &str) -> SubtitleCodec {
    if contains_any(value, &["pgs", "vobsub", "dvd sub", "bitmap"]) {
        SubtitleCodec::Bitmap
    } else if contains_any(value, &["srt", "subrip", "utf-8"]) {
        SubtitleCodec::Subrip
    } else if contains_any(value, &["ass", "ssa"]) {
        SubtitleCodec::Ass
    } else {
        SubtitleCodec::Unknown
    }
}

fn parse_toggle(value: Option<&str>) -> Option<bool> {
    match value? {
        "On" => Some(true),
        "Off" => Some(false),
        _ => None,
    }
}

fn parse_number(value: &str) -> Option<f64> {
    let value = value
        .trim()
        .trim_start_matches(|character: char| !character.is_ascii_digit() && character != '-');
    let number = value
        .split(|character: char| {
            !character.is_ascii_digit() && character != '.' && character != '-'
        })
        .next()?
        .parse::<f64>()
        .ok()?;
    number.is_finite().then_some(number)
}

fn number_before(value: &str, marker: &str) -> Option<f64> {
    let lower = value.to_ascii_lowercase();
    let position = lower.find(&marker.to_ascii_lowercase())?;
    let prefix = value[..position].trim_end();
    let start = prefix
        .char_indices()
        .rev()
        .find(|(_, character)| {
            !character.is_ascii_digit() && *character != '.' && *character != '-'
        })
        .map_or(0, |(index, character)| index + character.len_utf8());
    prefix[start..].parse().ok()
}

fn video_rate_mode(controls: &[UiElement]) -> RateMode {
    if selected_radio(controls, "Constant Quality") {
        RateMode::ConstantQuality
    } else {
        RateMode::AverageBitrate
    }
}

fn numeric_setting(controls: &[UiElement], needles: &[&str]) -> Option<f64> {
    controls
        .iter()
        .filter(|item| {
            item.control_type.as_deref() != Some("ControlType.RadioButton")
                && needles.iter().any(|needle| {
                    format!(
                        "{} {}",
                        item.id.as_deref().unwrap_or_default(),
                        item.name.as_deref().unwrap_or_default()
                    )
                    .to_ascii_lowercase()
                    .contains(needle)
                })
        })
        .find_map(|item| {
            item.range
                .or_else(|| {
                    item.value
                        .as_deref()
                        .or(item.selected.as_deref())
                        .and_then(parse_number)
                })
                .or_else(|| item.name.as_deref().and_then(parse_number))
                .filter(|number| *number >= 0.0)
        })
}

fn parse_duration(value: Option<&str>) -> Option<f64> {
    let value = value?;
    let parts = value
        .split(':')
        .map(|part| part.trim().parse::<f64>().ok())
        .collect::<Option<Vec<_>>>()?;
    match parts.as_slice() {
        [hours, minutes, seconds] => Some(hours * 3600.0 + minutes * 60.0 + seconds),
        _ => None,
    }
}

fn dimensions(value: &str) -> (Option<u32>, Option<u32>) {
    let (Some(index), Some(x)) = (
        value.find(|character: char| character.is_ascii_digit()),
        value.find(['x', 'X']),
    ) else {
        return (None, None);
    };
    if x <= index {
        return (None, None);
    }
    let width = value[index..x].parse().ok();
    let height_start = x + 1;
    let height_end = value[height_start..]
        .find(|character: char| !character.is_ascii_digit())
        .map_or(value.len(), |offset| height_start + offset);
    let height = value[height_start..height_end].parse().ok();
    (width, height)
}

fn picture_dimensions(controls: &[UiElement]) -> (Option<u32>, Option<u32>) {
    controls
        .iter()
        .filter_map(|item| item.name.as_deref())
        .find(|name| name.to_ascii_lowercase().contains("storage size:"))
        .map_or((None, None), dimensions)
}

fn preset(controls: &[UiElement]) -> Option<String> {
    let names = text_lines(controls);
    let start = names
        .iter()
        .position(|name| name.to_ascii_lowercase().contains("encoder preset:"))?;
    names[start + 1..]
        .iter()
        .find(|name| !name.trim().is_empty() && !name.to_ascii_lowercase().starts_with("encoder"))
        .cloned()
}

fn container(format: &str, destination: &str) -> Container {
    let value = format.to_ascii_lowercase();
    let extension = std::path::Path::new(destination)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if value.contains("mkv") || extension == "mkv" {
        Container::Mkv
    } else if value.contains("m4v") || extension == "m4v" {
        Container::M4v
    } else if value.contains("mov") || extension == "mov" {
        Container::Mov
    } else if value.contains("mp4") || extension == "mp4" {
        Container::Mp4
    } else if value.contains("mpegts") || extension == "ts" {
        Container::Mpegts
    } else if value.contains("avi") || extension == "avi" {
        Container::Avi
    } else {
        Container::Unknown
    }
}

fn source_container(source: &str) -> Container {
    let extension = std::path::Path::new(source)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    container(&extension, source)
}

fn basename_without_extension(value: &str) -> String {
    std::path::Path::new(value)
        .file_stem()
        .and_then(|part| part.to_str())
        .unwrap_or(value)
        .to_lowercase()
}

const UI_AUTOMATION_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$windows = @()
function Read-Controls($root) {
  $nodes = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $controls = @()
  foreach ($node in $nodes) {
    $current = $node.Current
    if ($current.IsOffscreen) { continue }
    $kind = $current.ControlType.ProgrammaticName
    if ($kind -notmatch 'Text|Edit|ComboBox|CheckBox|RadioButton|Slider|ListItem|DataItem|List|Button') { continue }
    $value = $null; $selected = $null; $toggle = $null; $range = $null; $isSelected = $null
    try { $value = $node.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch {}
    try {
      $selection = $node.GetCurrentPattern([System.Windows.Automation.SelectionPattern]::Pattern).Current.GetSelection()
      if ($selection.Count -gt 0) { $selected = ($selection | ForEach-Object { $_.Current.Name }) -join ', ' }
    } catch {}
    try { $toggle = $node.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Current.ToggleState.ToString() } catch {}
    try { $range = $node.GetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern).Current.Value } catch {}
    try { $isSelected = $node.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected } catch {}
    $name = [string]$current.Name
    if ($current.AutomationId -or $name -or $value -or $selected -or $toggle -or $null -ne $range -or $null -ne $isSelected) {
      $controls += [pscustomobject]@{
        id = [string]$current.AutomationId; name = $name; value = $value; selected = $selected
        toggle = $toggle; range = $range; isSelected = $isSelected; type = $kind
      }
    }
  }
  return ,@($controls)
}
foreach ($process in @(Get-Process -Name HandBrake -ErrorAction SilentlyContinue)) {
  if ($process.MainWindowHandle -eq 0) { continue }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
  $tabsData = @{}
  $allNodes = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $tabControl = $allNodes | Where-Object { $_.Current.AutomationId -eq 'tabControl' } | Select-Object -First 1
  $originalTab = $null; $originalTabName = $null
  if ($tabControl) {
    try {
      $selection = $tabControl.GetCurrentPattern([System.Windows.Automation.SelectionPattern]::Pattern).Current.GetSelection()
      if ($selection.Count -gt 0) { $originalTab = $selection[0]; $originalTabName = [string]$originalTab.Current.Name }
    } catch {}
  }
  $tabItems = @($allNodes | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::TabItem })
  if (-not $originalTab) {
    foreach ($tab in $tabItems) {
      try {
        if ($tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected) {
          $originalTab = $tab
          $originalTabName = [string]$tab.Current.Name
          break
        }
      } catch {}
    }
  }
  if ($originalTab -and $originalTabName) {
    $tabsData[$originalTabName] = Read-Controls $root
  }
  $nodes = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $texts = @(); $elements = @()
  foreach ($node in $nodes) {
    $current = $node.Current; $name = [string]$current.Name; $value = $null; $selected = $null
    try { $value = $node.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch {}
    try {
      $selection = $node.GetCurrentPattern([System.Windows.Automation.SelectionPattern]::Pattern).Current.GetSelection()
      if ($selection.Count -gt 0) { $selected = $selection[0].Current.Name }
    } catch {}
    if ($current.ControlType -eq [System.Windows.Automation.ControlType]::Text -and $name) { $texts += $name }
    if ($current.AutomationId -or $name -or $value -or $selected) {
      $elements += [pscustomobject]@{ id = [string]$current.AutomationId; name = $name; value = $value; selected = $selected; type = $current.ControlType.ProgrammaticName }
    }
  }
  $sourceName = $null; $sourceSummary = $null; $durationText = $null; $titleText = $null; $preset = $null
  for ($i = 0; $i -lt $texts.Count; $i++) {
    if ($texts[$i] -eq 'Source:' -and $i + 1 -lt $texts.Count) { $sourceName = $texts[$i + 1] }
    if ($texts[$i] -match '^\d{3,5}x\d{3,5}.*FPS') { $sourceSummary = $texts[$i] }
    if ($texts[$i] -match '^Duration:\s*$' -and $i + 1 -lt $texts.Count) { $durationText = $texts[$i + 1] }
    if ($texts[$i] -match '^Title:\s*$' -and $i + 1 -lt $texts.Count) { $titleText = $texts[$i + 1] }
    if ($texts[$i] -match '^Preset:\s*$' -and $i + 1 -lt $texts.Count) { $preset = $texts[$i + 1] }
  }
  $titleControl = $elements | Where-Object { $_.id -eq 'Titles' } | Select-Object -First 1
  if ($titleControl -and $titleControl.selected) { $titleText = $titleControl.selected }
  $destinationControl = $elements | Where-Object { $_.id -eq 'Destination' } | Select-Object -First 1
  $statusControl = $elements | Where-Object { $_.id -eq 'statusBar' } | Select-Object -First 1
  $windows += [pscustomobject]@{
    processId = $process.Id; windowTitle = $root.Current.Name; elements = @($elements); texts = @($texts)
    sourceDisplayName = $sourceName; sourceSummary = $sourceSummary; durationText = $durationText
    titleText = $titleText; preset = $preset
    destination = if ($destinationControl) { $destinationControl.value } else { $null }
    status = if ($statusControl) { $statusControl.name } else { $null }
    tabs = $tabsData
  }
}
ConvertTo-Json -InputObject @($windows) -Depth 7 -Compress
"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn ui_element(
        id: Option<&str>,
        name: Option<&str>,
        value: Option<&str>,
        range: Option<f64>,
        control_type: &str,
        is_selected: Option<bool>,
    ) -> UiElement {
        UiElement {
            id: id.map(str::to_owned),
            name: name.map(str::to_owned),
            value: value.map(str::to_owned),
            selected: None,
            toggle: None,
            range,
            is_selected,
            control_type: Some(control_type.to_owned()),
        }
    }

    #[test]
    fn parses_handbrake_dimensions_duration_and_rate_units() {
        assert_eq!(dimensions("1920x1080 23.976 FPS"), (Some(1920), Some(1080)));
        assert_eq!(parse_duration(Some("01:09:30")), Some(4170.0));
        assert_eq!(number_before("AAC (160 kbps)", "kbps"), Some(160.0));
    }

    #[test]
    fn reads_constant_quality_and_rf_from_video_controls() {
        let controls = vec![
            ui_element(
                None,
                Some("Constant Quality"),
                None,
                None,
                "ControlType.RadioButton",
                Some(true),
            ),
            ui_element(
                Some("VideoQualitySlider"),
                Some("Constant Quality"),
                None,
                Some(22.5),
                "ControlType.Slider",
                None,
            ),
            ui_element(
                None,
                Some("Framerate (FPS)"),
                Some("30"),
                None,
                "ControlType.Edit",
                None,
            ),
        ];

        assert_eq!(video_rate_mode(&controls), RateMode::ConstantQuality);
        assert_eq!(
            numeric_setting(
                &controls,
                &["constant quality", "video quality", "quality", "rf"]
            ),
            Some(22.5)
        );
    }

    #[test]
    fn reads_average_bitrate_from_video_control_value() {
        let controls = vec![
            ui_element(
                None,
                Some("Avg Bitrate"),
                None,
                None,
                "ControlType.RadioButton",
                Some(true),
            ),
            ui_element(
                Some("VideoBitrate"),
                Some("Avg Bitrate (kbps)"),
                Some("2500"),
                None,
                "ControlType.Edit",
                None,
            ),
        ];

        assert_eq!(video_rate_mode(&controls), RateMode::AverageBitrate);
        assert_eq!(
            numeric_setting(&controls, &["avg bitrate", "video bitrate", "bitrate"]),
            Some(2500.0)
        );
    }

    #[test]
    fn automation_reads_only_the_selected_tab_without_switching_tabs() {
        assert!(UI_AUTOMATION_SCRIPT.contains("$tabsData[$originalTabName] = Read-Controls $root"));
        assert!(!UI_AUTOMATION_SCRIPT.contains(".Select()"));
        assert!(!UI_AUTOMATION_SCRIPT.contains("Start-Sleep"));
    }

    #[test]
    fn extracts_summary_tracks_without_guessing_unlisted_tracks() {
        let lines = vec![
            "Tracks:".to_owned(),
            "1: English (AAC) (160 kbps)".to_owned(),
            "1: English (Burned)".to_owned(),
            "Chapter Markers".to_owned(),
        ];
        let (audio, subtitles) = summary_tracks(&lines);
        assert_eq!(audio.len(), 1);
        assert_eq!(subtitles.len(), 1);
        assert!(subtitles[0].contains("Burned"));
    }

    #[test]
    fn maps_common_handbrake_output_formats_and_encoders() {
        assert_eq!(container("av_mp4", ""), Container::Mp4);
        assert_eq!(container("", r"C:\Video\encode.mkv"), Container::Mkv);
        assert_eq!(video_codec("H.265 10-bit (x265)"), VideoCodec::X265);
        assert_eq!(subtitle_codec("English (PGS)"), SubtitleCodec::Bitmap);
        assert_eq!(track_index("1: English (AAC)"), Some(0));
        assert_eq!(track_index("Audio Track: Title 2 English"), Some(1));
    }
}
