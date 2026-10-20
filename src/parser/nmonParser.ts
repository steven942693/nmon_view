import type {
  DiskPoint,
  FilesystemPoint,
  NamedSeries,
  NetworkPoint,
  ParsedNmon,
  QualityIssue,
  SystemPoint,
} from "../model/types";

interface RawRow {
  section: string;
  token: string;
  values: Array<number | undefined>;
  line: number;
}

interface TimestampRow {
  token: string;
  timestamp: Date;
  sourceTime: string;
  line: number;
}

const RATE_SECTIONS = new Set([
  "NET",
  "NETPACKET",
  "DISKREAD",
  "DISKWRITE",
  "DISKXFER",
]);

export function parseNmon(content: string, fileName = "nmon-file.nmon"): ParsedNmon {
  const meta: Record<string, string[]> = {};
  const sections: Record<string, string[]> = {};
  const rowsBySection = new Map<string, RawRow[]>();
  const timestamps = new Map<string, TimestampRow>();
  const orderedTimestamps: TimestampRow[] = [];
  const qualityIssues: QualityIssue[] = [];

  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  lines.forEach((line, index) => {
    if (!line.trim()) return;
    const fields = parseCsvLine(line);
    const section = fields[0];
    const lineNumber = index + 1;
    if (!section) return;

    if (section === "AAA") {
      meta[fields[1]] = fields.slice(2);
      return;
    }

    if (section === "ZZZZ") {
      const token = fields[1];
      const timestamp = parseNmonTimestamp(fields[3], fields[2]);
      if (token && timestamp) {
        const row = { token, ...timestamp, line: lineNumber };
        timestamps.set(token, row);
        orderedTimestamps.push(row);
      }
      return;
    }

    if (fields[1] && !isToken(fields[1])) {
      sections[section] = fields.slice(2);
      return;
    }

    if (fields[1] && isToken(fields[1])) {
      const rows = rowsBySection.get(section) ?? [];
      rows.push({
        section,
        token: fields[1],
        values: fields.slice(2).map(toNumber),
        line: lineNumber,
      });
      rowsBySection.set(section, rows);
    }
  });

  detectTimestampIssues(orderedTimestamps, getInterval(meta), qualityIssues);

  const sortedTimestamps = Array.from(timestamps.values()).sort(
    (left, right) => left.timestamp.getTime() - right.timestamp.getTime(),
  );
  const systemSeries = buildSystemSeries(sortedTimestamps, rowsBySection, sections);
  const diskDevices = buildDiskDevices(sortedTimestamps, rowsBySection, sections);
  const networkInterfaces = buildNetworkInterfaces(sortedTimestamps, rowsBySection, sections);
  const filesystems = buildFilesystems(sortedTimestamps, rowsBySection, sections);

  detectSnapshotMismatch(meta, orderedTimestamps.length, qualityIssues);
  detectValueIssues(rowsBySection, sections, timestamps, qualityIssues);

  for (const issue of qualityIssues) {
    issue.occurrenceTime = issue.timeTransition?.currentTime
      ?? (issue.token ? timestamps.get(issue.token)?.sourceTime : undefined);
  }

  return {
    summary: {
      fileName,
      host: meta.host?.[0],
      os: meta.OS?.join(","),
      nmonVersion: meta.version?.[0],
      cpus: toNumber(meta.cpus?.[0]),
      intervalSeconds: getInterval(meta),
      declaredSnapshots: toNumber(meta.snapshots?.[0]),
      actualSnapshots: orderedTimestamps.length,
      startedAt: sortedTimestamps[0]?.timestamp,
      endedAt: sortedTimestamps[sortedTimestamps.length - 1]?.timestamp,
    },
    sections,
    systemSeries,
    diskDevices,
    networkInterfaces,
    filesystems,
    qualityIssues,
  };
}

