use anyhow::{Context, Result};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
};

use crate::model::{
    AudioCodec, AudioOutput, Container, OutputSettings, RateMode, SubtitleCodec, SubtitleOutput,
    VideoCodec,
};

#[derive(Clone, Debug)]
pub struct QueuedSettings {
    pub status: String,
    pub source_path: String,
    pub destination_path: String,
    pub duration_seconds: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub source_audio_tracks: Vec<crate::model::AudioTrack>,
    pub source_subtitle_tracks: Vec<crate::model::SubtitleTrack>,
    pub settings: OutputSettings,
}

fn candidate_queue_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    #[cfg(target_os = "windows")]
    if let Some(app_data) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(app_data).join("HandBrake"));
    }
    #[cfg(target_os = "macos")]
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(PathBuf::from(home).join("Library/Application Support/HandBrake"));
    }
    #[cfg(target_os = "linux")]
    if let Some(config) = std::env::var_os("XDG_CONFIG_HOME") {
        dirs.push(PathBuf::from(config).join("ghb"));
    }
    #[cfg(target_os = "linux")]
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(PathBuf::from(home).join(".config/ghb"));
    }
    dirs
}

fn encoder_name(value: &Value) -> String {
    value
        .as_str()
        .or_else(|| value.get("ShortName").and_then(Value::as_str))
        .or_else(|| value.get("DisplayName").and_then(Value::as_str))
        .or_else(|| value.get("Name").and_then(Value::as_str))
        .unwrap_or_default()
        .to_owned()
}

fn codec(value: &str) -> VideoCodec {
    let value = value.to_lowercase();
    if value.contains("x264") {
        VideoCodec::X264
    } else if value.contains("x265") {
        VideoCodec::X265
    } else if value.contains("av1") {
        VideoCodec::Av1
    } else if value.contains("vp9") {
        VideoCodec::Vp9
    } else if value.contains("hevc") || value.contains("265") {
        VideoCodec::Hevc
    } else if value.contains("h.264") || value.contains("h264") {
        VideoCodec::H264
    } else if value.contains("mpeg4") || value.contains("mpeg-4") {
        VideoCodec::Mpeg4
    } else if value.contains("mpeg2") || value.contains("mpeg-2") {
        VideoCodec::Mpeg2
    } else {
        VideoCodec::Unknown
    }
}

fn container(value: &str, path: &str) -> Container {
    let lower = value.to_lowercase();
    let extension = Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if lower.contains("mkv") {
        Container::Mkv
    } else if lower.contains("m4v") || extension == "m4v" {
        Container::M4v
    } else if lower.contains("mov") || extension == "mov" {
        Container::Mov
    } else if lower.contains("mp4") || extension == "mp4" {
        Container::Mp4
    } else if lower.contains("mpegts") || extension == "ts" {
        Container::Mpegts
    } else if lower.contains("avi") || extension == "avi" {
        Container::Avi
    } else {
        Container::Unknown
    }
}

fn number(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str()?.parse().ok())
        .filter(|number: &f64| number.is_finite())
}

fn truth(value: &Value) -> bool {
    value.as_bool() == Some(true) || value.as_i64() == Some(1)
}

fn optional_truth(value: &Value) -> Option<bool> {
    value
        .as_bool()
        .or_else(|| value.as_i64().map(|value| value == 1))
}

fn value_text(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_owned());
    }
    if let Some(object) = value.as_object() {
        return object
            .get("ShortName")
            .or_else(|| object.get("DisplayName"))
            .or_else(|| object.get("Name"))
            .and_then(Value::as_str)
            .map(str::to_owned);
    }
    if let Some(array) = value.as_array() {
        let values: Vec<&str> = array
            .iter()
            .filter_map(|item| {
                item.as_str()
                    .or_else(|| item.get("ShortName").and_then(Value::as_str))
            })
            .collect();
        return (!values.is_empty()).then(|| values.join(", "));
    }
    (!value.is_null()).then(|| value.to_string())
}

fn channel_count(value: &Value) -> Option<u32> {
    let layout = value.as_str()?.to_lowercase().replace("point", ".");
    if layout == "mono" {
        return Some(1);
    }
    if layout == "stereo" {
        return Some(2);
    }
    let (main, lfe) = layout.split_once('.').unwrap_or((&layout, "0"));
    let main: u32 = main.parse().ok()?;
    let lfe: u32 = lfe.parse().ok()?;
    Some(main + u32::from(lfe > 0))
}

