use chrono::Utc;
use eframe::egui;
use std::time::{Duration, Instant};
use uuid::Uuid;

use crate::{
    calibration,
    handbrake::{self, QueuedSettings},
    model::{
        CalibrationRecord, Container, MediaInfo, OutputSettings, Prediction, RateMode, VideoCodec,
        VideoTrack,
    },
    prediction,
};

const CARD: egui::Color32 = egui::Color32::from_rgb(25, 26, 38);
const CARD_SUBTLE: egui::Color32 = egui::Color32::from_rgb(20, 21, 31);
const BORDER: egui::Color32 = egui::Color32::from_rgb(43, 44, 61);
const TEXT_MUTED: egui::Color32 = egui::Color32::from_rgb(155, 157, 180);
const WARNING: egui::Color32 = egui::Color32::from_rgb(244, 190, 107);
const ERROR: egui::Color32 = egui::Color32::from_rgb(246, 121, 144);
const SUCCESS: egui::Color32 = egui::Color32::from_rgb(116, 218, 178);
const ACCENT: egui::Color32 = egui::Color32::from_rgb(106, 168, 255);

pub struct PredictorApp {
    media: MediaInfo,
    settings: OutputSettings,
    records: Vec<CalibrationRecord>,
    error: Option<String>,
    notice: Option<String>,
    prediction: Prediction,
    queue_jobs: Vec<QueuedSettings>,
    selected_queue_key: Option<String>,
    queue_status: Option<String>,
    queue_fingerprint: Option<String>,
    next_queue_refresh: Instant,
}

impl PredictorApp {
    pub fn new(cc: &eframe::CreationContext<'_>) -> Self {
        set_fonts(&cc.egui_ctx);
        set_theme(&cc.egui_ctx);
        let records = calibration::load().unwrap_or_else(|error| {
            eprintln!("Could not load local calibration data: {error:#}");
            Vec::new()
        });
        Self {
            media: MediaInfo::default(),
            settings: OutputSettings::default(),
            records,
            error: None,
            notice: None,
            prediction: Prediction::default(),
            queue_jobs: Vec::new(),
            selected_queue_key: None,
            queue_status: None,
            queue_fingerprint: None,
            next_queue_refresh: Instant::now(),
        }
    }

    fn record_actual(&mut self) {
        let (Some(predicted_bytes), Some(duration_seconds)) =
            (self.prediction.predicted_bytes, self.media.duration_seconds)
        else {
            self.error = Some(
                "A source duration and numeric prediction are required before recording an encode."
                    .into(),
            );
            return;
        };
        let Some(path) = rfd::FileDialog::new()
            .set_title("Select the completed encode")
            .pick_file()
        else {
            return;
        };
        let actual_bytes = match std::fs::metadata(&path) {
            Ok(metadata) => metadata.len(),
            Err(error) => {
                self.error = Some(format!("Could not read selected output file: {error}"));
                return;
            }
        };
        let record = CalibrationRecord {
            id: Uuid::new_v4().to_string(),
            created_at: Utc::now().to_rfc3339(),
            duration_seconds,
            handbrake_version: self.media.handbrake_version.clone(),
            encoder: self.settings.video_codec,
            preset: self.settings.preset.clone(),
            bitrate_kbps: (self.settings.mode == RateMode::AverageBitrate)
                .then_some(self.settings.video_bitrate_kbps)
                .flatten(),
            quality_rf: (self.settings.mode == RateMode::ConstantQuality)
                .then_some(self.settings.quality_rf)
                .flatten(),
            container: self.settings.container,
            predicted_bytes,
            actual_bytes,
            width: self.media.width,
            height: self.media.height,
            filter_signature: self.settings.filter_signature.clone(),
            audio_signature: prediction::audio_signature(&self.media, &self.settings),
            subtitle_signature: prediction::subtitle_signature(&self.settings),
        };
        match calibration::append(record) {
            Ok(records) => {
                self.records = records;
                self.notice = Some(format!(
                    "Recorded. {} finished encode(s) now tune your estimates.",
                    self.records.len()
                ));
                self.error = None;
            }
            Err(error) => self.error = Some(format!("Could not save calibration data: {error:#}")),
        }
    }

