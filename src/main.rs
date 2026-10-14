#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod calibration;
mod handbrake;
mod model;
mod prediction;
mod ui;

fn app_icon() -> eframe::egui::IconData {
    const N: u32 = 64;
    let mut rgba = Vec::with_capacity((N * N * 4) as usize);
    for y in 0..N {
        for x in 0..N {
            let (px, py) = (x as f32 + 0.5 - 32.0, y as f32 + 0.5 - 32.0);
            let (qx, qy) = (px.abs() - 20.0, py.abs() - 20.0);
            let d = qx.max(0.0).hypot(qy.max(0.0)) + qx.max(qy).min(0.0) - 12.0;
            let pixel = if d > 0.0 {
                [0, 0, 0, 0]
            } else if (40..48).contains(&y) && (12..52).contains(&x) {
                if x < 36 { [255, 255, 255, 255] } else { [255, 255, 255, 90] }
            } else {
                [106, 168, 255, 255]
            };
            rgba.extend_from_slice(&pixel);
        }
    }
    eframe::egui::IconData { rgba, width: N, height: N }
}

fn main() -> eframe::Result {
    let options = eframe::NativeOptions {
        viewport: eframe::egui::ViewportBuilder::default()
            .with_title("HandBrake FSC")
            .with_icon(app_icon())
            .with_inner_size([340.0, 450.0])
            .with_min_inner_size([300.0, 360.0]),
        ..Default::default()
    };
    eframe::run_native(
        "HandBrake FSC",
        options,
        Box::new(|cc| Ok(Box::new(ui::PredictorApp::new(cc)))),
    )
}
