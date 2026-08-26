import { Injectable } from '@angular/core';
import { BenchmarkRecord } from './benchmark.model';

const DB_NAME = 'barcode-benchmark';
const STORE = 'records';
const DB_VERSION = 1;

@Injectable({ providedIn: 'root' })
export class BenchmarkStorageService {
  private db: IDBDatabase | null = null;

  async open(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('sessionId', 'sessionId');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  }

  async addRecords(records: BenchmarkRecord[]): Promise<void> {
    if (!records.length) return;
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const r of records) store.put(r);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getAll(): Promise<BenchmarkRecord[]> {
    const db = await this.open();
    return new Promise<BenchmarkRecord[]>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result as BenchmarkRecord[]);
      req.onerror = () => reject(req.error);
    });
  }

  async clear(): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  exportJson(records: BenchmarkRecord[]): void {
    this.download(
      `barcode-benchmark-${Date.now()}.json`,
      JSON.stringify(records, null, 2),
      'application/json'
    );
  }

  exportCsv(records: BenchmarkRecord[]): void {
    const cols: (keyof BenchmarkRecord)[] = [
      'id', 'sessionId', 'engine', 'barcodeValue', 'expectedValue', 'format',
      'timestamp', 'frameNumber', 'detectionTimeMs', 'camera', 'resolution',
      'testType', 'testCondition', 'angle', 'distanceCm', 'classification', 'success',
    ];
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [cols.join(','), ...records.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
    this.download(`barcode-benchmark-${Date.now()}.csv`, csv, 'text/csv');
  }

  async importJson(file: File): Promise<number> {
    const text = await file.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('Invalid JSON file.');
    }
    if (!Array.isArray(parsed)) throw new Error('Expected an array of benchmark records.');
    // Basic shape validation; imported sessions get fresh ids to avoid collisions.
    const records = (parsed as BenchmarkRecord[]).filter(
      (r) => r && typeof r.engine === 'string' && typeof r.timestamp === 'number'
    );
    for (const r of records) r.id = crypto.randomUUID();
    await this.addRecords(records);
    return records.length;
  }

  downloadText(name: string, content: string): void {
    this.download(name, content, 'text/plain');
  }

  private download(name: string, content: string, mime: string): void {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }
}
