use anyhow::{Context, Result, anyhow};
use serde_json::Value;
use std::{path::Path, process::Command};

use crate::model::{
    AudioCodec, AudioTrack, Container, MediaInfo, SubtitleCodec, SubtitleTrack, VideoCodec,
    VideoTrack,
};

fn number(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str()?.parse().ok())
        .filter(|parsed: &f64| parsed.is_finite() && *parsed >= 0.0)
}

fn ratio(value: &Value) -> Option<f64> {
    let value = value.as_str()?;
    let (left, right) = value.split_once('/').unwrap_or((value, "1"));
    let result = left.parse::<f64>().ok()? / right.parse::<f64>().ok()?;
    (result.is_finite() && result > 0.0).then_some(result)
}

fn video_codec(value: &str) -> VideoCodec {
    let codec = value.to_ascii_lowercase();
    if codec.contains("x264") {
        VideoCodec::X264
    } else if codec.contains("x265") {
        VideoCodec::X265
    } else if codec.contains("264") || codec == "avc" {
        VideoCodec::H264
    } else if codec.contains("265") || codec.contains("hevc") {
        VideoCodec::Hevc
    } else if codec.contains("av1") {
        VideoCodec::Av1
    } else if codec.contains("vp9") {
        VideoCodec::Vp9
    } else if codec.contains("mpeg4") {
        VideoCodec::Mpeg4
    } else if codec.contains("mpeg2video") {
        VideoCodec::Mpeg2
    } else {
        VideoCodec::Unknown
    }
}

fn container(value: &str) -> Container {
    let name = value.to_ascii_lowercase();
    if name.contains("matroska") || name.contains("webm") {
        Container::Mkv
    } else if name.contains("mov") || name.contains("mp4") || name.contains("m4a") {
        Container::Mp4
    } else if name.contains("mpegts") {
        Container::Mpegts
    } else if name.contains("avi") {
        Container::Avi
    } else {
        Container::Unknown
    }
}

fn tags(stream: &Value) -> &Value {
    stream.get("tags").unwrap_or(&Value::Null)
}

fn tag<'a>(tags: &'a Value, name: &str) -> Option<&'a str> {
    let object = tags.as_object()?;
    object.iter().find_map(|(key, value)| {
        (key.eq_ignore_ascii_case(name)
            || key
                .to_ascii_lowercase()
                .starts_with(&format!("{}-", name.to_ascii_lowercase())))
        .then(|| value.as_str())
        .flatten()
    })
}

fn audio_codec(value: &str) -> AudioCodec {
    AudioCodec::from_name(value)
}

fn subtitle_codec(value: &str) -> SubtitleCodec {
    let name = value.to_ascii_lowercase();
    if name.contains("pgs") || name.contains("dvd_subtitle") || name.contains("dvb_subtitle") {
        SubtitleCodec::Bitmap
    } else if name.contains("subrip") || name.contains("text") {
        SubtitleCodec::Subrip
    } else if name.contains("ass") || name.contains("ssa") {
        SubtitleCodec::Ass
    } else {
        SubtitleCodec::Unknown
    }
}

