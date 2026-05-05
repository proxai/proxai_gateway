export interface FileStat {
  exists: true;
  size: number;
  mtimeMs: number;
  mtimeNs: bigint;
  inode: bigint;
}

export interface MissingStat {
  exists: false;
}

export type StatResult = FileStat | MissingStat;

export interface SentinelHandle {
  exists(): Promise<boolean>;
  read(): Promise<string>;
  write(body: string): Promise<void>;
  remove(): Promise<void>;
}