function buildSystemSeries(
  timestamps: TimestampRow[],
  rowsBySection: Map<string, RawRow[]>,
  sections: Record<string, string[]>,
): SystemPoint[] {
  const lookup = makeLookup(rowsBySection);
  return timestamps.map((timestamp) => {
    const cpu = lookup("CPU_ALL", timestamp.token)?.values ?? [];
    const mem = lookup("MEM", timestamp.token)?.values ?? [];
    const proc = lookup("PROC", timestamp.token)?.values ?? [];

    const memTotal = mem[0];
    const swapTotal = mem[3];
    const memFree = mem[4];
    const swapFree = mem[7];
    const diskBusy = maxSectionValue("DISKBUSY", timestamp.token, lookup);
    const diskRead = sumSectionValue("DISKREAD", timestamp.token, lookup);
    const diskWrite = sumSectionValue("DISKWRITE", timestamp.token, lookup);
    const diskXfer = sumSectionValue("DISKXFER", timestamp.token, lookup);
    const netTotals = totalNetwork("NET", timestamp.token, lookup, sections);
    const fsMax = maxSectionValue("JFSFILE", timestamp.token, lookup);

    return {
      token: timestamp.token,
      timestamp: timestamp.timestamp,
      line: timestamp.line,
      cpuUser: cpu[0],
      cpuSys: cpu[1],
      cpuWait: cpu[2],
      cpuBusy: cpu[5] ?? sumNumbers([cpu[0], cpu[1]]),
      memoryFreeMb: memFree,
      memoryUsedPercent: percentUsed(memTotal, memFree),
      swapFreeMb: swapFree,
      swapUsedPercent: percentUsed(swapTotal, swapFree),
      runnable: proc[0],
      blocked: proc[1],
      diskBusyMax: diskBusy,
      diskReadTotal: diskRead,
      diskWriteTotal: diskWrite,
      diskXferTotal: diskXfer,
      networkReadTotal: netTotals.read,
      networkWriteTotal: netTotals.write,
      filesystemUsedMax: fsMax,
    };
  });
}

function buildDiskDevices(
  timestamps: TimestampRow[],
  rowsBySection: Map<string, RawRow[]>,
  sections: Record<string, string[]>,
): NamedSeries<DiskPoint>[] {
  const devices = sections.DISKBUSY ?? sections.DISKREAD ?? sections.DISKWRITE ?? [];
  const lookup = makeLookup(rowsBySection);

  return devices.map((name, index) => ({
    name,
    points: timestamps.map((timestamp) => ({
      token: timestamp.token,
      timestamp: timestamp.timestamp,
      busy: lookup("DISKBUSY", timestamp.token)?.values[index],
      readKb: lookup("DISKREAD", timestamp.token)?.values[index],
      writeKb: lookup("DISKWRITE", timestamp.token)?.values[index],
      xfer: lookup("DISKXFER", timestamp.token)?.values[index],
      blockSize: lookup("DISKBSIZE", timestamp.token)?.values[index],
    })),
  }));
}

function buildNetworkInterfaces(
  timestamps: TimestampRow[],
  rowsBySection: Map<string, RawRow[]>,
  sections: Record<string, string[]>,
): NamedSeries<NetworkPoint>[] {
  const netColumns = sections.NET ?? [];
  const names = getNetworkNames(netColumns);
  const lookup = makeLookup(rowsBySection);

  return names.map((name) => {
    const readIndex = netColumns.indexOf(`${name}-read-KB/s`);
    const writeIndex = netColumns.indexOf(`${name}-write-KB/s`);
    const packetColumns = sections.NETPACKET ?? [];
    const readPacketsIndex = packetColumns.indexOf(`${name}-read/s`);
    const writePacketsIndex = packetColumns.indexOf(`${name}-write/s`);

    return {
      name,
      points: timestamps.map((timestamp) => ({
        token: timestamp.token,
        timestamp: timestamp.timestamp,
        readKb: lookup("NET", timestamp.token)?.values[readIndex],
        writeKb: lookup("NET", timestamp.token)?.values[writeIndex],
        readPackets: lookup("NETPACKET", timestamp.token)?.values[readPacketsIndex],
        writePackets: lookup("NETPACKET", timestamp.token)?.values[writePacketsIndex],
      })),
    };
  });
}

