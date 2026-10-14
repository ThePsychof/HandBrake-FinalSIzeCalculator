use crate::model::{
    AudioCodec, CalibrationRecord, Container, MediaInfo, OutputSettings, Prediction, RateMode,
};

fn audio_payload(
    media: &MediaInfo,
    settings: &OutputSettings,
    duration: f64,
) -> (f64, Vec<String>) {
    let mut bytes = 0.0;
    let mut missing = Vec::new();
    for selected in settings.audio.iter().filter(|track| track.enabled) {
        if selected.passthrough || selected.codec == AudioCodec::Copy {
            if selected.source_track_match == Some(false) {
                missing.push(format!(
                    "Passthrough audio track {} could not be matched unambiguously to a source stream.",
                    selected.index + 1
                ));
                continue;
            }
            let source = media
                .audio_tracks
                .iter()
                .find(|track| track.index == selected.index);
            let Some(source) = source else {
                missing.push(format!(
                    "Passthrough audio track {} has no verified source stream match.",
                    selected.index + 1
                ));
                continue;
            };
            let compatible = match source.codec {
                AudioCodec::Aac | AudioCodec::Ac3 | AudioCodec::Mp3 => matches!(
                    settings.container,
                    Container::Mp4 | Container::M4v | Container::Mov | Container::Mkv
                ),
                AudioCodec::Eac3 | AudioCodec::Opus | AudioCodec::Flac => {
                    settings.container == Container::Mkv
                }
                _ => false,
            };
            if !compatible {
                missing.push(format!(
                    "Passthrough audio track {} is not verified as compatible with {}.",
                    selected.index + 1,
                    settings.container.label()
                ));
                continue;
            }
            let measured = source
                .duration_seconds
                .is_none_or(|source_duration| (source_duration - duration).abs() <= 1.0);
            if measured && let Some(size) = source.stream_size_bytes {
                bytes += size as f64;
            } else if let Some(bitrate) = source.bitrate_kbps.filter(|rate| *rate > 0.0) {
                bytes += bitrate * 1000.0 / 8.0 * duration;
            } else {
                missing.push(format!(
                    "Passthrough audio track {} has no source stream size or bitrate.",
                    selected.index + 1
                ));
            }
            continue;
        }
        if let Some(bitrate) = selected
            .bitrate_kbps
            .filter(|rate| rate.is_finite() && *rate > 0.0)
        {
            bytes += bitrate * 1000.0 / 8.0 * duration;
        } else if let Some(quality) = selected.quality {
            missing.push(format!(
                "Encoded audio track {} uses quality-based encoding (quality {quality}); its bitrate is content-dependent and is not estimated.",
                selected.index + 1
            ));
        } else {
            missing.push(format!(
                "Encoded audio track {} has no valid output bitrate.",
                selected.index + 1
            ));
        }
    }
    (bytes, missing)
}

fn median(values: &mut [f64]) -> f64 {
    values.sort_by(f64::total_cmp);
    let middle = values.len() / 2;
    if values.len().is_multiple_of(2) {
        (values[middle - 1] + values[middle]) / 2.0
    } else {
        values[middle]
    }
}

fn comparable<'a>(
    records: &'a [CalibrationRecord],
    media: &MediaInfo,
    settings: &OutputSettings,
) -> Vec<&'a CalibrationRecord> {
    let Some(duration) = media.duration_seconds else {
        return Vec::new();
    };
    records
        .iter()
        .filter(|record| {
            record.encoder == settings.video_codec
                && record.container == settings.container
                && record.preset == settings.preset
                && record.handbrake_version == media.handbrake_version
                && record.filter_signature == settings.filter_signature
                && record.audio_signature == audio_signature(media, settings)
                && record.subtitle_signature == subtitle_signature(settings)
                && record.width == media.width
                && record.height == media.height
                && (record.duration_seconds - duration).abs() <= 60.0_f64.max(duration * 0.15)
                && match settings.mode {
                    RateMode::AverageBitrate => {
                        record.quality_rf.is_none()
                            && record
                                .bitrate_kbps
                                .zip(settings.video_bitrate_kbps)
                                .is_some_and(|(left, right)| {
                                    (left - right).abs() <= 100.0_f64.max(right * 0.05)
                                })
                    }
                    RateMode::ConstantQuality => {
                        record.bitrate_kbps.is_none()
                            && record
                                .quality_rf
                                .zip(settings.quality_rf)
                                .is_some_and(|(left, right)| (left - right).abs() <= 1.0)
                    }
                }
        })
        .collect()
}