    fn update_prediction(&mut self) {
        self.prediction = prediction::predict(&self.media, &self.settings, &self.records);
    }

    fn poll_queue(&mut self) {
        if Instant::now() < self.next_queue_refresh {
            return;
        }
        self.next_queue_refresh = Instant::now() + Duration::from_secs(2);
        match handbrake::read_queue_jobs() {
            Ok(jobs) => {
                let selected = next_queue_selection(
                    self.selected_queue_key.as_deref(),
                    &self.queue_jobs,
                    &jobs,
                );
                if selected != self.selected_queue_key {
                    self.selected_queue_key = selected;
                    self.queue_fingerprint = None;
                }
                self.queue_jobs = jobs;
                if self.selected_queue_key.is_none() {
                    self.queue_status = None;
                    self.media = MediaInfo::default();
                    self.settings = OutputSettings::default();
                }
                self.apply_selected_queue();
                self.error = None;
            }
            Err(error) => {
                self.error = Some(format!("Could not read HandBrake's local queue: {error:#}"));
            }
        }
    }

    fn apply_selected_queue(&mut self) {
        let queue = self
            .selected_queue_key
            .as_deref()
            .and_then(|selected| {
                self.queue_jobs
                    .iter()
                    .find(|job| queue_key(&job.source_path, &job.destination_path) == selected)
            })
            .cloned();
        let Some(queue) = queue else {
            return;
        };
        let fingerprint = serde_json::to_string(&(
            &queue.status,
            &queue.source_path,
            &queue.destination_path,
            queue.duration_seconds,
            queue.width,
            queue.height,
            &queue.settings,
        ))
        .ok();
        if fingerprint == self.queue_fingerprint {
            return;
        }
        self.queue_fingerprint = fingerprint;
        self.queue_status = Some(queue.status.clone());
        self.media = MediaInfo {
            file_path: queue.source_path.clone(),
            duration_seconds: queue.duration_seconds,
            width: queue.width,
            height: queue.height,
            frame_rate: queue.settings.frame_rate,
            container: Container::Unknown,
            source_file_size_bytes: None,
            video_tracks: (queue.width.is_some() || queue.height.is_some())
                .then_some(vec![VideoTrack {
                    width: queue.width,
                    height: queue.height,
                    frame_rate: queue.settings.frame_rate,
                    codec: queue.settings.video_codec,
                    ..Default::default()
                }])
                .unwrap_or_default(),
            audio_tracks: queue.source_audio_tracks,
            subtitle_tracks: queue.source_subtitle_tracks,
            handbrake_version: None,
            scan_error: None,
        };
        self.settings = queue.settings;
        self.error = None;
    }
}

impl eframe::App for PredictorApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.poll_queue();
        egui::TopBottomPanel::top("queue_selector")
            .frame(
                egui::Frame::new()
                    .fill(egui::Color32::from_rgb(15, 16, 23))
                    .inner_margin(egui::Margin::symmetric(12, 10)),
            )
            .show(ctx, |ui| self.draw_queue_selector(ui));

        egui::TopBottomPanel::bottom("footer")
            .frame(
                egui::Frame::new()
                    .fill(egui::Color32::from_rgb(15, 16, 23))
                    .inner_margin(egui::Margin::symmetric(12, 8)),
            )
            .show(ctx, |ui| draw_footer(ui));

        egui::CentralPanel::default().show(ctx, |ui| {
            egui::ScrollArea::vertical().show(ui, |ui| {
                self.update_prediction();
                self.draw_prediction(ui);
                if self.prediction.predicted_bytes.is_some()
                    && self.media.duration_seconds.is_some()
                {
                    ui.add_space(6.0);
                    let record = egui::Button::new(
                        egui::RichText::new("Record completed output")
                            .strong()
                            .color(egui::Color32::from_rgb(10, 18, 32)),
                    )
                    .fill(ACCENT)
                        .min_size(egui::vec2(ui.available_width(), 26.0));
                    if ui
                        .add(record)
                        .on_hover_text("Pick the finished file to save its real size and improve future estimates")
                        .clicked()
                    {
                        self.record_actual();
                    }
                }
                ui.add_space(5.0);
                self.draw_summary(ui);
                if let Some(error) = &self.error {
                    ui.add_space(6.0);
                    egui::Frame::new()
                        .fill(egui::Color32::from_rgb(58, 28, 38))
                        .corner_radius(egui::CornerRadius::same(8))
                        .inner_margin(egui::Margin::symmetric(10, 8))
                        .show(ui, |ui| {
                            ui.set_width(ui.available_width());
                            ui.colored_label(ERROR, error);
                        });
                }
                if let Some(notice) = &self.notice {
                    ui.add_space(4.0);
                    ui.colored_label(SUCCESS, notice);
                }
                ui.add_space(1.0);
                self.draw_details(ui);
            });
        });
        ctx.request_repaint_after(Duration::from_secs(1));
    }
}

