export interface Snapshot {
  path: string;
  cleanup(): Promise<void>;
}
