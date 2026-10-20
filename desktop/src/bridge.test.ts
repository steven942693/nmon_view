import { describe, expect, it } from "vitest";
import { decodeReport } from "./bridge";
describe("桌面数据协议", () => {
  it("恢复日期和缺失值，保留源时间文本", () => {
    const result = decodeReport({ summary: { fileName: "a.nmon", actualSnapshots: 1, startedAt: "2026-10-13T10:00:00", endedAt: null }, sections: {}, systemSeries: [{ token: "T0001", timestamp: "2026-10-13T10:00:00", cpuBusy: null }], diskDevices: [], networkInterfaces: [], filesystems: [], qualityIssues: [{ occurrenceTime: "2026-10-13 10:00:00" }] });
    expect(result.summary.startedAt).toBeInstanceOf(Date);
    expect(result.systemSeries[0].timestamp.getHours()).toBe(10);
    expect(result.systemSeries[0].cpuBusy).toBeUndefined();
    expect(result.summary.endedAt).toBeUndefined();
    expect(result.qualityIssues[0].occurrenceTime).toBe("2026-10-13 10:00:00");
  });
});
