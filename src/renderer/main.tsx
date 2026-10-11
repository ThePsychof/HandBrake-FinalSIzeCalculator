import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import './styles.css';
import { appendCalibrationRecord, getComparableRecords, loadCalibrationRecords, makeTrackSignature } from '../shared/calibration';
import { queueJobToMedia, selectedQueueJob } from '../shared/live-handbrake.js';
import type { AudioTrack, CalibrationRecord, LiveHandBrakeSnapshot, MediaInfo, OutputSettings, PredictionResult } from '../shared/types';

const emptyMedia: MediaInfo = {
  filePath: '',
  durationSeconds: 0,
  container: 'unknown',
  videoTracks: [],
  audioTracks: [],
  subtitleTracks: [],
};

const initialSettings: OutputSettings = {
  mode: 'average-bitrate',
  container: 'unknown',
  videoCodec: 'unknown',
  videoBitrateKbps: undefined,
  qualityRf: 20,
  twoPass: false,
  encoderPreset: 'medium',
  filterSettings: '',
  audioTracks: [],
  subtitleTracks: [],
};

function normalizedTrackName(value: string | undefined): string {
  return value?.trim().toLowerCase().replace(/[^a-z0-9]+/g, '') ?? '';
}

function audioTrackCodec(value: string | undefined): AudioTrack['codec'] {
  const codec = value?.toLowerCase() ?? '';
  if (codec.includes('e-ac-3') || codec.includes('eac3')) return 'eac3';
  if (codec.includes('ac-3') || codec.includes('ac3')) return 'ac3';
  if (codec.includes('aac')) return 'aac';
  if (codec.includes('mp3')) return 'mp3';
  if (codec.includes('opus')) return 'opus';
  if (codec.includes('flac')) return 'flac';
  return 'unknown';
}

function outputAudioForLiveJob(
  job: NonNullable<LiveHandBrakeSnapshot['currentConfiguration']>,
  media: MediaInfo,
): OutputSettings['audioTracks'] | undefined {
  const rows = job.settings.audioTracks?.length
    ? job.settings.audioTracks
    : job.audioSummary?.length === 1 && media.audioTracks.length === 1
      ? [{
        index: job.sourceAudioTracks[0]?.index ?? 0,
        codec: audioTrackCodec(job.audioSummary[0]) === 'unknown'
          ? media.audioTracks[0].codec
          : audioTrackCodec(job.audioSummary[0]),
        passthrough: /passthru|pass-through/i.test(job.audioSummary[0]),
        enabled: true,
      }]
      : undefined;
  if (!rows) return undefined;

  return rows.map((row) => {
    const uiTrack = job.sourceAudioTracks.find((track) => track.index === row.index);
    let candidates = media.audioTracks;
    if (uiTrack?.channels !== undefined) {
      candidates = candidates.filter((track) => track.channels === uiTrack.channels);
    }
    if (uiTrack?.language) {
      const language = normalizedTrackName(uiTrack.language);
      const sameLanguage = candidates.filter((track) => normalizedTrackName(track.language) === language);
      if (sameLanguage.length > 0) candidates = sameLanguage;
    }
    if (uiTrack && uiTrack.codec !== 'unknown' && uiTrack.codec !== 'copy') {
      const sameCodec = candidates.filter((track) => track.codec === uiTrack.codec);
      if (sameCodec.length > 0) candidates = sameCodec;
    }
    if (row.passthrough && row.codec !== 'unknown' && row.codec !== 'copy') {
      const sameCodec = candidates.filter((track) => track.codec === row.codec);
      if (sameCodec.length > 0) candidates = sameCodec;
    }
    const matched = candidates.length === 1
      && (uiTrack !== undefined
        || (row.passthrough && row.codec !== 'unknown' && row.codec !== 'copy')
        || (job.audioSummary?.length === 1 && media.audioTracks.length === 1))
      ? candidates[0]
      : undefined;
    return {
      ...row,
      ...(matched?.streamIndex !== undefined ? { sourceStreamIndex: matched.streamIndex, sourceTrackMatch: true } : { sourceTrackMatch: false }),
      ...(row.passthrough && matched ? { codec: matched.codec } : {}),
    };
  });
}