impl PredictorApp {
    fn draw_queue_selector(&mut self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            if self.queue_jobs.is_empty() {
                ui.label("No queued jobs. Add an encode in HandBrake.");
            } else {
                let selected_label = self
                    .selected_queue_key
                    .as_deref()
                    .and_then(|selected| {
                        self.queue_jobs.iter().find(|job| {
                            queue_key(&job.source_path, &job.destination_path) == selected
                        })
                    })
                    .map(queue_label)
                    .unwrap_or_else(|| "Select a queued job".to_owned());
                let previous = self.selected_queue_key.clone();
                let popup_width = ui.available_width();
                egui::ComboBox::from_id_salt("handbrake-queue-job")
                    .width(ui.available_width())
                    .truncate()
                    .selected_text(selected_label)
                    .show_ui(ui, |ui| {
                        ui.set_max_width(popup_width);
                        ui.style_mut().wrap_mode = Some(egui::TextWrapMode::Truncate);
                        for job in &self.queue_jobs {
                            let key = queue_key(&job.source_path, &job.destination_path);
                            ui.selectable_value(
                                &mut self.selected_queue_key,
                                Some(key),
                                queue_label(job),
                            );
                        }
                    });
                if previous != self.selected_queue_key {
                    self.notice = None;
                    self.queue_fingerprint = None;
                    self.apply_selected_queue();
                }
            }
        });
    }

    fn draw_prediction(&mut self, ui: &mut egui::Ui) {
        egui::Frame::new()
            .fill(CARD)
            .stroke(egui::Stroke::NONE)
            .corner_radius(egui::CornerRadius::same(16))
            .inner_margin(egui::Margin::symmetric(12, 10))
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.label(
                        egui::RichText::new("Estimated size")
                            .small()
                            .strong()
                            .color(TEXT_MUTED),
                    );
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        let (status, color) = if self.queue_status.is_some() {
                            ("Synced with queue", SUCCESS)
                        } else {
                            ("No job selected", TEXT_MUTED)
                        };
                        ui.label(
                            egui::RichText::new(status)
                                .small()
                                .strong()
                                .color(color),
                        );
                    });
                });
                ui.add_space(1.0);
                if let Some(gib) = self.prediction.gib() {
                    let mut job = egui::text::LayoutJob::default();
                    job.append(
                        &format!("{gib:.2}"),
                        0.0,
                        egui::TextFormat {
                            font_id: egui::FontId::proportional(64.0),
                            color: egui::Color32::WHITE,
                            ..Default::default()
                        },
                    );
                    job.append(
                        if self.prediction.missing.is_empty() {
                            " GiB"
                        } else {
                            " GiB*"
                        },
                        2.0,
                        egui::TextFormat {
                            font_id: egui::FontId::proportional(20.0),
                            color: TEXT_MUTED,
                            ..Default::default()
                        },
                    );
                    ui.label(job);
                    if let Some(gb) = self.prediction.gb() {
                        ui.label(
                            egui::RichText::new(format!("{gb:.2} GB"))
                                .size(12.0)
                                .color(TEXT_MUTED),
                        );
                    }
                } else {
                    ui.label(
                        egui::RichText::new("—")
                            .size(38.0)
                            .strong()
                            .color(TEXT_MUTED),
                    );
                    if !self.media.file_path.is_empty() {
                        ui.label(
                            egui::RichText::new(&self.prediction.status)
                                .small()
                                .color(TEXT_MUTED),
                        );
                    }
                }
                self.draw_quick_controls(ui);
                if !self.prediction.missing.is_empty() {
                    ui.add_space(3.0);
                    ui.colored_label(WARNING, "* Partial estimate: some stream sizes are unknown");
                    egui::CollapsingHeader::new(format!(
                        "{} warning(s)",
                        self.prediction.missing.len()
                    ))
                    .id_salt("estimate-warnings")
                    .show(ui, |ui| {
                        for warning in &self.prediction.missing {
                            ui.colored_label(WARNING, warning);
                        }
                    });
                }
                if let (Some(low), Some(high)) = (
                    self.prediction.lower_bound_bytes,
                    self.prediction.upper_bound_bytes,
                ) {
                    ui.add_space(6.0);
                    let (bar, _) = ui.allocate_exact_size(
                        egui::vec2(ui.available_width(), 8.0),
                        egui::Sense::hover(),
                    );
                    let round = egui::CornerRadius::same(4);
                    ui.painter().rect_filled(bar, round, BORDER);
                    if let Some(predicted) = self.prediction.predicted_bytes {
                        let t = if high > low {
                            ((predicted - low) / (high - low)).clamp(0.0, 1.0) as f32
                        } else {
                            0.5
                        };
                        let x = bar.left() + bar.width() * t;
                        let filled = egui::Rect::from_min_max(
                            bar.left_top(),
                            egui::pos2(x.max(bar.left() + 8.0), bar.bottom()),
                        );
                        ui.painter().rect_filled(filled, round, ACCENT);
                        ui.painter()
                            .circle_filled(egui::pos2(x, bar.center().y), 6.0, egui::Color32::WHITE);
                    }
                    ui.add_space(4.0);
                    ui.label(
                        egui::RichText::new(format!(
                            "Observed range  {:.2} – {:.2} GiB",
                            low / 1024_f64.powi(3),
                            high / 1024_f64.powi(3)
                        ))
                        .small()
                        .color(TEXT_MUTED),
                    );
                } else if self.settings.mode == RateMode::ConstantQuality {
                    ui.add_space(2.0);
                    ui.label(
                        egui::RichText::new("No comparable encode history yet")
                            .small()
                            .color(TEXT_MUTED),
                    );
                }
            });
    }

    fn savings_line(&self, _gb: f64) -> String {
        let source = std::fs::metadata(&self.media.file_path)
            .map(|meta| meta.len() as f64)
            .ok();
        match (source, self.prediction.predicted_bytes) {
            (Some(src), Some(out)) if src > 0.0 => {
                let pct = (1.0 - out / src) * 100.0;
                if pct >= 0.0 {
                    format!("{pct:.0}% smaller than the source file")
                } else {
                    format!("{:.0}% larger than the source file", -pct)
                }
            }
            _ => String::new(),
        }
    }

    fn draw_quick_controls(&mut self, ui: &mut egui::Ui) {
        if let Some(gb) = self.prediction.gb() {
            let saving = self.savings_line(gb);
            if !saving.is_empty() {
                ui.label(egui::RichText::new(saving).small().color(ACCENT));
            }
        }
        ui.add_space(4.0);
        let rate_control =
            self.selected_queue_key
                .as_ref()
                .and_then(|_| match self.settings.mode {
                    RateMode::AverageBitrate => self
                        .settings
                        .video_bitrate_kbps
                        .map(|value| format!("Average bitrate {value:.0} kbps")),
                    RateMode::ConstantQuality => self
                        .settings
                        .quality_rf
                        .map(|value| format!("Constant quality, RF {value:.1}")),
                });
        ui.label(
            egui::RichText::new(rate_control.unwrap_or_else(|| {
                if self.selected_queue_key.is_some() {
                    "This job has no bitrate or quality value. Check it in HandBrake.".to_owned()
                } else {
                    "Pick a queued job above to see its estimate.".to_owned()
                }
            }))
            .small()
            .color(TEXT_MUTED),
        );
    }

    fn draw_summary(&self, ui: &mut egui::Ui) {
        egui::Frame::new()
            .inner_margin(egui::Margin::symmetric(4, 3))
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.label(
                        egui::RichText::new("Source")
                            .small()
                            .strong()
                            .color(TEXT_MUTED),
                    );
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if let Some(duration) = self.media.duration_seconds {
                            ui.label(
                                egui::RichText::new(format_duration(duration))
                                    .small()
                                    .color(TEXT_MUTED),
                            );
                        }
                    });
                });
                ui.add_space(1.0);
                ui.label(
                    egui::RichText::new(self.media.source_title())
                        .strong()
                        .size(13.0),
                );
                if !self.media.file_path.is_empty() {
                    let audio_count = self
                        .settings
                        .audio
                        .iter()
                        .filter(|track| track.enabled)
                        .count();
                    let subtitle_count = self
                        .settings
                        .subtitles
                        .iter()
                        .filter(|track| track.enabled)
                        .count();
                    let mut metadata = vec![self.media.picture()];
                    if self.settings.video_codec != VideoCodec::Unknown {
                        metadata.push(
                            self.settings
                                .video_encoder_name
                                .as_deref()
                                .unwrap_or_else(|| self.settings.video_codec.label())
                                .to_owned(),
                        );
                    }
                    if self.settings.container != Container::Unknown {
                        metadata.push(self.settings.container.label().to_owned());
                    }
                    if audio_count > 0 {
                        metadata.push(format!("{audio_count} audio"));
                    }
                    if subtitle_count > 0 {
                        metadata.push(format!("{subtitle_count} subs"));
                    }
                    ui.label(
                        egui::RichText::new(metadata.join(" · "))
                            .small()
                            .color(TEXT_MUTED),
                    );
                } else {
                    ui.label(
                        egui::RichText::new("Select a job from HandBrake's queue.")
                            .small()
                            .color(TEXT_MUTED),
                    );
                }
            });
    }

    fn draw_details(&mut self, ui: &mut egui::Ui) {
        egui::CollapsingHeader::new("Breakdown & assumptions")
            .default_open(false)
            .show(ui, |ui| {
                
                ui.label(format!(
                    "{} comparable calibration record(s)",
                    self.prediction.calibration_samples
                ));
                if self.prediction.predicted_bytes.is_some() {
                    breakdown_row(ui, "Video payload", self.prediction.video_bytes);
                    breakdown_row(ui, "Audio payload", self.prediction.audio_bytes);
                    breakdown_row(ui, "Container overhead", self.prediction.overhead_bytes);
                }
                ui.separator();
                for assumption in &self.prediction.assumptions {
                    ui.label(format!("• {assumption}"));
                }
                ui.separator();
                ui.label(
                    egui::RichText::new("Settings used")
                        .small()
                        .strong()
                        .color(TEXT_MUTED),
                );
                ui.label(format!(
                    "Video: {} · {}",
                    self.settings
                        .video_encoder_name
                        .as_deref()
                        .unwrap_or(self.settings.video_codec.label()),
                    self.settings.encoding_label()
                ));
                for track in self.settings.audio.iter().filter(|track| track.enabled) {
                    ui.label(format!(
                        "Audio {}: {}{}{}{}{}{}{}",
                        track.index + 1,
                        track.codec.label(),
                        track
                            .bitrate_kbps
                            .map(|value| format!(" · {value:.0} kbps"))
                            .unwrap_or_else(|| track
                                .quality
                                .map(|value| format!(" · quality {value}"))
                                .unwrap_or_default()),
                        track
                            .mixdown
                            .as_deref()
                            .map(|value| format!(" · {value}"))
                            .unwrap_or_default(),
                        track
                            .sample_rate
                            .map(|value| format!(" · {value} Hz"))
                            .unwrap_or_default(),
                        track
                            .gain_db
                            .map(|value| format!(" · gain {value} dB"))
                            .unwrap_or_default(),
                        track
                            .drc
                            .map(|value| format!(" · DRC {value}"))
                            .unwrap_or_default(),
                        if track.passthrough {
                            " · passthrough"
                        } else {
                            ""
                        }
                    ));
                    if let Some(options) = &track.encoder_options {
                        ui.label(format!("  Audio encoder options: {options}"));
                    }
                }
                for track in self.settings.subtitles.iter().filter(|track| track.enabled) {
                    ui.label(format!(
                        "Subtitle {}: {:?}{}{}{}",
                        track.index + 1,
                        track.codec,
                        if track.burn_in {
                            " · burned into video"
                        } else {
                            " · separate stream size unavailable"
                        },
                        if track.forced_only == Some(true) {
                            " · forced"
                        } else {
                            ""
                        },
                        if track.default == Some(true) {
                            " · default"
                        } else {
                            ""
                        }
                    ));
                }
                ui.label(format!(
                    "Picture output: {} × {} · frame rate {}",
                    self.settings
                        .output_width
                        .map_or_else(|| "source".into(), |value| value.to_string()),
                    self.settings
                        .output_height
                        .map_or_else(|| "source".into(), |value| value.to_string()),
                    self.settings
                        .frame_rate
                        .map_or_else(|| "source".into(), |value| format!("{value:.3} fps"))
                ));
                ui.label(format!(
                    "Video options: tune={} · profile={} · level={} · advanced={}",
                    self.settings
                        .encoder_tune
                        .as_deref()
                        .unwrap_or("not specified"),
                    self.settings
                        .encoder_profile
                        .as_deref()
                        .unwrap_or("not specified"),
                    self.settings
                        .encoder_level
                        .as_deref()
                        .unwrap_or("not specified"),
                    self.settings
                        .encoder_options
                        .as_deref()
                        .unwrap_or("not specified")
                ));
                if let Some(chapters) = self.settings.chapters {
                    ui.label(format!(
                        "Chapter markers: {}",
                        if chapters { "included" } else { "excluded" }
                    ));
                }
                if let Some(value) = self.settings.metadata_passthrough {
                    ui.label(format!(
                        "Metadata passthrough: {}",
                        if value { "on" } else { "off" }
                    ));
                }
                if let Some(value) = self.settings.web_optimized {
                    ui.label(format!(
                        "Web optimized: {}",
                        if value { "on" } else { "off" }
                    ));
                }
                if let Some(filters) = &self.settings.filter_signature {
                    ui.label(format!("Filters / picture settings: {filters}"));
                }
            });
    }
}

