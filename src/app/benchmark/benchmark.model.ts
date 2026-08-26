export type TestType =
  | 'live'
  | 'angle'
  | 'distance'
  | 'perspective'
  | 'condition'
  | 'image';
export type ResultClassification = 'correct' | 'incorrect' | 'miss' | 'duplicate';

export interface BenchmarkRecord {
  id: string;
  sessionId: string;
  engine: string;
  barcodeValue: string | null;
  expectedValue: string | null;
  format: string;
  timestamp: number;
  frameNumber: number;
  detectionTimeMs: number | null;
  camera: string;
  resolution: string;
  testType: TestType;
  testCondition: string;
  angle?: number;
  distanceCm?: number;
  classification: ResultClassification;
  success: boolean;
}

export interface EngineStats {
  engine: string;
  totalFrames: number;
  detections: number;
  correct: number;
  incorrect: number;
  latenciesMs: number[];
}

export function newStats(engine: string): EngineStats {
  return { engine, totalFrames: 0, detections: 0, correct: 0, incorrect: 0, latenciesMs: [] };
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}