async function predictWithCalibration(media: MediaInfo, settings: OutputSettings): Promise<PredictionResult> {
  const history = loadCalibrationRecords();
  const comparable = media.durationSeconds
    ? getComparableRecords(history, {
      method: settings.mode,
      container: settings.container,
      encoder: settings.videoCodec,
      durationSeconds: media.durationSeconds,
      preset: settings.encoderPreset,
      handbrakeVersion: media.handbrakeVersion,
      width: media.width,
      height: media.height,
      qualityRf: settings.mode === 'constant-quality' ? settings.qualityRf : undefined,
      bitrateKbps: settings.mode === 'average-bitrate' ? settings.videoBitrateKbps : undefined,
      filters: settings.filterSettings,
      audioSignature: makeTrackSignature(media, settings, 'audio'),
      subtitleSignature: makeTrackSignature(media, settings, 'subtitle'),
    })
    : [];
  return window.hbPredictor.predict({
    media,
    settings,
    sampleAnalyses: [],
    calibrationRecords: comparable,
  });
}

function App() {
  const [media, setMedia] = useState<MediaInfo>(emptyMedia);
  const [settings, setSettings] = useState<OutputSettings>(initialSettings);
  const [result, setResult] = useState<PredictionResult | null>(null);
  const [error, setError] = useState('');
  const [scanningSource, setScanningSource] = useState<string | null>(null);
  const [calibrationMessage, setCalibrationMessage] = useState('');
  const [handbrakeStatus, setHandbrakeStatus] = useState<{ guiRunning: boolean; guiPath?: string; cliPath?: string; message: string } | null>(null);
  const [liveSnapshot, setLiveSnapshot] = useState<LiveHandBrakeSnapshot | null>(null);
  const lastAppliedJobKey = useRef('');
  const manualOverrides = useRef(new Set<string>());
  const lastScannedSource = useRef('');

  const setManualOverride = (field: string) => {
    manualOverrides.current.add(field);
  };

  const refreshHandBrakeStatus = async () => {
    try {
      setHandbrakeStatus(await window.hbPredictor.handbrakeStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not detect HandBrake.');
    }
  };

  useEffect(() => {
    void refreshHandBrakeStatus();
  }, []);

  useEffect(() => {
    let stopped = false;
    let syncing = false;
    const synchronize = async () => {
      if (syncing) return;
      syncing = true;
      try {
        const snapshot = await window.hbPredictor.handbrakeLiveSync();
        if (stopped) return;
        setLiveSnapshot(snapshot);
        const job = snapshot.currentConfiguration ?? selectedQueueJob(snapshot.jobs);
        if (job) {
          const key = JSON.stringify({
            processId: job.processId,
            taskId: job.taskId,
            sourcePath: job.sourcePath,
            settings: job.settings,
            sourceDurationSeconds: job.sourceDurationSeconds,
            width: job.width,
            height: job.height,
          });
          if (key !== lastAppliedJobKey.current) {
            lastAppliedJobKey.current = key;
            if (job.sourceDurationSeconds !== undefined) manualOverrides.current.delete('durationSeconds');
            const queuedMedia = snapshot.currentConfiguration ? undefined : queueJobToMedia(job);
            if (queuedMedia) {
              setMedia((previous) => {
                const sameSource = previous.filePath.toLowerCase() === queuedMedia.filePath.toLowerCase();
                const next = {
                  ...(sameSource ? previous : emptyMedia),
                  ...queuedMedia,
                  ...(sameSource ? {
                    sourceContainer: previous.sourceContainer,
                    videoTracks: previous.videoTracks,
                    audioTracks: previous.audioTracks,
                    subtitleTracks: previous.subtitleTracks,
                    sourceFileSizeBytes: previous.sourceFileSizeBytes,
                    handbrakeVersion: previous.handbrakeVersion,
                  } : {}),
                };
                return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
              });
            }
            if (snapshot.currentConfiguration && job.sourcePath) {
              setMedia((previous) => {
                const sameSource = previous.filePath.toLowerCase() === job.sourcePath?.toLowerCase();
                const base = sameSource ? previous : { ...emptyMedia, filePath: job.sourcePath };
                return {
                  ...base,
                  filePath: job.sourcePath!,
                  sourceTitle: job.sourcePath?.split(/[\\/]/).pop() ?? base.sourceTitle,
                  durationSeconds: job.sourceDurationSeconds ?? base.durationSeconds,
                  width: base.width ?? job.width,
                  height: base.height ?? job.height,
                  frameRate: base.frameRate ?? job.frameRate,
                };
              });
            }
            setSettings((previous) => {
              const next = { ...previous };
              const incoming = job.settings;
              if (incoming.mode) {
                next.mode = incoming.mode;
                manualOverrides.current.delete('mode');
                if (incoming.mode === 'constant-quality' && !manualOverrides.current.has('videoBitrateKbps')) next.videoBitrateKbps = undefined;
                if (incoming.mode === 'average-bitrate' && !manualOverrides.current.has('qualityRf')) next.qualityRf = undefined;
              }
              if (incoming.container && incoming.container !== 'unknown') {
                next.container = incoming.container;
                manualOverrides.current.delete('container');
              }
              if (incoming.videoCodec && incoming.videoCodec !== 'unknown') {
                next.videoCodec = incoming.videoCodec;
                manualOverrides.current.delete('videoCodec');
              }
              if (incoming.videoEncoderName !== undefined) next.videoEncoderName = incoming.videoEncoderName;
              if (incoming.videoBitrateKbps !== undefined) {
                next.videoBitrateKbps = incoming.videoBitrateKbps;
                manualOverrides.current.delete('videoBitrateKbps');
              }
              if (incoming.qualityRf !== undefined) {
                next.qualityRf = incoming.qualityRf;
                manualOverrides.current.delete('qualityRf');
              }
              if (incoming.encoderPreset !== undefined) {
                next.encoderPreset = incoming.encoderPreset;
                manualOverrides.current.delete('encoderPreset');
              }
              if (incoming.twoPass !== undefined) {
                next.twoPass = incoming.twoPass;
                manualOverrides.current.delete('twoPass');
              }
              if (incoming.audioTracks !== undefined && incoming.audioTracks.length > 0) {
                next.audioTracks = incoming.audioTracks;
                manualOverrides.current.delete('audioTracks');
              }
              if (incoming.subtitleTracks !== undefined && incoming.subtitleTracks.length > 0) {
                next.subtitleTracks = incoming.subtitleTracks;
                manualOverrides.current.delete('subtitleTracks');
              }
              if (incoming.filterSettings !== undefined) {
                next.filterSettings = incoming.filterSettings;
                manualOverrides.current.delete('filterSettings');
              }
              if (incoming.encoderTune !== undefined) next.encoderTune = incoming.encoderTune;
              if (incoming.encoderProfile !== undefined) next.encoderProfile = incoming.encoderProfile;
              if (incoming.encoderLevel !== undefined) next.encoderLevel = incoming.encoderLevel;
              if (incoming.encoderOptions !== undefined) next.encoderOptions = incoming.encoderOptions;
              if (incoming.outputWidth !== undefined) next.outputWidth = incoming.outputWidth;
              if (incoming.outputHeight !== undefined) next.outputHeight = incoming.outputHeight;
              if (incoming.frameRateMode !== undefined) next.frameRateMode = incoming.frameRateMode;
              if (incoming.frameRate !== undefined) next.frameRate = incoming.frameRate;
              return next;
            });
            if (snapshot.currentConfiguration && job.sourcePath
              && lastScannedSource.current.toLowerCase() !== job.sourcePath.toLowerCase()) {
              lastScannedSource.current = job.sourcePath;
              setScanningSource(job.sourcePath);
              try {
                const scanned = await window.hbPredictor.scanFile(job.sourcePath);
                if (!stopped) {
                  const audioTracks = outputAudioForLiveJob(job, scanned);
                  if (job.sourceDurationSeconds !== undefined) manualOverrides.current.delete('durationSeconds');
                  setMedia((previous) => {
                    if (previous.filePath.toLowerCase() !== job.sourcePath?.toLowerCase()) return previous;
                    return {
                      ...scanned,
                      ...(job.sourceDurationSeconds !== undefined
                        ? { durationSeconds: scanned.durationSeconds ?? job.sourceDurationSeconds }
                        : {}),
                      sourceTitle: job.sourcePath?.split(/[\\/]/).pop() ?? previous.sourceTitle,
                      handbrakeVersion: scanned.handbrakeVersion ?? previous.handbrakeVersion,
                    };
                  });
                  if (audioTracks) {
                    setSettings((previous) => ({ ...previous, audioTracks }));
                    manualOverrides.current.delete('audioTracks');
                  }
                }
              } catch (err) {
                lastScannedSource.current = '';
                if (!stopped) setError(err instanceof Error ? err.message : 'HandBrake source scan failed.');
              } finally {
                if (!stopped) setScanningSource((current) => current === job.sourcePath ? null : current);
              }
            }
          }
        } else if (snapshot.sourcePath || snapshot.durationSeconds || snapshot.width || snapshot.height) {
          setMedia((previous) => {
            if (!snapshot.sourcePath && previous.filePath) return previous;
            const sourceChanged = Boolean(snapshot.sourcePath && previous.filePath !== snapshot.sourcePath);
            const base = sourceChanged
              ? { ...emptyMedia, audioTracksKnown: false, subtitleTracksKnown: false }
              : previous;
            const next = {
              ...base,
              filePath: snapshot.sourcePath ?? base.filePath,
              sourceTitle: snapshot.sourceDisplayName ?? base.sourceTitle,
              durationSeconds: manualOverrides.current.has('durationSeconds')
                ? previous.durationSeconds
                : snapshot.durationSeconds ?? base.durationSeconds,
              width: snapshot.width ?? base.width,
              height: snapshot.height ?? base.height,
              frameRate: snapshot.frameRate ?? base.frameRate,
            };
            return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
          });
        }
      } catch (err) {
        if (!stopped) setLiveSnapshot(null);
        if (!stopped) setError(err instanceof Error ? err.message : 'Could not synchronize with HandBrake.');
      } finally {
        syncing = false;
      }
    };
    void synchronize();
    const interval = window.setInterval(() => void synchronize(), 6000);
    return () => {
      stopped = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timeout = window.setTimeout(async () => {
      try {
        const predicted = await predictWithCalibration(media, settings);
        if (!cancelled) {
          setResult(predicted);
          setError('');
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Prediction failed');
      }
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [media, settings]);

  const locateHandBrakeCli = async () => {
    try {
      const selected = await window.hbPredictor.selectHandBrakeCli();
      if (selected) {
        await refreshHandBrakeStatus();
        setError('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not configure HandBrakeCLI.');
    }
  };

  const onSelectFile = async () => {
    try {
      const selected = await window.hbPredictor.selectFile();
      if (!selected) return;
      manualOverrides.current.delete('durationSeconds');
      setError('');
      setScanningSource(selected);
      try {
        const scanned = await window.hbPredictor.scanFile(selected);
        setMedia(scanned);
        const defaults = await window.hbPredictor.defaultsForMedia(scanned);
        setSettings((prev) => ({ ...prev, ...defaults }));
      } finally {
        setScanningSource((current) => current === selected ? null : current);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Source selection or scan failed.');
    }
  };

  const onPredict = async () => {
    try {
      const predicted = await predictWithCalibration(media, settings);
      setResult(predicted);
      setError('');
      setCalibrationMessage('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Prediction failed');
    }
  };

  const onRecordActual = async () => {
    if (!result || result.predictedBytes === null || !media.durationSeconds) {
      setError('A source duration and numeric prediction are required before recording a completed encode.');
      return;
    }
    try {
      const selectedOutput = await window.hbPredictor.selectActualOutput();
      if (!selectedOutput) return;
      const record: CalibrationRecord = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        sourceDurationSeconds: media.durationSeconds,
        handbrakeVersion: media.handbrakeVersion,
        encoder: settings.videoCodec,
        videoCodec: settings.videoCodec,
        preset: settings.encoderPreset,
        bitrateKbps: settings.mode === 'average-bitrate' ? settings.videoBitrateKbps : undefined,
        qualityRf: settings.mode === 'constant-quality' ? settings.qualityRf : undefined,
        container: settings.container,
        width: media.width,
        height: media.height,
        filters: settings.filterSettings,
        audioSignature: makeTrackSignature(media, settings, 'audio'),
        subtitleSignature: makeTrackSignature(media, settings, 'subtitle'),
        predictedBytes: result.predictedBytes,
        actualBytes: selectedOutput.sizeBytes,
        method: settings.mode,
      };
      const updated = appendCalibrationRecord(record);
      setCalibrationMessage(`Saved locally. ${updated.length} encode record(s) stored on this device.`);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the calibration record.');
    }
  };

  const summary = useMemo(() => {
    if (!result || result.predictedBytes === null) return null;
    return {
      predictedGiB: result.predictedGiB.toFixed(2),
      lower: result.lowerBoundBytes === null ? null : result.lowerBoundBytes / (1024 ** 3),
      upper: result.upperBoundBytes === null ? null : result.upperBoundBytes / (1024 ** 3),
    };
  }, [result]);

  const setAudioTrack = (index: number, patch: Partial<OutputSettings['audioTracks'][number]>) => {
    setManualOverride('audioTracks');
    setSettings((previous) => ({
      ...previous,
      audioTracks: previous.audioTracks.map((track) => track.index === index ? { ...track, ...patch } : track),
    }));
  };

  const setSubtitleTrack = (index: number, patch: Partial<OutputSettings['subtitleTracks'][number]>) => {
    setManualOverride('subtitleTracks');
    setSettings((previous) => ({
      ...previous,
      subtitleTracks: previous.subtitleTracks.map((track) => track.index === index ? { ...track, ...patch } : track),
    }));
  };

  const currentJob = liveSnapshot?.currentConfiguration ?? (liveSnapshot ? selectedQueueJob(liveSnapshot.jobs) : undefined);
  const displayedFile = media.filePath
    || (liveSnapshot?.sourceDisplayName
      ? `${liveSnapshot.sourceDisplayName} (HandBrake GUI source; full path unavailable)`
      : 'No file selected');
  const activeAudioCount = settings.audioTracks.filter((track) => track.enabled).length;
  const activeSubtitleCount = settings.subtitleTracks.filter((track) => track.enabled).length;
  const predictedValue = summary
    ? result?.isPartial
      ? `${summary.predictedGiB} GiB*`
      : `${summary.predictedGiB} GiB`
    : undefined;

  const addManualAudioTrack = () => {
    const nextIndex = Math.max(-1, ...settings.audioTracks.map((track) => track.index)) + 1;
    setSettings((previous) => ({
      ...previous,
      audioTracks: [...previous.audioTracks, {
        index: nextIndex,
        codec: 'unknown',
        bitrateKbps: undefined,
        passthrough: false,
        enabled: true,
      }],
    }));
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <div className="brand-mark" aria-hidden="true">HB</div>
          <div>
            <h1>Size Predictor</h1>
            <p>Estimate before you encode.</p>
          </div>
        </div>
        <div className="topbar-actions">
          <button className="source-button" onClick={onSelectFile} disabled={Boolean(scanningSource)}>
            {scanningSource ? 'Scanning…' : media.filePath ? 'Change source' : 'Select source'}
          </button>
        </div>
      </header>

      <main className="predictor">
        <section className="estimate-card">
          <div className="estimate-heading">
            <div>
              <p className="eyebrow">PREDICTED OUTPUT</p>
              <h2>{settings.mode === 'average-bitrate' ? 'Average bitrate' : 'Constant quality'}</h2>
            </div>
            <span className={`sync-indicator ${liveSnapshot?.available ? 'is-live' : ''}`}>
              <span className={scanningSource ? 'is-spinning' : ''} />
              {scanningSource ? 'Scanning source' : liveSnapshot?.available ? 'HandBrake connected' : 'Manual'}
            </span>
          </div>
          <div className={`estimate-number ${summary ? '' : 'is-empty'}`} aria-live="polite">
            {predictedValue ?? '—'}
          </div>
          <p className="estimate-subtitle">
            {summary
              ? `${result?.predictedGB.toFixed(2)} GB · decimal`
              : result?.assumptions[0] ?? 'Select a source or configure inputs to see an estimate.'}
          </p>
          {result?.isPartial ? <p className="partial-note">* Partial estimate — some output contributions are not included.</p> : null}
          {result?.missingContributions?.length ? (
            <p className="error estimate-error">{result.missingContributions.join(' ')}</p>
          ) : null}
          {media.scanError ? <p className="error estimate-error">{media.scanError}</p> : null}
          {error ? <p className="error estimate-error">{error}</p> : null}
          <div className="estimate-footer">
            <span>{settings.mode === 'average-bitrate' ? 'Based on configured stream bitrates' : 'Experimental estimate'}</span>
            {summary?.lower !== null && summary?.lower !== undefined && summary.upper !== null
              ? <span>Observed {summary.lower.toFixed(2)}–{summary.upper.toFixed(2)} GiB</span>
              : <span>No validated range</span>}
          </div>
        </section>

        <section className="summary-card">
          <div className="section-heading">
            <div>
              <p className="eyebrow">INPUT SUMMARY</p>
              <h2>{media.sourceTitle ?? liveSnapshot?.sourceDisplayName ?? 'No source selected'}</h2>
            </div>
            {media.durationSeconds
              ? <span className="duration-pill">{(media.durationSeconds / 60).toFixed(0)} min</span>
              : null}
          </div>
          <div className="summary-grid">
            <div className="summary-item">
              <span>Picture</span>
              <strong>
                {media.width && media.height ? `${media.width} × ${media.height}` : '—'}
                {media.frameRate ? ` · ${media.frameRate.toFixed(2)} fps` : ''}
              </strong>
            </div>
            <div className="summary-item">
              <span>Video</span>
              <strong>{currentJob?.settings.videoEncoderName ?? currentJob?.settings.videoCodec ?? media.videoTracks[0]?.codec ?? '—'}</strong>
            </div>
            <div className="summary-item">
              <span>Encoding</span>
              <strong>
                {settings.mode === 'average-bitrate'
                  ? `${settings.videoBitrateKbps ?? '—'} kbps`
                  : `RF ${settings.qualityRf ?? '—'}`}
                {settings.encoderPreset ? ` · ${settings.encoderPreset}` : ''}
              </strong>
            </div>
            <div className="summary-item">
              <span>Output</span>
              <strong>{settings.container === 'unknown' ? '—' : settings.container.toUpperCase()}</strong>
            </div>
            <div className="summary-item">
              <span>Audio</span>
              <strong>
                {activeAudioCount
                  ? `${activeAudioCount} track${activeAudioCount === 1 ? '' : 's'}${currentJob?.audioSummary?.[0] ? ` · ${currentJob.audioSummary[0]}` : ''}`
                  : 'None selected'}
              </strong>
            </div>
            <div className="summary-item">
              <span>Subtitles</span>
              <strong>
                {activeSubtitleCount
                  ? `${activeSubtitleCount} track${activeSubtitleCount === 1 ? '' : 's'}${settings.subtitleTracks.some((track) => track.enabled && track.burnIn) ? ' · burned in' : ''}`
                  : 'None selected'}
              </strong>
            </div>
          </div>
          <p className="source-path" title={displayedFile}>{displayedFile}</p>
          {scanningSource ? (
            <div className="scan-status" role="status" aria-live="polite">
              <span className="spinner" />
              <span>Scanning {scanningSource.split(/[\\/]/).pop()}… Reading media streams and duration.</span>
            </div>
          ) : null}
        </section>

        {result ? (
          <details className="details-card">
            <summary>Estimate details <span>Breakdown, assumptions and calibration</span></summary>
            <div className="details-content">
              <p>{result.methodology}</p>
              <p><strong>Uncertainty:</strong> {result.uncertaintyText}</p>
              <p><strong>Calibration:</strong> {result.calibrationSamples} comparable record(s)</p>
              <div className="breakdown">
                {result.breakdown.map((item) => (
                  <div key={item.label} className="breakdown-row">
                    <span>{item.label}</span>
                    <strong>{(item.bytes / (1024 ** 3)).toFixed(2)} GiB</strong>
                  </div>
                ))}
                {result.streamPayloadBytes !== null && result.predictedBytes !== null ? (
                  <div className="breakdown-row total-row">
                    <span>Predicted total</span>
                    <strong>{(result.predictedBytes / (1024 ** 3)).toFixed(2)} GiB</strong>
                  </div>
                ) : null}
              </div>
              <ul>{result.assumptions.map((item: string) => <li key={item}>{item}</li>)}</ul>
              {result.predictedBytes !== null ? (
                <div className="calibration-action">
                  <button className="secondary" onClick={onRecordActual}>Record completed output</button>
                  <span>Save an actual encode size locally to improve comparable predictions.</span>
                </div>
              ) : null}
              {calibrationMessage ? <p className="success">{calibrationMessage}</p> : null}
            </div>
          </details>
        ) : null}

        <details className="details-card settings-disclosure">
          <summary>Adjust inputs <span>Source, video, audio and subtitle settings</span></summary>
          <div className="details-content">
            {handbrakeStatus ? (
              <div className={handbrakeStatus.cliPath ? 'integration-status' : 'integration-status warning'}>
                {handbrakeStatus.message}
                <button className="text-button" onClick={locateHandBrakeCli}>Locate HandBrakeCLI</button>
              </div>
            ) : null}
            {liveSnapshot ? (
              <div className={liveSnapshot.available ? 'integration-status' : 'integration-status warning'}>
                <strong>{liveSnapshot.message}</strong>
                {liveSnapshot.available ? <p>Last synced {new Date(liveSnapshot.synchronizedAt).toLocaleTimeString()}</p> : null}
                {currentJob?.retrievedFields?.length ? <p>Synced: {currentJob.retrievedFields.join('; ')}</p> : null}
                {currentJob?.unavailableFields.length ? <p>Unavailable: {currentJob.unavailableFields.join('; ')}</p> : null}
                {liveSnapshot.unavailableFields.length ? <p>{liveSnapshot.unavailableFields.join('; ')}</p> : null}
                {manualOverrides.current.size > 0 ? (
                  <p>
                    Manual values: {[...manualOverrides.current].join(', ')}.
                    <button className="text-button" onClick={() => { manualOverrides.current.clear(); lastAppliedJobKey.current = ''; }}>Use current HandBrake values</button>
                  </p>
                ) : null}
              </div>
            ) : null}
            {currentJob?.audioSummary?.length ? <p>HandBrake audio: {currentJob.audioSummary.join('; ')}</p> : null}
            {currentJob?.subtitleSummary?.length ? <p>HandBrake subtitles: {currentJob.subtitleSummary.join('; ')}</p> : null}
            <p className="help-text">HandBrake is read locally. Estimates never start an encode.</p>
            <div className="field-row">
              <label>
                Source duration (seconds)
                <input type="number" min="0" step="0.1" value={media.durationSeconds ?? ''} onChange={(e) => { setManualOverride('durationSeconds'); setMedia({ ...media, durationSeconds: e.target.value === '' ? undefined : Number(e.target.value) }); }} />
              </label>
              <label>
                Mode
                <select value={settings.mode} onChange={(e) => { setManualOverride('mode'); setSettings({ ...settings, mode: e.target.value as OutputSettings['mode'] }); }}>
                  <option value="average-bitrate">Average bitrate</option>
                  <option value="constant-quality">Constant quality / RF</option>
                </select>
              </label>
            </div>
          <div className="field-row">
            <label>
              Output container
              <select value={settings.container} onChange={(e) => { setManualOverride('container'); setSettings({ ...settings, container: e.target.value as any }); }}>
                <option value="unknown">Select output container</option>
                <option value="mp4">MP4</option>
                <option value="mkv">MKV</option>
                <option value="m4v">M4V</option>
                <option value="mov">MOV</option>
              </select>
            </label>
          </div>
          <div className="field-row">
            <label>
              Video bitrate (kbps)
              <input type="number" min="1" value={settings.videoBitrateKbps ?? ''} onChange={(e) => { setManualOverride('videoBitrateKbps'); setSettings({ ...settings, videoBitrateKbps: e.target.value === '' ? undefined : Number(e.target.value) }); }} />
            </label>
            <label>
              RF value
              <input type="number" value={settings.qualityRf ?? ''} disabled={settings.mode !== 'constant-quality'} onChange={(e) => { setManualOverride('qualityRf'); setSettings({ ...settings, qualityRf: e.target.value === '' ? undefined : Number(e.target.value) }); }} />
            </label>
          </div>
          <div className="field-row">
            <label>
              Encoder preset
              <input type="text" value={settings.encoderPreset ?? ''} placeholder="Unknown / enter manually" onChange={(e) => { setManualOverride('encoderPreset'); setSettings({ ...settings, encoderPreset: e.target.value }); }} />
            </label>
            <label>
              Video codec
              <select value={settings.videoCodec} onChange={(e) => { setManualOverride('videoCodec'); setSettings({ ...settings, videoCodec: e.target.value as any, videoEncoderName: undefined }); }}>
                <option value="unknown">Select output encoder</option>
                <option value="x264">x264</option>
                <option value="x265">x265</option>
                <option value="h264">H.264 hardware/other</option>
                <option value="hevc">HEVC hardware/other</option>
                <option value="av1">AV1</option>
                <option value="vp9">VP9</option>
              </select>
            </label>
          </div>
          <div className="field-row">
            <label>
              Explicit container overhead (%)
              <input type="number" min="0" step="0.1" value={settings.muxingOverheadPercent ?? ''} onChange={(e) => setSettings({ ...settings, muxingOverheadPercent: e.target.value === '' ? undefined : Number(e.target.value) })} />
            </label>
            <label className="check-field">
              Two-pass encoding{currentJob && settings.twoPass === undefined ? ' (unknown)' : ''}
              <input type="checkbox" checked={settings.twoPass ?? false} onChange={(e) => { setManualOverride('twoPass'); setSettings({ ...settings, twoPass: e.target.checked }); }} />
            </label>
          </div>
          <h3>Audio output tracks</h3>
          {settings.audioTracks.map((track) => {
            const source = media.audioTracks.find((item) => item.index === track.index);
            return (
              <div className="track-row" key={track.index}>
                <label className="check-field">
                  Track {track.index}: {source?.language ?? 'manual'} · source {source?.codec ?? 'unknown'}
                  <input type="checkbox" checked={track.enabled} onChange={(e) => setAudioTrack(track.index, { enabled: e.target.checked })} />
                </label>
                <label className="check-field">
                  Passthrough
                  <input type="checkbox" checked={track.passthrough} onChange={(e) => setAudioTrack(track.index, { passthrough: e.target.checked })} />
                </label>
                <label>
                  Output bitrate (kbps)
                  <input type="number" min="1" disabled={track.passthrough} value={track.bitrateKbps ?? ''} onChange={(e) => setAudioTrack(track.index, { bitrateKbps: e.target.value === '' ? undefined : Number(e.target.value) })} />
                </label>
              </div>
            );
          })}
          <button className="secondary" onClick={addManualAudioTrack}>Add manual audio track</button>
          <h3>Subtitle output tracks</h3>
          {settings.subtitleTracks.map((track) => (
            <div className="track-row" key={track.index}>
              <label className="check-field">
                Track {track.index}: {media.subtitleTracks.find((item) => item.index === track.index)?.language ?? 'subtitle'}
                <input type="checkbox" checked={track.enabled} onChange={(e) => setSubtitleTrack(track.index, { enabled: e.target.checked })} />
              </label>
              <label className="check-field">
                Burn into video
                <input type="checkbox" checked={track.burnIn} onChange={(e) => setSubtitleTrack(track.index, { burnIn: e.target.checked })} />
              </label>
            </div>
          ))}
          <button className="primary" onClick={onPredict}>Predict output size</button>
          {error ? <p className="error">{error}</p> : null}
          </div>
        </details>
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
