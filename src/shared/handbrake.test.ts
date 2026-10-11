import { describe, expect, it } from 'vitest';
import { parseHandBrakeScan } from './handbrake.js';

describe('HandBrake scan parsing', () => {
  it('extracts duration, width, and container from a scan result', () => {
    const output = `
      + title 1: 00:42:12, 1920x1080, 23.976 fps, 6,000 kbps, 7 audio tracks, 2 subtitle tracks
      + Video: x264, 1920x1080, 23.976 fps, 6000 kbps
      + Audio: AAC Stereo, 192 kbps
      + Subtitle: SRT, text
    `;

    const media = parseHandBrakeScan(output);
    expect(media.durationSeconds).toBeGreaterThan(0);
    expect(media.width).toBe(1920);
    expect(media.height).toBe(1080);
    expect(media.container).toBe('unknown');
  });

  it('handles empty or malformed scan output', () => {
    const media = parseHandBrakeScan('');
    expect(media.durationSeconds).toBeUndefined();
    expect(media.videoTracks).toEqual([]);
  });
});
