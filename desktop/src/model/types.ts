export type QualityIssueType =
  | "snapshot-count-mismatch"
  | "time-gap"
  | "time-rollback"
  | "negative-rate"
  | "disk-busy-over-100";

export interface FileSummary {
  fileName: string;
  host?: string;
  os?: string;
  nmonVersion?: string;
  cpus?: number;
  intervalSeconds?: number;
  declaredSnapshots?: number;
  actualSnapshots: number;
  startedAt?: Date;
  endedAt?: Date;
}

export interface QualityIssue {
  type: QualityIssueType;
  severity: "info" | "warning" | "critical";
  token?: string;
  occurrenceTime?: string;
  section?: string;
  metric?: string;
  device?: string;
  value?: number;
  line?: number;
  message: string;
  timeTransition?: {
    previousToken: string;
    previousTime: string;
    currentTime: string;
  };
}

export interface SystemPoint {
  token: string;
  timestamp: Date;
  line?: number;
  cpuBusy?: number;
  cpuUser?: number;
  cpuSys?: number;
  cpuWait?: number;
  memoryUsedPercent?: number;
  memoryFreeMb?: number;
  swapUsedPercent?: number;
  swapFreeMb?: number;
  runnable?: number;
  blocked?: number;
  diskBusyMax?: number;
  diskReadTotal?: number;
  diskWriteTotal?: number;
  diskXferTotal?: number;
  networkReadTotal?: number;
  networkWriteTotal?: number;
  filesystemUsedMax?: number;
}

export interface DiskPoint {
  token: string;
  timestamp: Date;
  busy?: number;
  readKb?: number;
  writeKb?: number;
  xfer?: number;
  blockSize?: number;
}

export interface NetworkPoint {
  token: string;
  timestamp: Date;
  readKb?: number;
  writeKb?: number;
  readPackets?: number;
  writePackets?: number;
}

export interface FilesystemPoint {
  token: string;
  timestamp: Date;
  usedPercent?: number;
}

export interface NamedSeries<TPoint> {
  name: string;
  points: TPoint[];
}

export interface ParsedNmon {
  summary: FileSummary;
  sections: Record<string, string[]>;
  systemSeries: SystemPoint[];
  diskDevices: NamedSeries<DiskPoint>[];
  networkInterfaces: NamedSeries<NetworkPoint>[];
  filesystems: NamedSeries<FilesystemPoint>[];
  qualityIssues: QualityIssue[];
}