function buildFilesystems(
  timestamps: TimestampRow[],
  rowsBySection: Map<string, RawRow[]>,
  sections: Record<string, string[]>,
): NamedSeries<FilesystemPoint>[] {
  const filesystems = sections.JFSFILE ?? [];
  const lookup = makeLookup(rowsBySection);

  return filesystems.map((name, index) => ({
    name,
    points: timestamps.map((timestamp) => ({
      token: timestamp.token,
      timestamp: timestamp.timestamp,
      usedPercent: lookup("JFSFILE", timestamp.token)?.values[index],
    })),
  }));
}

function detectSnapshotMismatch(
  meta: Record<string, string[]>,
  actualSnapshots: number,
  qualityIssues: QualityIssue[],
) {
  const declared = toNumber(meta.snapshots?.[0]);
  if (declared !== undefined && declared !== actualSnapshots) {
    qualityIssues.push({
      type: "snapshot-count-mismatch",
      severity: "warning",
      value: actualSnapshots,
      message: `声明采样 ${declared} 次，实际解析 ${actualSnapshots} 次。`,
    });
  }
}

function detectTimestampIssues(
  timestamps: TimestampRow[],
  intervalSeconds: number | undefined,
  qualityIssues: QualityIssue[],
) {
  for (let index = 1; index < timestamps.length; index += 1) {
    const previous = timestamps[index - 1];
    const current = timestamps[index];
    const deltaSeconds = (current.timestamp.getTime() - previous.timestamp.getTime()) / 1000;
    if (deltaSeconds <= 0) {
      const seconds = Math.abs(deltaSeconds);
      const duration = seconds >= 60 ? `（${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒）` : "";
      qualityIssues.push({
        type: "time-rollback",
        severity: "critical",
        token: current.token,
        line: current.line,
        value: deltaSeconds,
        message: `${previous.token} 到 ${current.token} 时间回跳 ${seconds} 秒${duration}。`,
        timeTransition: {
          previousToken: previous.token,
          previousTime: previous.sourceTime,
          currentTime: current.sourceTime,
        },
      });
    } else if (intervalSeconds && deltaSeconds > intervalSeconds * 1.5) {
      const duration = deltaSeconds >= 60 ? `（${Math.floor(deltaSeconds / 60)} 分 ${deltaSeconds % 60} 秒）` : "";
      qualityIssues.push({
        type: "time-gap",
        severity: "warning",
        token: current.token,
        line: current.line,
        value: deltaSeconds,
        message: `${previous.token} 到 ${current.token} 间隔 ${deltaSeconds} 秒${duration}，超过采样间隔 ${intervalSeconds} 秒。`,
        timeTransition: {
          previousToken: previous.token,
          previousTime: previous.sourceTime,
          currentTime: current.sourceTime,
        },
      });
    }
  }
}

function detectValueIssues(
  rowsBySection: Map<string, RawRow[]>,
  sections: Record<string, string[]>,
  timestamps: Map<string, TimestampRow>,
  qualityIssues: QualityIssue[],
) {
  rowsBySection.forEach((rows, section) => {
    rows.forEach((row) => {
      row.values.forEach((value, index) => {
        if (value === undefined) return;
        const metric = sections[section]?.[index];
        if (RATE_SECTIONS.has(section) && value < 0) {
          qualityIssues.push({
            type: "negative-rate",
            severity: "warning",
            token: row.token,
            section,
            metric,
            value,
            line: row.line,
            message: `${section} ${metric ?? index + 1} 在 ${row.token} 出现负速率 ${value}。`,
          });
        }
        if (section === "DISKBUSY" && value > 100) {
          qualityIssues.push({
            type: "disk-busy-over-100",
            severity: "warning",
            token: row.token,
            section,
            device: metric,
            value,
            line: row.line,
            message: `${metric ?? "磁盘"} 在 ${row.token} busy=${value}%，超过 100%。`,
          });
        }
      });
      if (!timestamps.has(row.token)) {
        qualityIssues.push({
          type: "time-gap",
          severity: "warning",
          token: row.token,
          section,
          line: row.line,
          message: `${section} ${row.token} 没有对应 ZZZZ 时间戳。`,
        });
      }
    });
  });
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      result.push(value);
      value = "";
    } else {
      value += char;
    }
  }

  result.push(value);
  return result;
}

