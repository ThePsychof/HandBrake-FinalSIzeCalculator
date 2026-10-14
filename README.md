<div align="center">

# HandBrake FinalSizeCalculator

### Know what your encode might cost in storage—before you commit to the full encode.

A compact, local-first desktop companion for HandBrake, implemented as a native Rust desktop application. See a quick output-size estimate and the settings behind it, without uploading your media or starting a full encode.

</div>

---

## A clearer answer before you encode

Add the job to HandBrake's queue, open the predictor, select that queue entry, and review the estimate alongside its settings. FSC reads job data only from the queue; it does not use live UI Automation, scan a separately selected source, or ask you to enter encoding settings.

**No account. No media uploads. No analytics. No surprise full encode.**

## What it does

- **Estimates average-bitrate output size** from video bitrate, duration, and each known audio contribution.
- **Accounts for passthrough audio** using source-stream data contained in the selected queue entry when it can be matched reliably.
- **Shows partial estimates honestly** when a contribution is unknown, rather than filling gaps with invented defaults.
- **Reads queued source and encode settings directly from HandBrake's local queue files.**
- **Selects the newest queued job automatically** and switches to newly added jobs while keeping the queue selector available.
- **Remembers completed results locally** so comparable real encodes can inform future constant-quality estimates.
- **Uses a compact, estimate-first native utility panel** with a fixed queue selector and expandable details, and no Electron, Chromium, Node.js, JavaScript, or web frontend.

## An estimate, not a guarantee

Average-bitrate mode calculates the nominal video payload from the selected bitrate and duration, then adds known audio payloads. Explicit overhead can be included when configured. Unknown stream or container contributions are called out; they are not hidden behind arbitrary multipliers.

Constant Quality / RF is different: RF is not a bitrate, and content complexity has a major impact on size. Without comparable completed encodes, the app does not invent a precise RF-to-size conversion. Historical calibration is local and only uses a small set of sufficiently comparable results; its observed range is descriptive, not a validated confidence interval.

Predictions have **not yet been validated against completed encodes across representative media and settings**. Treat them as planning estimates, not a promise of final file size.


## HandBrake integration

FSC reads HandBrake's local queue JSON and lists its waiting and in-progress jobs in queue order. It selects the last (newest) job on startup and switches to a newly added job as soon as it appears in the queue. You can still select another job manually. The queue refreshes automatically every couple of seconds and can also be refreshed manually. FSC does not read the active GUI tabs, invoke HandBrakeCLI or ffprobe, or provide manual encoding-setting inputs. Queue entries are snapshots: changing a job's settings after it was added may not update the snapshot; remove and re-add the job in HandBrake to refresh it. FSC never starts an encode.

## Privacy and local data

Prediction uses locally stored HandBrake queue data and local calibration history. FSC does not inspect or modify the video source file, start an encode, or upload data.

## Technical notes

- Video payload in average-bitrate mode is based on the selected output bitrate and effective duration available to the app. When only the title duration is exposed, a selected chapter/time range may not be reflected.
- Passthrough estimates use measured stream size when available for a matching full-duration stream, otherwise a known source bitrate. Ambiguous source-track matches are not guessed.
- Burned-in subtitles are part of the video image and are not counted as an additional stream. Unknown separate subtitle payload and variable container/mux overhead can make final size differ.
- Two-pass encoding does not receive an arbitrary size multiplier.
- Sizes are calculated from decimal bitrates; the UI reports binary GiB and decimal GB.
- HandBrake queue parsing follows HandBrake's local queue JSON format. Only waiting and in-progress entries are listed.

## Build and run

Install the Rust stable toolchain, then run:

```powershell
cargo run
cargo test
cargo build --release
```

On Windows, the optimized standalone executable is `target\release\handbrake-fsc.exe`. The release profile enables link-time optimization and symbol stripping. No JavaScript package installation or Electron runtime is required.

For details on HandBrake's own options, see the [CLI command-line reference](https://handbrake.fr/docs/en/latest/cli/command-line-reference.html), [CLI options guide](https://handbrake.fr/docs/en/latest/cli/cli-options.html), and [official presets](https://handbrake.fr/docs/en/latest/technical/official-presets.html).

## Project layout

| Path | Purpose |
| --- | --- |
| `src/main.rs` | Native egui application entry point |
| `src/ui.rs` | Desktop UI and user interactions |
| `src/handbrake.rs` | HandBrake queue parsing |
| `src/prediction.rs` | Size estimation and calibration matching |
| `src/calibration.rs` | Local completed-encode history |