pub fn predict(
    media: &MediaInfo,
    settings: &OutputSettings,
    records: &[CalibrationRecord],
) -> Prediction {
    let mut result = Prediction::default();
    let Some(duration) = media
        .duration_seconds
        .filter(|value| value.is_finite() && *value > 0.0)
    else {
        result.status =
            "Source duration is unavailable in the selected HandBrake queue entry.".into();
        return result;
    };
    let (audio_bytes, audio_missing) = audio_payload(media, settings, duration);
    result.audio_bytes = audio_bytes;

    if settings.mode == RateMode::AverageBitrate {
        let Some(video_bitrate) = settings
            .video_bitrate_kbps
            .filter(|rate| rate.is_finite() && *rate > 0.0)
        else {
            result.status =
                "Video bitrate is unavailable in the selected HandBrake queue entry.".into();
            return result;
        };
        result.video_bytes = video_bitrate * 1000.0 / 8.0 * duration;
        result.overhead_bytes = settings
            .overhead_percent
            .filter(|value| value.is_finite() && *value >= 0.0)
            .map(|percent| (result.video_bytes + audio_bytes) * percent / 100.0)
            .unwrap_or(0.0);
        result.predicted_bytes = Some(result.video_bytes + audio_bytes + result.overhead_bytes);
        result.missing = audio_missing;
        if settings
            .subtitles
            .iter()
            .any(|track| track.enabled && !track.burn_in)
        {
            let count = settings
                .subtitles
                .iter()
                .filter(|track| track.enabled && !track.burn_in)
                .count();
            result.missing.push(format!(
                "{count} separate subtitle stream(s) are excluded because their output sizes are unavailable."
            ));
        }
        result.assumptions = vec![
            "Video and encoded-audio payloads use selected average bitrate × source duration (decimal kbit/s).".into(),
            "Passthrough uses measured source stream size when available, otherwise source bitrate × duration.".into(),
            "Burned subtitles are part of the video image and do not add a separate stream payload.".into(),
            "Container overhead is excluded unless an explicit percentage is supplied.".into(),
        ];
        if !result.missing.is_empty() {
            result.status = "Partial estimate — some output contributions are not included.".into();
        } else {
            result.status =
                "Based on stream bitrates from the selected queue entry; no validated range."
                    .into();
        }
        return result;
    }

    let samples = comparable(records, media, settings);
    result.calibration_samples = samples.len();
    if samples.len() >= 3 {
        let mut estimates: Vec<f64> = samples
            .iter()
            .map(|record| record.actual_bytes as f64 / record.duration_seconds * duration)
            .collect();
        result.predicted_bytes = Some(median(&mut estimates));
        result.lower_bound_bytes = estimates.first().copied();
        result.upper_bound_bytes = estimates.last().copied();
        result.status = format!(
            "Calibrated from {} comparable completed encode(s).",
            samples.len()
        );
    } else {
        result.status = format!(
            "RF is not a bitrate target. {} comparable historical encode(s) available; at least 3 are required for a numeric estimate.",
            samples.len()
        );
    }
    result.assumptions = vec![
        "Constant-quality output cannot be reliably inferred from RF or source bitrate alone.".into(),
        "Comparable calibration requires matching codec, container, preset, resolution, duration, and rate-control setting.".into(),
        "Historical minimum and maximum are descriptive, not a validated prediction interval.".into(),
    ];
    result
}

pub fn audio_signature(media: &MediaInfo, settings: &OutputSettings) -> String {
    let values: Vec<_> = settings
        .audio
        .iter()
        .filter(|track| track.enabled)
        .map(|track| {
            serde_json::json!({
                "index": track.index,
                "codec": track.codec,
                "bitrate_kbps": track.bitrate_kbps,
                "passthrough": track.passthrough,
                "channels": track.channels.or_else(|| media.audio_tracks.iter().find(|source| source.index == track.index).and_then(|source| source.channels)),
                "mixdown": track.mixdown,
                "sample_rate": track.sample_rate,
                "gain_db": track.gain_db,
                "drc": track.drc,
                "quality": track.quality,
                "encoder_options": track.encoder_options,
            })
        })
        .collect();
    serde_json::to_string(&values).unwrap_or_else(|error| {
        eprintln!("Could not serialize audio calibration signature: {error}");
        "[]".into()
    })
}