const REPO_URL: &str = "https://github.com/ThePsychof/HandBrake-FinalSIzeCalculator";

fn open_url(url: &str) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .creation_flags(0x0800_0000)
            .spawn();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    }
}

fn draw_footer(ui: &mut egui::Ui) {
    ui.vertical_centered(|ui| {
        let font = egui::FontId::proportional(11.5);
        let label = "Source code";
        let text_width = ui
            .painter()
            .layout_no_wrap(label.to_owned(), font.clone(), TEXT_MUTED)
            .size()
            .x;
        let (icon_w, gap) = (18.0_f32, 6.0_f32);
        let (rect, response) = ui.allocate_exact_size(
            egui::vec2(icon_w + gap + text_width, 18.0),
            egui::Sense::click(),
        );
        let response = response
            .on_hover_text(REPO_URL)
            .on_hover_cursor(egui::CursorIcon::PointingHand);
        let color = if response.hovered() { ACCENT } else { TEXT_MUTED };
        let eye = egui::Color32::from_rgb(15, 16, 23);
        let painter = ui.painter();

        let c = egui::pos2(rect.min.x + 9.0, rect.center().y + 1.5);
        painter.circle_filled(c, 6.0, color);
        for side in [-1.0_f32, 1.0] {
            painter.add(egui::Shape::convex_polygon(
                vec![
                    egui::pos2(c.x + side * 6.0, c.y - 2.0),
                    egui::pos2(c.x + side * 5.2, c.y - 8.5),
                    egui::pos2(c.x + side * 1.2, c.y - 5.0),
                ],
                color,
                egui::Stroke::NONE,
            ));
            painter.circle_filled(egui::pos2(c.x + side * 2.2, c.y - 0.5), 1.0, eye);
        }

        painter.text(
            egui::pos2(rect.min.x + icon_w + gap, rect.center().y),
            egui::Align2::LEFT_CENTER,
            label,
            font,
            color,
        );

        if response.clicked() {
            open_url(REPO_URL);
        }
    });
}

