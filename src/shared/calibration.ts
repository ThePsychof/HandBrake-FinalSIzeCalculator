import { CalibrationRecord, OutputSettings, MediaInfo } from './types.js';

const STORAGE_KEY = 'hb-size-predictor-calibration-v1';

function isCalibrationRecord(value: unknown): value is CalibrationRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string'
    && typeof record.method === 'string'
    && typeof record.container === 'string'
    && typeof record.encoder === 'string'
    && Number.isFinite(record.sourceDurationSeconds)
    && Number.isFinite(record.predictedBytes)
    && Number.isFinite(record.actualBytes);
}

export interface CalibrationCriteria {
  method: CalibrationRecord['method'];
  container: string;
  encoder: string;
  durationSeconds: number;
  preset?: string;
  handbrakeVersion?: string;
  encoderVersion?: string;
  width?: number;
  height?: number;
  qualityRf?: number;
  bitrateKbps?: number;
  filters?: string;
  audioSignature?: string;
  subtitleSignature?: string;
}

export function loadCalibrationRecords(): CalibrationRecord[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(isCalibrationRecord)) {
    throw new Error('Local calibration data is malformed; clear the application site data to reset it.');
  }
  return parsed;
}

export function saveCalibrationRecords(records: CalibrationRecord[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}

export function appendCalibrationRecord(record: CalibrationRecord): CalibrationRecord[] {
  const existing = loadCalibrationRecords();
  const next = [record, ...existing].slice(0, 200);
  saveCalibrationRecords(next);
  return next;
}

export function makeTrackSignature(media: MediaInfo, settings: OutputSettings, kind: 'audio' | 'subtitle'): string {
  if (kind === 'audio') {
    return JSON.stringify(settings.audioTracks.filter((track) => track.enabled).map((track) => ({
      index: track.index,
      codec: track.codec,
      bitrateKbps: track.bitrateKbps ?? null,
      passthrough: track.passthrough,
      channels: track.channels ?? media.audioTracks.find((source) => source.index === track.index)?.channels ?? null,
    })));
  }
  return JSON.stringify(settings.subtitleTracks.filter((track) => track.enabled).map((track) => ({
    index: track.index,
    codec: track.codec,
    passthrough: track.passthrough,
    burnIn: track.burnIn,
  })));
}

export function getComparableRecords(records: CalibrationRecord[], criteria: CalibrationCriteria): CalibrationRecord[] {
  return records.filter((record) => {
    if (record.method !== criteria.method || record.container !== criteria.container || record.encoder !== criteria.encoder) return false;
    if (!Number.isFinite(record.sourceDurationSeconds) || record.sourceDurationSeconds <= 0) return false;
    if (Math.abs(record.sourceDurationSeconds - criteria.durationSeconds) > Math.max(60, criteria.durationSeconds * 0.15)) return false;

    const exactFields: Array<[keyof CalibrationRecord, string | number | undefined]> = [
      ['preset', criteria.preset],
      ['handbrakeVersion', criteria.handbrakeVersion],
      ['encoderVersion', criteria.encoderVersion],
      ['width', criteria.width],
      ['height', criteria.height],
      ['filters', criteria.filters],
      ['audioSignature', criteria.audioSignature],
      ['subtitleSignature', criteria.subtitleSignature],
    ];
    for (const [field, expected] of exactFields) {
      if (record[field] !== expected) return false;
    }

    if (criteria.qualityRf !== undefined) {
      if (record.qualityRf === undefined || Math.abs(record.qualityRf - criteria.qualityRf) > 1) return false;
    } else if (record.qualityRf !== undefined) {
      return false;
    }
    if (criteria.bitrateKbps !== undefined) {
      if (record.bitrateKbps === undefined || Math.abs(record.bitrateKbps - criteria.bitrateKbps) > Math.max(100, criteria.bitrateKbps * 0.05)) return false;
    } else if (record.bitrateKbps !== undefined) {
      return false;
    }
    return true;
  });
}

export function computeCalibrationFactor(records: CalibrationRecord[]): number | undefined {
  if (records.length < 3) return undefined;
  const ratios = records
    .map((record) => record.actualBytes / record.predictedBytes)
    .filter((ratio) => Number.isFinite(ratio) && ratio > 0)
    .sort((a, b) => a - b);
  if (ratios.length < 3) return undefined;
  const middle = Math.floor(ratios.length / 2);
  return ratios.length % 2 === 0 ? (ratios[middle - 1] + ratios[middle]) / 2 : ratios[middle];
}
