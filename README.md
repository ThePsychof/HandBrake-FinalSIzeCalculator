<div align="center">

# HandBrake FinalSizeCalculator

**Know how big your encode will be before you start it.**

A small, local desktop companion for HandBrake. Add a job to the queue, and it shows the estimated output size and the settings behind it. No full encode needed.

No account. No uploads. No analytics. Never starts an encode.

</div>

---

## How it works

1. Add your encode to HandBrake's queue.
2. Open FSC. It picks up the newest queued job automatically.
3. Read the estimate. Switch jobs from the dropdown if you need another one.
4. After the real encode finishes, press **Record completed output** and pick the file. FSC remembers the real size and uses it to improve later estimates.

FSC reads HandBrake's local queue files directly. It does not read the HandBrake window, run HandBrakeCLI or ffprobe, or ask you to type in encoding settings.

## What you see

- **The estimate**, large, in GiB, with the same size in decimal GB underneath. They are the same number in two unit systems.
- **How it compares to the source file**, as a percentage smaller or larger, based on the source file's size on disk.
- **The rate control it used**, either average bitrate or constant quality (RF).
- **An observed range bar**, once you have comparable completed encodes recorded.
- **Breakdown and assumptions**, expandable: video, audio and overhead sizes, plus every setting that went into the number.

If a stream's size is unknown, the estimate is marked with `*` and the app tells you which parts are missing. It does not fill the gap with a made-up default.

## An estimate, not a guarantee

**Average bitrate** jobs are calculated from the video bitrate and duration, plus each known audio stream. Explicit overhead is included when configured. Two-pass encoding does not get an arbitrary size multiplier.

**Constant quality (RF)** jobs are different. RF is not a bitrate, and the content itself changes the size a lot. Without comparable completed encodes, FSC will not invent an RF-to-size conversion. Once you have recorded some, it shows the range it has observed. That range describes your own history. It is not a statistical confidence interval.

Predictions have not yet been validated across a wide set of media and settings. Use them for planning, not as a promise.

## Privacy

Everything stays on your computer. FSC reads HandBrake's queue data and your local calibration history. It does not open or modify your source video, and it sends nothing anywhere.

## Good to know

- Queue entries are snapshots. If you change a job's settings after adding it, remove it and add it again in HandBrake.
- The queue refreshes by itself every couple of seconds.
- Only waiting and in-progress jobs are listed.
- If HandBrake only exposes the title duration, a chapter or time range you selected may not be reflected.
- Passthrough audio is sized from measured stream data when it matches reliably, otherwise from a known source bitrate. Ambiguous matches are not guessed.
- Burned-in subtitles are part of the picture and add no separate stream. Separate subtitle streams and container overhead can still make the final file differ.

## Build and run

Install the stable Rust toolchain, then:

```powershell
cargo run
cargo test
cargo build --release
```

The release build is `target\release\handbrake-fsc.exe`, a single standalone file. Windows is the main target, since FSC reads HandBrake's local queue. There is no Electron, Chromium, Node.js or web frontend.

## Project layout

| Path | Purpose |
| --- | --- |
| `src/main.rs` | App entry point and window setup |
| `src/ui.rs` | Interface and interactions |
| `src/handbrake.rs` | HandBrake queue parsing |
| `src/prediction.rs` | Size estimation and calibration matching |
| `src/calibration.rs` | Local history of completed encodes |

## Links

- [HandBrake CLI reference](https://handbrake.fr/docs/en/latest/cli/command-line-reference.html)
- [HandBrake official presets](https://handbrake.fr/docs/en/latest/technical/official-presets.html)

## License

See [LICENSE](LICENSE).