fn set_fonts(ctx: &egui::Context) {
    let mut fonts = egui::FontDefinitions::default();
    for path in [
        r"C:\Windows\Fonts\bahnschrift.ttf",
        r"C:\Windows\Fonts\segoeui.ttf",
    ] {
        if let Ok(bytes) = std::fs::read(path) {
            fonts.font_data.insert(
                "ui".to_owned(),
                std::sync::Arc::new(egui::FontData::from_owned(bytes)),
            );
            fonts
                .families
                .entry(egui::FontFamily::Proportional)
                .or_default()
                .insert(0, "ui".to_owned());
            break;
        }
    }
    ctx.set_fonts(fonts);
}

fn set_theme(ctx: &egui::Context) {
    let mut visuals = egui::Visuals::dark();
    visuals.panel_fill = egui::Color32::from_rgb(15, 16, 23);
    visuals.window_fill = CARD;
    visuals.widgets.noninteractive.bg_fill = CARD_SUBTLE;
    visuals.widgets.noninteractive.fg_stroke = egui::Stroke::new(1.0_f32, TEXT_MUTED);
    visuals.widgets.inactive.bg_fill = egui::Color32::from_rgb(35, 34, 51);
    visuals.widgets.inactive.fg_stroke = egui::Stroke::new(1.0_f32, egui::Color32::WHITE);
    visuals.widgets.hovered.bg_fill = egui::Color32::from_rgb(40, 52, 76);
    visuals.widgets.active.bg_fill = egui::Color32::from_rgb(52, 84, 140);
    visuals.selection.bg_fill = egui::Color32::from_rgb(52, 84, 140);
    visuals.selection.stroke = egui::Stroke::new(1.0_f32, egui::Color32::WHITE);
    ctx.set_visuals(visuals);
    ctx.style_mut(|style| {
        style.spacing.item_spacing = egui::vec2(6.0, 5.0);
        style.spacing.button_padding = egui::vec2(8.0, 4.0);
        style.spacing.interact_size.y = 24.0;
        style
            .text_styles
            .insert(egui::TextStyle::Small, egui::FontId::proportional(11.5));
        style.visuals.widgets.inactive.corner_radius = egui::CornerRadius::same(6);
        style.visuals.widgets.hovered.corner_radius = egui::CornerRadius::same(6);
        style.visuals.widgets.active.corner_radius = egui::CornerRadius::same(6);
    });
}