pub fn subtitle_signature(settings: &OutputSettings) -> String {
    let values: Vec<_> = settings
        .subtitles
        .iter()
        .filter(|track| track.enabled)
        .map(|track| {
            serde_json::json!({
                "index": track.index,
                "codec": track.codec,
                "burn_in": track.burn_in,
                "forced_only": track.forced_only,
                "default": track.default,
                "track_name": track.track_name,
            })
        })
        .collect();
    serde_json::to_string(&values).unwrap_or_else(|error| {
        eprintln!("Could not serialize subtitle calibration signature: {error}");
        "[]".into()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AudioOutput, SubtitleOutput};

    fn media() -> MediaInfo {
        MediaInfo {
            file_path: "sample.mp4".into(),
            duration_seconds: Some(3600.0),
            audio_tracks: vec![],
            ..Default::default()
        }
    }

    #[test]
    fn average_bitrate_adds_encoded_audio_and_overhead() {
        let settings = OutputSettings {
            video_bitrate_kbps: Some(2000.0),
            overhead_percent: Some(2.0),
            audio: vec![AudioOutput {
                index: 0,
                codec: AudioCodec::Aac,
                bitrate_kbps: Some(160.0),
                quality: None,
                passthrough: false,
                enabled: true,
                source_track_match: None,
                channels: None,
                mixdown: None,
                sample_rate: None,
                gain_db: None,
                drc: None,
                encoder_options: None,
            }],
            ..Default::default()
        };
        let estimate = predict(&media(), &settings, &[]);
        assert_eq!(estimate.video_bytes, 900_000_000.0);
        assert_eq!(estimate.audio_bytes, 72_000_000.0);
        assert_eq!(estimate.predicted_bytes, Some(991_440_000.0));
    }

    #[test]
    fn missing_audio_and_external_subtitles_are_called_out() {
        let settings = OutputSettings {
            video_bitrate_kbps: Some(2000.0),
            audio: vec![AudioOutput {
                index: 0,
                codec: AudioCodec::Aac,
                bitrate_kbps: None,
                quality: None,
                passthrough: false,
                enabled: true,
                source_track_match: None,
                channels: None,
                mixdown: None,
                sample_rate: None,
                gain_db: None,
                drc: None,
                encoder_options: None,
            }],
            subtitles: vec![SubtitleOutput {
                index: 0,
                codec: crate::model::SubtitleCodec::Bitmap,
                enabled: true,
                burn_in: false,
                forced_only: None,
                default: None,
                track_name: None,
            }],
            ..Default::default()
        };
        let estimate = predict(&media(), &settings, &[]);
        assert_eq!(estimate.missing.len(), 2);
        assert!(estimate.predicted_bytes.is_some());
    }

    #[test]
    fn constant_quality_uses_three_strictly_comparable_local_encodes() {
        let media = media();
        let settings = OutputSettings {
            mode: RateMode::ConstantQuality,
            container: Container::Mp4,
            video_codec: crate::model::VideoCodec::X264,
            quality_rf: Some(20.0),
            preset: "slow".into(),
            ..Default::default()
        };
        let signatures = (
            audio_signature(&media, &settings),
            subtitle_signature(&settings),
        );
        let records: Vec<CalibrationRecord> = [100.0, 300.0, 200.0]
            .into_iter()
            .enumerate()
            .map(|(index, actual_bytes)| CalibrationRecord {
                id: index.to_string(),
                created_at: String::new(),
                duration_seconds: 3600.0,
                handbrake_version: media.handbrake_version.clone(),
                encoder: settings.video_codec,
                preset: settings.preset.clone(),
                bitrate_kbps: None,
                quality_rf: settings.quality_rf,
                container: settings.container,
                predicted_bytes: actual_bytes,
                actual_bytes: actual_bytes as u64,
                width: media.width,
                height: media.height,
                filter_signature: settings.filter_signature.clone(),
                audio_signature: signatures.0.clone(),
                subtitle_signature: signatures.1.clone(),
            })
            .collect();

        let estimate = predict(&media, &settings, &records);
        assert_eq!(estimate.predicted_bytes, Some(200.0));
        assert_eq!(estimate.lower_bound_bytes, Some(100.0));
        assert_eq!(estimate.upper_bound_bytes, Some(300.0));
        assert_eq!(estimate.calibration_samples, 3);
    }
}
