import { contextBridge, ipcRenderer } from 'electron';
import type { CalibrationRecord, LiveHandBrakeSnapshot, MediaInfo, OutputSettings, PredictionResult, SampleAnalysis } from '../shared/types.js';

contextBridge.exposeInMainWorld('hbPredictor', {
  selectFile: () => ipcRenderer.invoke('select-file'),
  handbrakeStatus: () => ipcRenderer.invoke('handbrake-status'),
  handbrakeLiveSync: () => ipcRenderer.invoke('handbrake-live-sync'),
  selectHandBrakeCli: () => ipcRenderer.invoke('select-handbrake-cli'),
  selectActualOutput: () => ipcRenderer.invoke('select-actual-output'),
  scanFile: (filePath: string) => ipcRenderer.invoke('scan-file', filePath),
  predict: (payload: { media: MediaInfo; settings: OutputSettings; sampleAnalyses: SampleAnalysis[]; calibrationRecords: CalibrationRecord[]; }) => ipcRenderer.invoke('predict', payload),
  defaultsForMedia: (media: MediaInfo) => ipcRenderer.invoke('defaults-for-media', media),
  formatSize: (bytes: number) => ipcRenderer.invoke('format-size', bytes),
});

declare global {
  interface Window {
    hbPredictor: {
      selectFile: () => Promise<string | null>;
      handbrakeStatus: () => Promise<{ guiRunning: boolean; guiPath?: string; cliPath?: string; message: string }>;
      handbrakeLiveSync: () => Promise<LiveHandBrakeSnapshot>;
      selectHandBrakeCli: () => Promise<string | null>;
      selectActualOutput: () => Promise<{ sizeBytes: number } | null>;
      scanFile: (filePath: string) => Promise<MediaInfo>;
      predict: (payload: { media: MediaInfo; settings: OutputSettings; sampleAnalyses: SampleAnalysis[]; calibrationRecords: CalibrationRecord[]; }) => Promise<PredictionResult>;
      defaultsForMedia: (media: MediaInfo) => Promise<OutputSettings>;
      formatSize: (bytes: number) => Promise<{ giB: string; gB: string; bytes: string }>;
    };
  }
}