fn format_duration(seconds: f64) -> String {
    if !seconds.is_finite() || seconds < 0.0 {
        return "Duration unavailable".to_owned();
    }
    let total_seconds = seconds as u64;
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    if hours > 0 {
        format!("{hours}h {minutes:02}m")
    } else {
        format!("{minutes}m {:02}s", total_seconds % 60)
    }
}

fn breakdown_row(ui: &mut egui::Ui, label: &str, bytes: f64) {
    ui.horizontal(|ui| {
        ui.label(label);
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            ui.label(format!("{:.3} GiB", bytes / 1024_f64.powi(3)));
        });
    });
}

trait MediaDisplay {
    fn source_title(&self) -> &str;
    fn picture(&self) -> String;
}

impl MediaDisplay for MediaInfo {
    fn source_title(&self) -> &str {
        self.file_path
            .rsplit(['\\', '/'])
            .next()
            .filter(|name| !name.is_empty())
            .unwrap_or("No queued job selected")
    }

    fn picture(&self) -> String {
        let dimensions = self
            .width
            .zip(self.height)
            .map(|(width, height)| format!("{width} × {height}"))
            .unwrap_or_else(|| "—".to_owned());
        match self.frame_rate {
            Some(rate) => format!("{dimensions} · {rate:.2} fps"),
            None => dimensions,
        }
    }
}