function parseNmonTimestamp(
  dateValue?: string,
  timeValue?: string,
): Pick<TimestampRow, "timestamp" | "sourceTime"> | undefined {
  if (!dateValue || !timeValue) return undefined;
  const match = dateValue.match(/^(\d{2})-([A-Z]{3})-(\d{4})$/i);
  if (!match) return undefined;
  const months: Record<string, number> = {
    JAN: 0,
    FEB: 1,
    MAR: 2,
    APR: 3,
    MAY: 4,
    JUN: 5,
    JUL: 6,
    AUG: 7,
    SEP: 8,
    OCT: 9,
    NOV: 10,
    DEC: 11,
  };
  const day = Number(match[1]);
  const month = months[match[2].toUpperCase()];
  const year = Number(match[3]);
  const [hour = 0, minute = 0, second = 0] = timeValue.split(":").map(Number);
  if (month === undefined) return undefined;
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    timestamp: new Date(year, month, day, hour, minute, second),
    // Preserve file wall-clock values even if the browser timezone normalizes them.
    sourceTime: `${year}-${pad(month + 1)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`,
  };
}

function getInterval(meta: Record<string, string[]>): number | undefined {
  return toNumber(meta.interval?.[0]);
}

function makeLookup(rowsBySection: Map<string, RawRow[]>) {
  const indexed = new Map<string, Map<string, RawRow>>();
  rowsBySection.forEach((rows, section) => {
    indexed.set(section, new Map(rows.map((row) => [row.token, row])));
  });
  return (section: string, token: string) => indexed.get(section)?.get(token);
}

function sumSectionValue(
  section: string,
  token: string,
  lookup: (section: string, token: string) => RawRow | undefined,
): number | undefined {
  const values = lookup(section, token)?.values ?? [];
  return values.length ? sumNumbers(values) : undefined;
}

function maxSectionValue(
  section: string,
  token: string,
  lookup: (section: string, token: string) => RawRow | undefined,
): number | undefined {
  const values = (lookup(section, token)?.values ?? []).filter(
    (value) => value !== undefined,
  ) as number[];
  return values.length ? Math.max(...values) : undefined;
}

function totalNetwork(
  section: string,
  token: string,
  lookup: (section: string, token: string) => RawRow | undefined,
  sections: Record<string, string[]>,
): { read?: number; write?: number } {
  const columns = sections[section] ?? [];
  const values = lookup(section, token)?.values ?? [];
  let read = 0;
  let write = 0;
  let hasRead = false;
  let hasWrite = false;

  columns.forEach((column, index) => {
    const value = values[index];
    if (value === undefined) return;
    if (column.endsWith("-read-KB/s")) {
      read += value;
      hasRead = true;
    } else if (column.endsWith("-write-KB/s")) {
      write += value;
      hasWrite = true;
    }
  });

  return {
    read: hasRead ? read : undefined,
    write: hasWrite ? write : undefined,
  };
}

function getNetworkNames(columns: string[]): string[] {
  const names = new Set<string>();
  columns.forEach((column) => {
    const name = column.replace(/-(read|write)-KB\/s$/, "");
    if (name !== column) names.add(name);
  });
  return Array.from(names);
}

function percentUsed(total?: number, free?: number): number | undefined {
  if (!total || free === undefined || total <= 0) return undefined;
  return ((total - free) / total) * 100;
}

function sumNumbers(values: Array<number | undefined>): number | undefined {
  const valid = values.filter((value) => value !== undefined) as number[];
  if (!valid.length) return undefined;
  return valid.reduce((sum, value) => sum + value, 0);
}

function toNumber(value?: string): number | undefined {
  if (value === undefined || value === "" || value === "-1" || value === "-1.0") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isToken(value: string): boolean {
  return /^T\d{4}$/.test(value);
}
