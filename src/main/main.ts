import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { access, readFile, stat, writeFile } from 'node:fs/promises';
import { parseHandBrakeScan, getDefaultHandbrakeCandidates } from '../shared/handbrake.js';
import { parseFfprobeOutput } from '../shared/ffprobe.js';
import { createDefaultSettings, predictSize } from '../shared/prediction.js';
import { formatSize } from '../shared/units.js';
import type { CalibrationRecord, MediaInfo, OutputSettings, SampleAnalysis } from '../shared/types.js';
import { readHandBrakeLiveSnapshot } from './handbrake-live.js';

let mainWindow: BrowserWindow | null = null;
const cliConfigPath = () => path.join(app.getPath('userData'), 'handbrake-cli.json');
const sourceMetadataCache = new Map<string, { identity: string; media: Partial<MediaInfo> }>();

async function configuredCliPath(): Promise<string | undefined> {
  const environmentPath = process.env.HANDBRAKE_CLI?.trim();
  if (environmentPath) return environmentPath;
  try {
    const config = JSON.parse(await readFile(cliConfigPath(), 'utf8')) as { executablePath?: unknown };
    return typeof config.executablePath === 'string' ? config.executablePath : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function runningHandBrakeGuiPath(): Promise<string | undefined> {
  if (process.platform !== 'win32') return undefined;
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const script = "$p = Get-CimInstance Win32_Process -Filter \"Name='HandBrake.exe'\" | Select-Object -First 1 -ExpandProperty ExecutablePath; if ($p) { ConvertTo-Json -Compress -InputObject $p }";
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: 5000,
      windowsHide: true,
    });
    const parsed: unknown = JSON.parse(stdout.trim());
    return typeof parsed === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function existingHandBrakeCliPath(): Promise<{ path?: string; guiPath?: string }> {
  const guiPath = await runningHandBrakeGuiPath();
  const savedPath = await configuredCliPath();
  const candidates = [
    savedPath,
    ...(guiPath ? [
      path.join(path.dirname(guiPath), 'HandBrakeCLI.exe'),
      path.join(path.dirname(guiPath), 'HandBrakeCLI'),
    ] : []),
    ...getDefaultHandbrakeCandidates().filter((candidate) => candidate !== 'HandBrakeCLI'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of [...new Set(candidates)]) {
    try {
      await access(candidate);
      return { path: candidate, guiPath };
    } catch {
      // Try the next known install path.
    }
  }
  return { guiPath };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 620,
    height: 720,
    minWidth: 460,
    minHeight: 560,
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist-electron', 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devUrl = 'http://localhost:5173';
  if (app.isPackaged) {
    void mainWindow.loadFile(path.join(app.getAppPath(), 'dist', 'index.html')).catch((error: unknown) => {
      console.error('Failed to load packaged renderer:', error);
    });
  } else {
    void mainWindow.loadURL(devUrl).catch((error: unknown) => {
      console.error('Failed to load development renderer:', error);
    });
  }
}

ipcMain.handle('select-file', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openFile'] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('handbrake-status', async () => {
  const detected = await existingHandBrakeCliPath();
  return {
    guiRunning: Boolean(detected.guiPath),
    guiPath: detected.guiPath,
    cliPath: detected.path,
    message: detected.path
      ? `HandBrakeCLI found: ${detected.path}`
      : detected.guiPath
        ? `HandBrake GUI is running at ${detected.guiPath}, but this installation has no discoverable HandBrakeCLI.exe. Live synchronization may still read visible GUI details and queued jobs.`
        : 'HandBrake GUI is not detected and HandBrakeCLI was not found.',
  };
});

ipcMain.handle('handbrake-live-sync', async () => readHandBrakeLiveSnapshot());

ipcMain.handle('select-handbrake-cli', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'HandBrakeCLI', extensions: process.platform === 'win32' ? ['exe'] : ['*'] }],
  });
  const selectedPath = result.canceled ? undefined : result.filePaths[0];
  if (!selectedPath) return null;
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  await execFileAsync(selectedPath, ['--version'], { timeout: 10000, windowsHide: true });
  await writeFile(cliConfigPath(), JSON.stringify({ executablePath: selectedPath }, null, 2), 'utf8');
  return selectedPath;
});