impl OutputSettings {
    fn encoding_label(&self) -> String {
        match self.mode {
            RateMode::AverageBitrate => format!(
                "{} kbps · {}",
                self.video_bitrate_kbps
                    .map_or_else(|| "—".into(), |rate| format!("{rate:.0}")),
                self.preset
            ),
            RateMode::ConstantQuality => format!(
                "RF {} · {}",
                self.quality_rf
                    .map_or_else(|| "—".into(), |value| format!("{value:.1}")),
                self.preset
            ),
        }
    }
}

fn queue_key(source: &str, destination: &str) -> String {
    format!(
        "{}\0{}",
        source.replace('/', "\\").to_lowercase(),
        destination.replace('/', "\\").to_lowercase()
    )
}

fn queue_label(job: &QueuedSettings) -> String {
    let source = std::path::Path::new(&job.source_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(&job.source_path);
    let destination = std::path::Path::new(&job.destination_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(&job.destination_path);
    let _ = destination;
    format!("{source} ({})", job.status)
}

fn next_queue_selection(
    current: Option<&str>,
    previous_jobs: &[QueuedSettings],
    current_jobs: &[QueuedSettings],
) -> Option<String> {
    let previous_keys = previous_jobs
        .iter()
        .map(|job| queue_key(&job.source_path, &job.destination_path))
        .collect::<std::collections::HashSet<_>>();
    if let Some(newest) = current_jobs
        .iter()
        .rev()
        .find(|job| !previous_keys.contains(&queue_key(&job.source_path, &job.destination_path)))
    {
        return Some(queue_key(&newest.source_path, &newest.destination_path));
    }

    current_jobs
        .iter()
        .find(|job| Some(queue_key(&job.source_path, &job.destination_path).as_str()) == current)
        .or_else(|| current_jobs.last())
        .map(|job| queue_key(&job.source_path, &job.destination_path))
}

#[cfg(test)]
mod tests {
    use super::{next_queue_selection, queue_key};
    use crate::handbrake::QueuedSettings;

    fn job(source_path: &str) -> QueuedSettings {
        QueuedSettings {
            status: "Waiting".to_owned(),
            source_path: source_path.to_owned(),
            destination_path: format!(
                r"C:\Output\{}.mp4",
                source_path.rsplit('\\').next().unwrap()
            ),
            duration_seconds: None,
            width: None,
            height: None,
            source_audio_tracks: Vec::new(),
            source_subtitle_tracks: Vec::new(),
            settings: crate::model::OutputSettings::default(),
        }
    }

    #[test]
    fn queue_job_identity_uses_source_and_destination_paths() {
        assert_eq!(
            queue_key(r"C:\Videos\movie.mkv", r"C:\Output\movie.mp4"),
            queue_key(r"c:\videos\MOVIE.mkv", r"c:\output\MOVIE.mp4")
        );
        assert_ne!(
            queue_key(r"C:\Videos\movie.mkv", r"C:\Output\movie.mp4"),
            queue_key(r"C:\Videos\movie.mkv", r"C:\Output\movie-small.mp4")
        );
    }

    #[test]
    fn selects_the_last_job_on_first_queue_load() {
        let jobs = vec![job(r"C:\Videos\first.mkv"), job(r"C:\Videos\last.mkv")];

        assert_eq!(
            next_queue_selection(None, &[], &jobs),
            Some(queue_key(r"C:\Videos\last.mkv", r"C:\Output\last.mkv.mp4"))
        );
    }

    #[test]
    fn newly_added_job_becomes_selected_automatically() {
        let old_jobs = vec![job(r"C:\Videos\first.mkv")];
        let new_jobs = vec![old_jobs[0].clone(), job(r"C:\Videos\second.mkv")];

        assert_eq!(
            next_queue_selection(
                Some(&queue_key(
                    &old_jobs[0].source_path,
                    &old_jobs[0].destination_path
                )),
                &old_jobs,
                &new_jobs,
            ),
            Some(queue_key(
                r"C:\Videos\second.mkv",
                r"C:\Output\second.mkv.mp4"
            ))
        );
    }
}