fn duration_seconds(value: &Value) -> Option<f64> {
    let text = value.as_str()?;
    let pieces: Vec<f64> = text
        .split(':')
        .map(str::parse)
        .collect::<Result<_, _>>()
        .ok()?;
    match pieces.as_slice() {
        [hours, minutes, seconds] => Some(hours * 3600.0 + minutes * 60.0 + seconds),
        _ => None,
    }
}

fn parse_entry(entry: &Value) -> Option<QueuedSettings> {
    let task = entry.get("Task")?;
    let job = task.get("Job").unwrap_or(task);
    let source_path = job
        .get("Source")
        .and_then(|source| {
            source
                .as_str()
                .or_else(|| source.get("Path").and_then(Value::as_str))
        })
        .or_else(|| entry.get("ScannedSourcePath").and_then(Value::as_str))
        .or_else(|| {
            entry
                .pointer("/SourceTitleInfo/SourcePath")
                .and_then(Value::as_str)
        })?
        .to_owned();
    let destination = job
        .get("Destination")
        .and_then(|value| {
            value
                .as_str()
                .or_else(|| value.get("File").and_then(Value::as_str))
        })
        .unwrap_or("");
    let video_encoder = encoder_name(
        job.get("VideoEncoder")
            .or_else(|| job.pointer("/Video/Encoder"))
            .unwrap_or(&Value::Null),
    );
    let rate_type = job
        .get("VideoEncodeRateType")
        .or_else(|| job.pointer("/Video/VideoEncodeRateType"))
        .and_then(number);
    let bitrate = number(
        job.get("VideoBitrate")
            .or_else(|| job.pointer("/Video/Bitrate"))
            .unwrap_or(&Value::Null),
    )
    .filter(|value| *value > 0.0);
    let quality = number(
        job.get("Quality")
            .or_else(|| job.pointer("/Video/Quality"))
            .unwrap_or(&Value::Null),
    )
    .filter(|value| *value >= 0.0);
    let mode = if rate_type == Some(2.0)
        || rate_type.is_none() && bitrate.is_none() && quality.is_some()
    {
        RateMode::ConstantQuality
    } else {
        RateMode::AverageBitrate
    };
    let audio_value = job
        .get("AudioTracks")
        .or_else(|| job.pointer("/Audio/AudioList"));
    let audio = audio_value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(ordinal, track)| {
            let scanned_track = track.get("ScannedTrack").unwrap_or(&Value::Null);
            let index = track
                .get("Track")
                .and_then(Value::as_u64)
                .map(|number| number.saturating_sub(1) as usize)
                .or_else(|| {
                    scanned_track
                        .get("TrackNumber")
                        .and_then(Value::as_u64)
                        .map(|number| number as usize)
                })
                .unwrap_or(ordinal);
            let encoder = encoder_name(track.get("Encoder").unwrap_or(&Value::Null));
            let audio_codec = AudioCodec::from_name(&encoder);
            let track_quality =
                number(track.get("Quality").unwrap_or(&Value::Null)).filter(|value| *value >= 0.0);
            let bitrate_mode = track.get("EncoderRateType").and_then(number) == Some(0.0)
                || track
                    .get("EncoderRateType")
                    .and_then(Value::as_str)
                    .is_some_and(|rate| rate.to_lowercase().contains("bitrate"));
            let track_bitrate = if bitrate_mode {
                number(track.get("Bitrate").unwrap_or(&Value::Null)).filter(|value| *value > 0.0)
            } else {
                None
            };
            AudioOutput {
                index,
                codec: audio_codec,
                bitrate_kbps: track_bitrate,
                quality: track_quality,
                passthrough: audio_codec == AudioCodec::Copy,
                enabled: true,
                source_track_match: Some(true),
                channels: channel_count(&scanned_track["ChannelLayout"]),
                mixdown: value_text(track.get("MixDown").unwrap_or(&Value::Null)),
                sample_rate: number(track.get("SampleRate").unwrap_or(&Value::Null))
                    .filter(|value| *value > 0.0)
                    .map(|value| value as u32),
                gain_db: number(track.get("Gain").unwrap_or(&Value::Null)),
                drc: number(track.get("DRC").unwrap_or(&Value::Null)),
                encoder_options: track
                    .get("EncoderOptions")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            }
        })
        .collect();
    let subtitles = job
        .get("SubtitleTracks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(index, track)| {
            let source_track = track.get("SourceTrack").unwrap_or(&Value::Null);
            let subtitle_name = source_track
                .get("TypeString")
                .and_then(Value::as_str)
                .unwrap_or("");
            let name = subtitle_name.to_lowercase();
            let subtitle_codec =
                if name.contains("vobsub") || name.contains("pgs") || name.contains("bitmap") {
                    SubtitleCodec::Bitmap
                } else if name.contains("srt") || name.contains("subrip") {
                    SubtitleCodec::Subrip
                } else if name.contains("ass") || name.contains("ssa") {
                    SubtitleCodec::Ass
                } else {
                    SubtitleCodec::Unknown
                };
            SubtitleOutput {
                index: source_track
                    .get("TrackNumber")
                    .and_then(Value::as_u64)
                    .map(|number| number as usize)
                    .unwrap_or(index),
                codec: subtitle_codec,
                enabled: true,
                burn_in: truth(
                    track
                        .get("Burned")
                        .or_else(|| track.get("Burn"))
                        .unwrap_or(&Value::Null),
                ),
                forced_only: optional_truth(track.get("Forced").unwrap_or(&Value::Null)),
                default: optional_truth(track.get("Default").unwrap_or(&Value::Null)),
                track_name: track.get("Name").and_then(Value::as_str).map(str::to_owned),
            }
        })
        .collect();
    let title = entry.get("SourceTitleInfo").unwrap_or(&Value::Null);
    let resolution = title.get("Resolution").unwrap_or(&Value::Null);
    let source_audio_tracks = title
        .get("AudioTracks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(ordinal, track)| {
            let bitrate = number(track.get("Bitrate").unwrap_or(&Value::Null))
                .filter(|value| *value > 0.0)
                .map(|value| {
                    if value >= 10000.0 {
                        value / 1000.0
                    } else {
                        value
                    }
                });
            crate::model::AudioTrack {
                index: track
                    .get("TrackNumber")
                    .and_then(Value::as_u64)
                    .map(|number| number.saturating_sub(1) as usize)
                    .unwrap_or(ordinal),
                codec: AudioCodec::from_name(
                    track
                        .get("Description")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                ),
                language: track
                    .get("Language")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                channels: channel_count(&track["ChannelLayout"]),
                bitrate_kbps: bitrate,
                ..Default::default()
            }
        })
        .collect();
    let source_subtitle_tracks = title
        .get("Subtitles")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(ordinal, track)| {
            let name = track
                .get("TypeString")
                .or_else(|| track.get("SubtitleType"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_lowercase();
            let codec =
                if name.contains("pgs") || name.contains("vobsub") || name.contains("bitmap") {
                    SubtitleCodec::Bitmap
                } else if name.contains("srt") || name.contains("subrip") {
                    SubtitleCodec::Subrip
                } else if name.contains("ass") || name.contains("ssa") {
                    SubtitleCodec::Ass
                } else {
                    SubtitleCodec::Unknown
                };
            crate::model::SubtitleTrack {
                index: track
                    .get("TrackNumber")
                    .and_then(Value::as_u64)
                    .map(|number| number.saturating_sub(1) as usize)
                    .unwrap_or(ordinal),
                codec,
                language: track
                    .get("Language")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                is_bitmap: codec == SubtitleCodec::Bitmap,
            }
        })
        .collect();
    let destination_container = job
        .get("OutputFormat")
        .and_then(Value::as_str)
        .unwrap_or("");
    let filter_fields = [
        "Cropping",
        "DeinterlaceFilter",
        "CombDetect",
        "CustomCombDetect",
        "Detelecine",
        "CustomDetelecine",
        "Denoise",
        "CustomDenoise",
        "Grayscale",
        "Rotation",
        "FlipVideo",
        "Sharpen",
        "SharpenPreset",
        "SharpenTune",
        "SharpenCustom",
        "DeblockPreset",
        "DeblockTune",
        "CustomDeblock",
        "Padding",
        "Colourspace",
        "CustomColourspace",
        "ChromaSmooth",
        "ChromaSmoothTune",
        "CustomChromaSmooth",
    ];
    let filter_signature = Value::Object(
        filter_fields
            .iter()
            .filter_map(|key| job.get(*key).map(|value| ((*key).into(), value.clone())))
            .collect(),
    );
    let filter_signature = (!filter_signature
        .as_object()
        .is_some_and(|object| object.is_empty()))
    .then(|| filter_signature.to_string());
    let video_profile = job
        .get("VideoProfile")
        .or_else(|| job.pointer("/Video/Profile"));
    let video_level = job
        .get("VideoLevel")
        .or_else(|| job.pointer("/Video/Level"));
    let encoder_tune = job.get("VideoTunes").or_else(|| job.pointer("/Video/Tune"));
    let filter_values = job.get("VideoFilters").or_else(|| job.get("Filters"));
    let frame_rate_mode = value_text(job.get("FramerateMode").unwrap_or(&Value::Null));
    let output_width = number(job.get("Width").unwrap_or(&Value::Null))
        .filter(|value| *value > 0.0)
        .map(|value| value as u32);
    let output_height = number(job.get("Height").unwrap_or(&Value::Null))
        .filter(|value| *value > 0.0)
        .map(|value| value as u32);
    Some(QueuedSettings {
        status: match entry.get("Status").and_then(Value::as_u64).unwrap_or(0) {
            0 => "Waiting".into(),
            1 => "In Progress".into(),
            2 => "Completed".into(),
            value => format!("Queue status {value}"),
        },
        source_path: source_path.clone(),
        destination_path: destination.to_owned(),
        duration_seconds: duration_seconds(title.get("Duration").unwrap_or(&Value::Null)),
        width: resolution
            .get("Width")
            .and_then(Value::as_u64)
            .map(|value| value as u32),
        height: resolution
            .get("Height")
            .and_then(Value::as_u64)
            .map(|value| value as u32),
        source_audio_tracks,
        source_subtitle_tracks,
        settings: OutputSettings {
            mode,
            container: container(destination_container, destination),
            video_codec: codec(&video_encoder),
            video_bitrate_kbps: if mode == RateMode::AverageBitrate {
                bitrate
            } else {
                None
            },
            quality_rf: if mode == RateMode::ConstantQuality {
                quality
            } else {
                None
            },
            preset: encoder_name(
                job.get("VideoPreset")
                    .or_else(|| job.pointer("/Video/Preset"))
                    .unwrap_or(&Value::Null),
            ),
            video_encoder_name: (!video_encoder.is_empty()).then_some(video_encoder),
            encoder_tune: encoder_tune.and_then(value_text),
            encoder_profile: video_profile.and_then(value_text),
            encoder_level: video_level.and_then(value_text),
            encoder_options: job
                .get("ExtraAdvancedArguments")
                .and_then(Value::as_str)
                .map(str::to_owned),
            output_width,
            output_height,
            frame_rate_mode,
            frame_rate: number(job.get("Framerate").unwrap_or(&Value::Null)),
            filter_signature: filter_signature.or_else(|| filter_values.map(Value::to_string)),
            two_pass: truth(
                job.get("MultiPass")
                    .or_else(|| job.pointer("/Video/MultiPass"))
                    .unwrap_or(&Value::Null),
            ),
            overhead_percent: None,
            chapters: optional_truth(
                job.get("IncludeChapterMarkers")
                    .or_else(|| job.get("ChapterMarkers"))
                    .unwrap_or(&Value::Null),
            ),
            metadata_passthrough: optional_truth(
                job.get("PassthruMetadataEnabled").unwrap_or(&Value::Null),
            ),
            web_optimized: optional_truth(job.get("Optimize").unwrap_or(&Value::Null)),
            align_av_start: optional_truth(job.get("AlignAVStart").unwrap_or(&Value::Null)),
            ipod_5g_support: optional_truth(job.get("IPod5GSupport").unwrap_or(&Value::Null)),
            audio,
            subtitles,
        },
    })
}