pub fn scan(path: &Path, configured_cli: Option<&str>) -> Result<MediaInfo> {
    let metadata = std::fs::metadata(path).context("Could not read source file metadata.")?;
    let output = Command::new(if cfg!(target_os = "windows") { "ffprobe.exe" } else { "ffprobe" })
        .args([
            "-v", "error", "-show_entries",
            "format=format_name,duration,size,bit_rate:stream=index,codec_type,codec_name,duration,bit_rate,width,height,avg_frame_rate,r_frame_rate,channels,channel_layout,sample_rate:stream_tags",
            "-of", "json",
        ])
        .arg(path)
        .output();
    let ffprobe_failure = match output {
        Ok(output) if output.status.success() => {
            let root: Value = serde_json::from_slice(&output.stdout)
                .context("ffprobe returned malformed JSON.")?;
            let mut media = parse_ffprobe(&root, path, metadata.len())?;
            if let Some(cli) = crate::handbrake::find_handbrake_cli(configured_cli) {
                match cli_version(&cli) {
                    Ok(version) => media.handbrake_version = Some(version),
                    Err(error) => {
                        media.scan_error = Some(format!(
                            "Media scan succeeded, but HandBrakeCLI version detection failed: {error:#}"
                        ))
                    }
                }
            }
            return Ok(media);
        }
        Ok(output) => format!(
            "ffprobe could not scan this file: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ),
        Err(error) => format!("Could not start ffprobe: {error}"),
    };
    if let Some(cli) = crate::handbrake::find_handbrake_cli(configured_cli) {
        let output = Command::new(&cli)
            .args(["--scan", "-i"])
            .arg(path)
            .output()
            .with_context(|| format!("Could not start HandBrakeCLI at {}.", cli.display()))?;
        if output.status.success() {
            let text = format!(
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            if let Some(mut media) = parse_handbrake_scan(&text, path, metadata.len()) {
                match cli_version(&cli) {
                    Ok(version) => media.handbrake_version = Some(version),
                    Err(error) => {
                        media.scan_error = Some(format!(
                            "HandBrakeCLI scan succeeded, but version detection failed: {error:#}"
                        ))
                    }
                }
                return Ok(media);
            }
        } else {
            return Err(anyhow!(
                "{ffprobe_failure}. HandBrakeCLI scan failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
    }
    Err(anyhow!(
        "{ffprobe_failure}. HandBrakeCLI was not found or returned no recognizable metadata."
    ))
}

fn cli_version(cli: &Path) -> Result<String> {
    let output = Command::new(cli)
        .arg("--version")
        .output()
        .with_context(|| format!("Could not start HandBrakeCLI at {}.", cli.display()))?;
    if !output.status.success() {
        return Err(anyhow!(
            "HandBrakeCLI --version exited with {}",
            output.status
        ));
    }
    let version_text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    version_text
        .lines()
        .find(|line| line.to_ascii_lowercase().contains("version"))
        .map(str::trim)
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("HandBrakeCLI --version returned no version string."))
}

pub fn parse_ffprobe(root: &Value, path: &Path, file_size: u64) -> Result<MediaInfo> {
    let format = root.get("format").unwrap_or(&Value::Null);
    let format_name = format
        .get("format_name")
        .and_then(Value::as_str)
        .unwrap_or("");
    let streams = root
        .get("streams")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let video = streams
        .iter()
        .find(|stream| stream["codec_type"] == "video");
    let duration = number(&format["duration"]);
    let video_tracks: Vec<VideoTrack> = video
        .iter()
        .map(|stream| VideoTrack {
            index: number(&stream["index"]).map(|value| value as u32),
            codec: video_codec(stream["codec_name"].as_str().unwrap_or("")),
            width: number(&stream["width"]).map(|value| value as u32),
            height: number(&stream["height"]).map(|value| value as u32),
            frame_rate: ratio(&stream["avg_frame_rate"]).or_else(|| ratio(&stream["r_frame_rate"])),
            bitrate_kbps: number(&stream["bit_rate"]).map(|value| value / 1000.0),
        })
        .collect();
    let audio_tracks: Vec<AudioTrack> = streams
        .iter()
        .filter(|stream| stream["codec_type"] == "audio")
        .enumerate()
        .map(|(index, stream)| AudioTrack {
            index,
            stream_index: number(&stream["index"]).map(|value| value as u32),
            codec: audio_codec(stream["codec_name"].as_str().unwrap_or("")),
            language: tag(tags(stream), "language").map(str::to_owned),
            channels: number(&stream["channels"]).map(|value| value as u32),
            channel_layout: stream["channel_layout"].as_str().map(str::to_owned),
            sample_rate: number(&stream["sample_rate"]).map(|value| value as u32),
            duration_seconds: number(&stream["duration"]),
            bitrate_kbps: number(&stream["bit_rate"]).map(|value| value / 1000.0),
            stream_size_bytes: tag(tags(stream), "NUMBER_OF_BYTES")
                .and_then(|value| value.parse().ok()),
        })
        .collect();
    let subtitle_tracks: Vec<SubtitleTrack> = streams
        .iter()
        .filter(|stream| stream["codec_type"] == "subtitle")
        .enumerate()
        .map(|(index, stream)| {
            let codec = subtitle_codec(stream["codec_name"].as_str().unwrap_or(""));
            SubtitleTrack {
                index,
                codec,
                language: tag(tags(stream), "language").map(str::to_owned),
                is_bitmap: codec == SubtitleCodec::Bitmap,
            }
        })
        .collect();
    if video_tracks.is_empty() && duration.is_none() {
        return Err(anyhow!(
            "ffprobe returned no usable video stream or duration."
        ));
    }
    let first_video = video_tracks.first();
    Ok(MediaInfo {
        file_path: path.to_string_lossy().into_owned(),
        duration_seconds: duration,
        width: first_video.and_then(|track| track.width),
        height: first_video.and_then(|track| track.height),
        frame_rate: first_video.and_then(|track| track.frame_rate),
        container: container(format_name),
        source_file_size_bytes: Some(file_size),
        video_tracks,
        audio_tracks,
        subtitle_tracks,
        handbrake_version: None,
        scan_error: None,
    })
}

fn parse_handbrake_scan(raw: &str, path: &Path, file_size: u64) -> Option<MediaInfo> {
    let mut media = MediaInfo {
        file_path: path.to_string_lossy().into_owned(),
        source_file_size_bytes: Some(file_size),
        ..Default::default()
    };
    let lines: Vec<&str> = raw.lines().collect();
    let mut section = "";
    for line in &lines {
        let lower = line.to_ascii_lowercase();
        if lower.trim_start().starts_with("+ duration:") {
            media.duration_seconds = line
                .split_once(':')
                .and_then(|(_, value)| parse_duration(value.trim()));
        } else if media.duration_seconds.is_none()
            && lower.trim_start().starts_with("+ title ")
            && let Some((_, value)) = line.split_once(':')
        {
            media.duration_seconds = parse_duration(value.trim());
        }
        if lower.trim_start().starts_with("+ size:")
            && let Some((width, height)) = line
                .split_once(':')
                .and_then(|(_, value)| value.trim().split_once('x'))
        {
            media.width = width.trim().parse().ok();
            media.height = height
                .split(|character: char| !character.is_ascii_digit())
                .next()?
                .parse()
                .ok();
        }
        if let Some(position) = lower.find(" fps") {
            let start = line[..position]
                .rfind(|character: char| !character.is_ascii_digit() && character != '.')
                .map_or(0, |index| index + 1);
            media.frame_rate = line[start..position]
                .parse()
                .ok()
                .filter(|value: &f64| *value > 0.0);
        }
        if lower.contains("+ audio tracks:") {
            section = "audio";
            continue;
        }
        if lower.contains("+ subtitle tracks:") {
            section = "subtitle";
            continue;
        }
        if lower.trim_start().starts_with("+ video track:") {
            section = "video";
            continue;
        }
        if lower.trim_start().starts_with("+ chapters:") {
            section = "";
        }
        let trimmed = line.trim_start();
        if section == "video" {
            if let Some(codec_line) = trimmed.to_ascii_lowercase().strip_prefix("+ codec:") {
                let codec_name = codec_line.trim();
                let codec = video_codec(codec_name);
                media.video_tracks.push(VideoTrack {
                    index: Some(0),
                    codec,
                    width: media.width,
                    height: media.height,
                    frame_rate: media.frame_rate,
                    bitrate_kbps: None,
                });
            } else if let Some(rate) = trimmed.to_ascii_lowercase().strip_prefix("+ bitrate:")
                && let Some(track) = media.video_tracks.first_mut()
            {
                track.bitrate_kbps = rate
                    .split_whitespace()
                    .next()
                    .and_then(|value| value.parse().ok());
            }
        } else if (section == "audio" || section == "subtitle")
            && let Some(track_line) = trimmed.strip_prefix("+ ")
        {
            let Some((ordinal, remainder)) = track_line.split_once(',') else {
                continue;
            };
            let Ok(one_based_index) = ordinal.trim().parse::<usize>() else {
                continue;
            };
            let Some((language, details)) = remainder.trim().split_once('(') else {
                continue;
            };
            let details = details.trim_end_matches(')').trim();
            if section == "audio" {
                let lower = details.to_ascii_lowercase();
                let channels = lower
                    .split(" ch")
                    .next()
                    .and_then(|chunk| chunk.rsplit([' ', ',']).next())
                    .and_then(|chunk| chunk.parse::<f64>().ok())
                    .map(|value| value.ceil() as u32);
                let sample_rate = lower
                    .split(" hz")
                    .next()
                    .and_then(|chunk| chunk.rsplit([' ', ',']).next())
                    .and_then(|chunk| chunk.parse().ok());
                let bitrate = lower
                    .split(" kbps")
                    .next()
                    .and_then(|chunk| chunk.rsplit([' ', ',']).next())
                    .and_then(|chunk| chunk.parse().ok());
                media.audio_tracks.push(AudioTrack {
                    index: one_based_index.saturating_sub(1),
                    codec: audio_codec(details),
                    language: Some(language.trim().to_owned()),
                    channels,
                    sample_rate,
                    bitrate_kbps: bitrate,
                    ..Default::default()
                });
            } else {
                let lower = details.to_ascii_lowercase();
                let codec = if lower.contains("pgs")
                    || lower.contains("vobsub")
                    || lower.contains("bitmap")
                {
                    SubtitleCodec::Bitmap
                } else if lower.contains("srt")
                    || lower.contains("subrip")
                    || lower.contains("text")
                {
                    SubtitleCodec::Subrip
                } else {
                    SubtitleCodec::Unknown
                };
                media.subtitle_tracks.push(SubtitleTrack {
                    index: one_based_index.saturating_sub(1),
                    codec,
                    language: Some(language.trim().to_owned()),
                    is_bitmap: codec == SubtitleCodec::Bitmap,
                });
            }
        }
    }
    if media.video_tracks.is_empty() && media.width.is_none() && media.duration_seconds.is_none() {
        None
    } else {
        Some(media)
    }
}

fn parse_duration(value: &str) -> Option<f64> {
    let value = value.split(',').next()?.trim();
    let mut parts = value.split(':').rev();
    let seconds = parts.next()?.parse::<f64>().ok()?;
    let minutes = parts.next()?.parse::<f64>().ok()?;
    let hours = parts.next()?.parse::<f64>().ok()?;
    let duration = hours * 3600.0 + minutes * 60.0 + seconds;
    (duration.is_finite() && duration > 0.0).then_some(duration)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ffprobe_streams_and_converts_bitrates() {
        let data = serde_json::json!({
            "format": {"format_name":"mov,mp4,m4a","duration":"60","size":"1000"},
            "streams": [
                {"index":0,"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"avg_frame_rate":"24/1","bit_rate":"2000000"},
                {"index":1,"codec_type":"audio","codec_name":"aac","channels":2,"bit_rate":"160000","tags":{"language":"en"}},
                {"index":2,"codec_type":"subtitle","codec_name":"subrip","tags":{"language":"en"}}
            ]
        });
        let media = parse_ffprobe(&data, Path::new("input.mp4"), 1000).unwrap();
        assert_eq!(media.container, Container::Mp4);
        assert_eq!(media.video_tracks[0].bitrate_kbps, Some(2000.0));
        assert_eq!(media.audio_tracks[0].bitrate_kbps, Some(160.0));
        assert_eq!(media.subtitle_tracks[0].codec, SubtitleCodec::Subrip);
    }

    #[test]
    fn parses_handbrake_cli_scan_output() {
        let scan = "
+ duration: 01:02:03
+ size: 1920x1080
+ Video track:
+ codec: H.264 (x264)
+ bitrate: 2200 kbps
+ audio tracks:
+ 1, English (AAC, 2.0 ch, 48000 Hz, 160 kbps)
+ subtitle tracks:
+ 1, English (UTF-8)
";
        let media = parse_handbrake_scan(scan, Path::new("video.mp4"), 100).unwrap();
        assert_eq!(media.duration_seconds, Some(3723.0));
        assert_eq!(media.video_tracks[0].codec, VideoCodec::X264);
        assert_eq!(media.audio_tracks[0].bitrate_kbps, Some(160.0));
        assert_eq!(media.subtitle_tracks.len(), 1);
    }
}
