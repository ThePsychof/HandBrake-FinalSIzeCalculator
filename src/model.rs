use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Container {
    Mp4,
    Mkv,
    M4v,
    Mov,
    Avi,
    Mpegts,
    #[default]
    Unknown,
}

impl Container {
    pub fn label(self) -> &'static str {
        match self {
            Self::Mp4 => "MP4",
            Self::Mkv => "MKV",
            Self::M4v => "M4V",
            Self::Mov => "MOV",
            Self::Avi => "AVI",
            Self::Mpegts => "MPEG-TS",
            Self::Unknown => "Select output",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum VideoCodec {
    X264,
    X265,
    H264,
    Hevc,
    Av1,
    Vp9,
    Mpeg4,
    Mpeg2,
    #[default]
    Unknown,
}

impl VideoCodec {
    pub fn label(self) -> &'static str {
        match self {
            Self::X264 => "x264",
            Self::X265 => "x265",
            Self::H264 => "H.264 hardware/other",
            Self::Hevc => "HEVC hardware/other",
            Self::Av1 => "AV1",
            Self::Vp9 => "VP9",
            Self::Mpeg4 => "MPEG-4",
            Self::Mpeg2 => "MPEG-2",
            Self::Unknown => "Unknown",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AudioCodec {
    Aac,
    Ac3,
    Eac3,
    Mp3,
    Opus,
    Flac,
    Copy,
    #[default]
    Unknown,
}

impl AudioCodec {
    pub fn from_name(value: &str) -> Self {
        let name = value.to_ascii_lowercase();
        if name.contains("copy") || name.contains("passthru") {
            Self::Copy
        } else if name.contains("eac3") || name.contains("e-ac-3") {
            Self::Eac3
        } else if name.contains("ac3") || name.contains("ac-3") {
            Self::Ac3
        } else if name.contains("aac") {
            Self::Aac
        } else if name.contains("mp3") {
            Self::Mp3
        } else if name.contains("opus") {
            Self::Opus
        } else if name.contains("flac") {
            Self::Flac
        } else {
            Self::Unknown
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Aac => "AAC",
            Self::Ac3 => "AC-3",
            Self::Eac3 => "E-AC-3",
            Self::Mp3 => "MP3",
            Self::Opus => "Opus",
            Self::Flac => "FLAC",
            Self::Copy => "Passthrough",
            Self::Unknown => "Unknown",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SubtitleCodec {
    Subrip,
    Bitmap,
    Ass,
    Text,
    #[default]
    Unknown,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct VideoTrack {
    pub index: Option<u32>,
    pub codec: VideoCodec,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub frame_rate: Option<f64>,
    pub bitrate_kbps: Option<f64>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct AudioTrack {
    pub index: usize,
    pub stream_index: Option<u32>,
    pub codec: AudioCodec,
    pub language: Option<String>,
    pub channels: Option<u32>,
    pub channel_layout: Option<String>,
    pub sample_rate: Option<u32>,
    pub duration_seconds: Option<f64>,
    pub bitrate_kbps: Option<f64>,
    pub stream_size_bytes: Option<u64>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct SubtitleTrack {
    pub index: usize,
    pub codec: SubtitleCodec,
    pub language: Option<String>,
    pub is_bitmap: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct MediaInfo {
    pub file_path: String,
    pub duration_seconds: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub frame_rate: Option<f64>,
    pub container: Container,
    pub source_file_size_bytes: Option<u64>,
    pub video_tracks: Vec<VideoTrack>,
    pub audio_tracks: Vec<AudioTrack>,
    pub subtitle_tracks: Vec<SubtitleTrack>,
    pub handbrake_version: Option<String>,
    pub scan_error: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RateMode {
    #[default]
    AverageBitrate,
    ConstantQuality,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AudioOutput {
    pub index: usize,
    pub codec: AudioCodec,
    pub bitrate_kbps: Option<f64>,
    pub quality: Option<f64>,
    pub passthrough: bool,
    pub enabled: bool,
    pub source_track_match: Option<bool>,
    pub channels: Option<u32>,
    pub mixdown: Option<String>,
    pub sample_rate: Option<u32>,
    pub gain_db: Option<f64>,
    pub drc: Option<f64>,
    pub encoder_options: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SubtitleOutput {
    pub index: usize,
    pub codec: SubtitleCodec,
    pub enabled: bool,
    pub burn_in: bool,
    pub forced_only: Option<bool>,
    pub default: Option<bool>,
    pub track_name: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct OutputSettings {
    pub mode: RateMode,
    pub container: Container,
    pub video_codec: VideoCodec,
    pub video_bitrate_kbps: Option<f64>,
    pub quality_rf: Option<f64>,
    pub preset: String,
    pub video_encoder_name: Option<String>,
    pub encoder_tune: Option<String>,
    pub encoder_profile: Option<String>,
    pub encoder_level: Option<String>,
    pub encoder_options: Option<String>,
    pub output_width: Option<u32>,
    pub output_height: Option<u32>,
    pub frame_rate_mode: Option<String>,
    pub frame_rate: Option<f64>,
    pub filter_signature: Option<String>,
    pub two_pass: bool,
    pub overhead_percent: Option<f64>,
    pub chapters: Option<bool>,
    pub metadata_passthrough: Option<bool>,
    pub web_optimized: Option<bool>,
    pub align_av_start: Option<bool>,
    pub ipod_5g_support: Option<bool>,
    pub audio: Vec<AudioOutput>,
    pub subtitles: Vec<SubtitleOutput>,
}

impl Default for OutputSettings {
    fn default() -> Self {
        Self {
            mode: RateMode::AverageBitrate,
            container: Container::Unknown,
            video_codec: VideoCodec::Unknown,
            video_bitrate_kbps: None,
            quality_rf: Some(20.0),
            preset: "medium".to_owned(),
            video_encoder_name: None,
            encoder_tune: None,
            encoder_profile: None,
            encoder_level: None,
            encoder_options: None,
            output_width: None,
            output_height: None,
            frame_rate_mode: None,
            frame_rate: None,
            filter_signature: None,
            two_pass: false,
            overhead_percent: None,
            chapters: None,
            metadata_passthrough: None,
            web_optimized: None,
            align_av_start: None,
            ipod_5g_support: None,
            audio: Vec::new(),
            subtitles: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CalibrationRecord {
    pub id: String,
    pub created_at: String,
    pub duration_seconds: f64,
    #[serde(default)]
    pub handbrake_version: Option<String>,
    pub encoder: VideoCodec,
    pub preset: String,
    pub bitrate_kbps: Option<f64>,
    pub quality_rf: Option<f64>,
    pub container: Container,
    pub predicted_bytes: f64,
    pub actual_bytes: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    #[serde(default)]
    pub filter_signature: Option<String>,
    #[serde(default)]
    pub audio_signature: String,
    #[serde(default)]
    pub subtitle_signature: String,
}

#[derive(Clone, Debug, Default)]
pub struct Prediction {
    pub predicted_bytes: Option<f64>,
    pub lower_bound_bytes: Option<f64>,
    pub upper_bound_bytes: Option<f64>,
    pub video_bytes: f64,
    pub audio_bytes: f64,
    pub overhead_bytes: f64,
    pub missing: Vec<String>,
    pub assumptions: Vec<String>,
    pub calibration_samples: usize,
    pub status: String,
}

impl Prediction {
    pub fn gib(&self) -> Option<f64> {
        self.predicted_bytes.map(|bytes| bytes / 1024_f64.powi(3))
    }

    pub fn gb(&self) -> Option<f64> {
        self.predicted_bytes.map(|bytes| bytes / 1_000_000_000.0)
    }
}