pub fn read_queue_jobs() -> Result<Vec<QueuedSettings>> {
    let mut queue_files = Vec::new();
    for directory in candidate_queue_dirs() {
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("Could not read HandBrake queue at {}.", directory.display())
                });
            }
        };
        for entry in entries {
            let entry = entry?;
            let file_name = entry.file_name().to_string_lossy().to_lowercase();
            if !file_name.starts_with("hb_queue") || !file_name.ends_with(".json") {
                continue;
            }
            let path = entry.path();
            let modified = entry
                .metadata()
                .context("Could not inspect HandBrake queue file.")?
                .modified()
                .context("Could not read HandBrake queue file modification time.")?;
            queue_files.push((modified, path));
        }
    }
    queue_files.sort_by(|(left_time, left_path), (right_time, right_path)| {
        left_time
            .cmp(right_time)
            .then_with(|| left_path.cmp(right_path))
    });

    let mut jobs = Vec::new();
    for (_, path) in queue_files {
        let raw = fs::read_to_string(&path).context("Could not read HandBrake queue JSON.")?;
        let json: Value =
            serde_json::from_str(&raw).context("HandBrake queue JSON is malformed.")?;
        let Some(queue) = json.as_array() else {
            continue;
        };
        for queued in queue {
            if let Some(parsed) = parse_entry(queued)
                && matches!(parsed.status.as_str(), "Waiting" | "In Progress")
            {
                jobs.push(parsed);
            }
        }
    }
    Ok(jobs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_flat_handbrake_queue_schema_and_burned_subtitle_state() {
        let source = r"C:\Videos\Film.mp4";
        let queued = serde_json::json!({
            "Status": 0,
            "ScannedSourcePath": source,
            "SourceTitleInfo": {
                "Duration": "01:49:00",
                "Resolution": {"Width": 1920, "Height": 1080},
                "AudioTracks": [{
                    "TrackNumber": 1,
                    "Description": "AAC",
                    "Language": "en",
                    "ChannelLayout": "5.1",
                    "Bitrate": 384000
                }]
            },
            "Task": {
                "Source": source,
                "Destination": r"C:\Videos\out.mp4",
                "OutputFormat": "av_mp4",
                "VideoEncoder": {"ShortName": "x264"},
                "VideoEncodeRateType": 1,
                "VideoBitrate": 2000,
                "VideoPreset": "slow",
                "VideoTunes": ["film", "grain"],
                "VideoProfile": {"ShortName": "high"},
                "VideoLevel": "4.1",
                "ExtraAdvancedArguments": "ref=4",
                "Width": 1920,
                "Height": 1080,
                "IncludeChapterMarkers": true,
                "Optimize": true,
                "Cropping": {"Top": 0, "Bottom": 0, "Left": 0, "Right": 0},
                "AudioTracks": [{
                    "ScannedTrack": {"TrackNumber": 0},
                    "Encoder": {"ShortName": "av_aac"},
                    "EncoderRateType": 0,
                    "Bitrate": 160,
                    "Quality": -1,
                    "MixDown": "stereo",
                    "SampleRate": 48000,
                    "Gain": 1.5,
                    "DRC": 2.0
                }],
                "SubtitleTracks": [{
                    "SourceTrack": {"TrackNumber": 0, "TypeString": "VobSub"},
                    "Burned": true,
                    "Forced": true,
                    "Default": false
                }]
            }
        });
        let parsed = parse_entry(&queued).unwrap();
        assert_eq!(parsed.settings.video_codec, VideoCodec::X264);
        assert_eq!(parsed.settings.video_bitrate_kbps, Some(2000.0));
        assert_eq!(parsed.settings.audio[0].bitrate_kbps, Some(160.0));
        assert_eq!(parsed.settings.audio[0].mixdown.as_deref(), Some("stereo"));
        assert_eq!(parsed.settings.audio[0].sample_rate, Some(48000));
        assert_eq!(parsed.settings.audio[0].gain_db, Some(1.5));
        assert_eq!(parsed.settings.audio[0].drc, Some(2.0));
        assert!(parsed.settings.subtitles[0].burn_in);
        assert_eq!(parsed.settings.subtitles[0].forced_only, Some(true));
        assert_eq!(parsed.source_audio_tracks[0].bitrate_kbps, Some(384.0));
        assert_eq!(parsed.source_audio_tracks[0].channels, Some(6));
        assert_eq!(parsed.settings.encoder_tune.as_deref(), Some("film, grain"));
        assert_eq!(parsed.settings.encoder_profile.as_deref(), Some("high"));
        assert_eq!(parsed.settings.encoder_options.as_deref(), Some("ref=4"));
        assert!(parsed.settings.filter_signature.is_some());
        assert_eq!(parsed.width, Some(1920));
        assert_eq!(parsed.destination_path, r"C:\Videos\out.mp4");
    }

    #[test]
    fn reads_rf_mode_and_value_from_the_queue_job() {
        let queued = serde_json::json!({
            "Status": 0,
            "SourceTitleInfo": {
                "SourcePath": r"C:\Videos\film.mkv",
                "Duration": "00:45:00",
                "Resolution": {"Width": 1280, "Height": 720}
            },
            "Task": {
                "Job": {
                    "Source": r"C:\Videos\film.mkv",
                    "Destination": r"C:\Output\film.mp4",
                    "VideoEncoder": {"ShortName": "x264"},
                    "VideoEncodeRateType": 2,
                    "Quality": 21.5,
                    "VideoPreset": "slow"
                }
            }
        });
        let parsed = parse_entry(&queued).unwrap();

        assert_eq!(parsed.status, "Waiting");
        assert_eq!(parsed.source_path, r"C:\Videos\film.mkv");
        assert_eq!(parsed.settings.mode, RateMode::ConstantQuality);
        assert_eq!(parsed.settings.quality_rf, Some(21.5));
        assert_eq!(parsed.settings.video_bitrate_kbps, None);
    }

    #[test]
    fn destination_folder_names_do_not_change_the_detected_container() {
        assert_eq!(container("", r"C:\Movies\film.avi"), Container::Avi);
        assert_eq!(container("av_mp4", r"C:\Movies\film.mp4"), Container::Mp4);
    }
}
