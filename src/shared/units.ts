export function bytesToGiB(bytes: number): number {
  return bytes / (1024 ** 3);
}

export function bytesToGB(bytes: number): number {
  return bytes / (1000 ** 3);
}

export function formatSize(bytes: number): { giB: string; gB: string; bytes: string } {
  const giB = bytesToGiB(bytes);
  const gB = bytesToGB(bytes);
  return {
    giB: `${giB.toFixed(giB >= 1 ? 2 : 3)} GiB`,
    gB: `${gB.toFixed(gB >= 1 ? 2 : 3)} GB`,
    bytes: `${bytes.toLocaleString()} bytes`
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function safeDivide(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function bitrateToBytesPerSecond(kbps: number): number {
  return (kbps * 1000) / 8;
}
