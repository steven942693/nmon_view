import type { ParsedNmon } from "./model/types";
export function decodeReport(value: unknown): ParsedNmon {
  // IPC 不传递 Date 实例；源时间文本保留原样，避免异常时间被时区改写。
  const revive = (input: unknown, key = ""): unknown => {
    if (input === null) return undefined;
    if (typeof input === "string" && ["timestamp", "startedAt", "endedAt"].includes(key)) return new Date(input);
    if (Array.isArray(input)) return input.map((item) => revive(item));
    if (input && typeof input === "object") return Object.fromEntries(Object.entries(input).map(([name, item]) => [name, revive(item, name)]));
    return input;
  };
  return revive(value) as ParsedNmon;
}

export const emptyReport: ParsedNmon = { summary: { fileName: "打开一份 nmon，开始分析", actualSnapshots: 0 }, sections: {}, systemSeries: [], diskDevices: [], networkInterfaces: [], filesystems: [], qualityIssues: [] };