ipcMain.handle('scan-file', async (_event, filePath: string) => {
  const emptyMedia: MediaInfo = {
    filePath,
    container: 'unknown',
    videoTracks: [],
    audioTracks: [],
    subtitleTracks: [],
    audioTracksKnown: false,
    subtitleTracksKnown: false,
  };
  const failures: string[] = [];
  const fileInfo = await stat(filePath);
  const cacheKey = path.resolve(filePath).toLowerCase();
  const identity = `${fileInfo.size}:${fileInfo.mtimeMs}`;
  const cached = sourceMetadataCache.get(cacheKey);
  if (cached?.identity === identity) return { ...emptyMedia, ...cached.media, filePath };

  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const ffprobeCommand = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
  const ffprobeCandidates = new Set<string>([ffprobeCommand]);
  if (process.platform === 'win32') {
    ffprobeCandidates.add('C:\\ProgramData\\chocolatey\\bin\\ffprobe.exe');
    try {
      const found = await execFileAsync('where.exe', [ffprobeCommand], { timeout: 5000, windowsHide: true });
      for (const candidate of found.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
        ffprobeCandidates.add(candidate);
      }
    } catch {
      // PATH lookup is optional; the known and bare command candidates are still tried.
    }
  }

  const ffprobeArgs = [
    '-v', 'error',
    '-show_entries',
    'format=format_name,duration,size,bit_rate:stream=index,codec_type,codec_name,duration,bit_rate,width,height,avg_frame_rate,r_frame_rate,channels,channel_layout,sample_rate,start_time:stream_tags',
    '-of', 'json',
    filePath,
  ];
  for (const candidate of ffprobeCandidates) {
    try {
      const { stdout } = await execFileAsync(candidate, ffprobeArgs, {
        timeout: 30000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      });
      const probed = parseFfprobeOutput(stdout, filePath, fileInfo.size);
      if ((probed.videoTracks?.length ?? 0) === 0 && probed.durationSeconds === undefined) {
        failures.push(`${candidate}: ffprobe returned no usable source streams or duration.`);
        continue;
      }
      sourceMetadataCache.set(cacheKey, { identity, media: probed });
      return { ...emptyMedia, ...probed, filePath };
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const detected = await existingHandBrakeCliPath();
  const configured = await configuredCliPath();
  const candidates = [
    configured,
    detected.path,
    ...getDefaultHandbrakeCandidates(),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      const { stdout, stderr } = await execFileAsync(candidate, ['--scan', '-i', filePath], { timeout: 60000, windowsHide: true });
      const parsed = parseHandBrakeScan(`${stdout || ''}\n${stderr || ''}`);
      if (!parsed.durationSeconds && parsed.videoTracks?.length === 0 && parsed.audioTracks?.length === 0) {
        failures.push(`${candidate}: HandBrakeCLI returned no recognized source metadata.`);
        continue;
      }
      let handbrakeVersion: string | undefined;
      let versionWarning: string | undefined;
      try {
        const version = await execFileAsync(candidate, ['--version'], { timeout: 10000, windowsHide: true });
        handbrakeVersion = `${version.stdout || ''}${version.stderr || ''}`.trim() || undefined;
      } catch (error) {
        versionWarning = `Scan succeeded, but HandBrakeCLI version detection failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      const result = {
        ...emptyMedia,
        ...parsed,
        filePath,
        handbrakeVersion,
        scanError: versionWarning,
      };
      sourceMetadataCache.set(cacheKey, { identity, media: result });
      return result;
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    ...emptyMedia,
    scanError: failures.length > 0
      ? `HandBrakeCLI could not scan this source. Set HANDBRAKE_CLI to the executable path or enter metadata manually. ${failures.slice(-2).join(' | ')}`
      : 'HandBrakeCLI was not found. Set HANDBRAKE_CLI to its executable path or enter metadata manually.',
  };
});

ipcMain.handle('select-actual-output', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openFile'] });
  if (result.canceled || !result.filePaths[0]) return null;
  const { stat } = await import('node:fs/promises');
  const file = await stat(result.filePaths[0]);
  return { sizeBytes: file.size };
});

ipcMain.handle('predict', async (_event, payload: {
  media: MediaInfo;
  settings: OutputSettings;
  sampleAnalyses: SampleAnalysis[];
  calibrationRecords: CalibrationRecord[];
}) => {
  return predictSize(payload.media, payload.settings, payload.sampleAnalyses, payload.calibrationRecords);
});

ipcMain.handle('defaults-for-media', async (_event, media: MediaInfo) => {
  return createDefaultSettings(media);
});

ipcMain.handle('format-size', async (_event, bytes: number) => {
  return formatSize(bytes);
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
