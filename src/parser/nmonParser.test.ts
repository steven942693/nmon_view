import { describe, expect, it } from "vitest";
const localSamples = import.meta.glob("../../localhost_260901_2100.nmon", { eager: true, query: "?raw", import: "default" });
const realSample = Object.values(localSamples)[0] as string | undefined;
import { parseNmon } from "./nmonParser";

const sample = [
  "AAA,progname,nmon",
  "AAA,host,localhost",
  "AAA,date,01-SEP-2026",
  "AAA,time,21:00.15",
  "AAA,interval,60",
  "AAA,snapshots,4",
  "AAA,cpus,32",
  "CPU_ALL,CPU Total localhost,User%,Sys%,Wait%,Idle%,Steal%,Busy,CPUs",
  "MEM,Memory MB localhost,memtotal,hightotal,lowtotal,swaptotal,memfree,highfree,lowfree,swapfree,memshared,cached,active,bigfree,buffers,swapcached,inactive",
  "NET,Network I/O localhost,eth0-read-KB/s,eth1-read-KB/s,eth0-write-KB/s,eth1-write-KB/s",
  "DISKBUSY,Disk %Busy localhost,sda,dm-0",
  "DISKREAD,Disk Read KB/s localhost,sda,dm-0",
  "DISKWRITE,Disk Write KB/s localhost,sda,dm-0",
  "JFSFILE,JFS Filespace %Used localhost,/,/home",
  "ZZZZ,T0001,21:00:16,01-SEP-2026",
  "CPU_ALL,T0001,10,5,1,84,0,,32",
  "MEM,T0001,1000,-0.0,-0.0,200,100,-0.0,-0.0,50,-0.0,300,700,-1.0,20,0,200",
  "NET,T0001,2,4,8,16",
  "DISKBUSY,T0001,20,30",
  "DISKREAD,T0001,100,200",
  "DISKWRITE,T0001,50,75",
  "JFSFILE,T0001,60,70",
  "ZZZZ,T0002,21:01:16,01-SEP-2026",
  "CPU_ALL,T0002,20,5,2,73,0,,32",
  "MEM,T0002,1000,-0.0,-0.0,200,90,-0.0,-0.0,40,-0.0,310,710,-1.0,20,0,190",
  "NET,T0002,3,5,9,17",
  "DISKBUSY,T0002,101,40",
  "DISKREAD,T0002,110,210",
  "DISKWRITE,T0002,55,80",
  "JFSFILE,T0002,61,71",
  "ZZZZ,T0003,21:06:16,01-SEP-2026",
  "CPU_ALL,T0003,30,6,8,56,0,,32",
  "MEM,T0003,1000,-0.0,-0.0,200,10,-0.0,-0.0,0,-0.0,320,720,-1.0,20,0,180",
  "NET,T0003,-1,1,-2,2",
  "DISKBUSY,T0003,50,60",
  "DISKREAD,T0003,-5,220",
  "DISKWRITE,T0003,60,-8",
  "ZZZZ,T0004,21:03:16,01-SEP-2026",
  "CPU_ALL,T0004,15,3,1,81,0,,32",
  "MEM,T0004,1000,-0.0,-0.0,200,80,-0.0,-0.0,30,-0.0,330,730,-1.0,20,0,170",
].join("\n");

describe("parseNmon", () => {
  it("parses metadata, timestamps, and normalizes core system series", () => {
    const parsed = parseNmon(sample, "sample.nmon");

    expect(parsed.summary.fileName).toBe("sample.nmon");
    expect(parsed.summary.host).toBe("localhost");
    expect(parsed.summary.cpus).toBe(32);
    expect(parsed.summary.declaredSnapshots).toBe(4);
    expect(parsed.summary.actualSnapshots).toBe(4);
    expect(parsed.summary.startedAt?.toISOString()).toBe("2026-09-01T13:00:16.000Z");
    expect(parsed.summary.endedAt?.toISOString()).toBe("2026-09-01T13:06:16.000Z");

    expect(parsed.systemSeries).toHaveLength(4);
    expect(parsed.systemSeries[0]).toMatchObject({
      token: "T0001",
      cpuBusy: 15,
      cpuWait: 1,
      memoryUsedPercent: 90,
      swapUsedPercent: 75,
      diskBusyMax: 30,
      diskReadTotal: 300,
      diskWriteTotal: 125,
      networkReadTotal: 6,
      networkWriteTotal: 24,
      filesystemUsedMax: 70,
    });
  });

  it("reports sample gaps, time rollback, negative rates, and impossible disk busy", () => {
    const parsed = parseNmon(sample, "sample.nmon");
    const issueTypes = parsed.qualityIssues.map((issue) => issue.type);

    expect(issueTypes).toContain("time-gap");
    expect(issueTypes).toContain("time-rollback");
    expect(issueTypes).toContain("negative-rate");
    expect(issueTypes).toContain("disk-busy-over-100");
  });

  it("maps metric issue occurrence times to the matching token instead of sorted position", () => {
    const parsed = parseNmon(sample);
    const negativeRates = parsed.qualityIssues.filter((issue) => issue.type === "negative-rate");

    expect(negativeRates.length).toBeGreaterThan(0);
    for (const issue of negativeRates) {
      expect(issue).toMatchObject({ token: "T0003", occurrenceTime: "2026-09-01 21:06:16" });
    }
    expect(parsed.qualityIssues.find((issue) => issue.type === "disk-busy-over-100")).toMatchObject({
      token: "T0002",
      occurrenceTime: "2026-09-01 21:01:16",
    });
  });

  it("leaves file-level issue occurrence times empty", () => {
    const parsed = parseNmon("AAA,snapshots,2\nZZZZ,T0001,10:00:00,13-OCT-2026");
    const issue = parsed.qualityIssues.find((item) => item.type === "snapshot-count-mismatch");

    expect(issue).toBeDefined();
    expect(issue?.occurrenceTime).toBeUndefined();
  });

  it("keeps each transition occurrence time when a token appears more than once", () => {
    const parsed = parseNmon([
      "AAA,interval,60",
      "ZZZZ,T0001,10:00:00,13-OCT-2026",
      "ZZZZ,T0002,10:03:00,13-OCT-2026",
      "ZZZZ,T0002,10:01:00,13-OCT-2026",
    ].join("\n"));

    expect(parsed.qualityIssues.find((issue) => issue.type === "time-gap")).toMatchObject({
      token: "T0002", occurrenceTime: "2026-10-13 10:03:00",
    });
    expect(parsed.qualityIssues.find((issue) => issue.type === "time-rollback")).toMatchObject({
      token: "T0002", occurrenceTime: "2026-10-13 10:01:00",
    });
  });

  it("keeps device series for disk, network, and filesystem drilldown", () => {
    const parsed = parseNmon(sample, "sample.nmon");

    expect(parsed.diskDevices.map((device) => device.name)).toEqual(["sda", "dm-0"]);
    expect(parsed.networkInterfaces.map((iface) => iface.name)).toEqual(["eth0", "eth1"]);
    expect(parsed.filesystems.map((fs) => fs.name)).toEqual(["/", "/home"]);
    expect(parsed.diskDevices[0].points[1]).toMatchObject({
      token: "T0002",
      busy: 101,
      readKb: 110,
      writeKb: 55,
    });
  });

  it.each([
    ["same day", "10:00:00,13-OCT-2026", "10:12:27,13-OCT-2026", "2026-10-13 10:00:00", "2026-10-13 10:12:27"],
    ["next day", "23:55:00,12-OCT-2026", "00:07:27,13-OCT-2026", "2026-10-12 23:55:00", "2026-10-13 00:07:27"],
  ])("preserves gap source times across %s", (_case, before, after, previousTime, currentTime) => {
    const parsed = parseNmon([
      "AAA,interval,60",
      `ZZZZ,T1335,${before}`,
      `ZZZZ,T1336,${after}`,
    ].join("\n"));
    const issue = parsed.qualityIssues.find((item) => item.type === "time-gap");

    expect(issue).toMatchObject({
      severity: "warning",
      token: "T1336",
      line: 3,
      value: 747,
      occurrenceTime: currentTime,
      timeTransition: { previousToken: "T1335", previousTime, currentTime },
    });
    expect(issue?.message).toContain("747 秒（12 分 27 秒）");
  });

  it("does not invent source times for a row with no timestamp", () => {
    const parsed = parseNmon([
      "AAA,interval,60",
      "CPU_ALL,CPU Total,User%,Sys%,Wait%,Idle%,Steal%,Busy,CPUs",
      "CPU_ALL,T1336,10,5,1,84,0,,32",
    ].join("\n"));
    const issue = parsed.qualityIssues.find((item) => item.type === "time-gap");

    expect(issue?.message).toContain("没有对应 ZZZZ 时间戳");
    expect(issue?.timeTransition).toBeUndefined();
    expect(issue?.occurrenceTime).toBeUndefined();
  });

  it("keeps the existing gap threshold at more than 1.5 sampling intervals", () => {
    const parsed = parseNmon([
      "AAA,interval,60",
      "ZZZZ,T0001,10:00:00,13-OCT-2026",
      "ZZZZ,T0002,10:01:30,13-OCT-2026",
      "ZZZZ,T0003,10:03:01,13-OCT-2026",
    ].join("\n"));
    const gaps = parsed.qualityIssues.filter((item) => item.type === "time-gap");

    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ token: "T0003", value: 91 });
  });

  it.each([
    ["same day", "00:40:00,20-SEP-2026", "00:10:59,20-SEP-2026", "2026-09-20 00:40:00", "2026-09-20 00:10:59"],
    ["previous day", "00:10:00,20-SEP-2026", "23:40:59,19-SEP-2026", "2026-09-20 00:10:00", "2026-09-19 23:40:59"],
  ])("preserves rollback source times across %s", (_case, before, after, previousTime, currentTime) => {
    const parsed = parseNmon([
      "AAA,interval,60",
      `ZZZZ,T0431,${before}`,
      `ZZZZ,T0432,${after}`,
    ].join("\n"));
    const issue = parsed.qualityIssues.find((item) => item.type === "time-rollback");

    expect(issue).toMatchObject({
      token: "T0432",
      line: 3,
      value: -1741,
      occurrenceTime: currentTime,
      timeTransition: { previousToken: "T0431", previousTime, currentTime },
    });
    expect(issue?.message).toContain("1741 秒（29 分 1 秒）");
    // Chart sorting must not reverse the original file-order transition.
    expect(parsed.systemSeries.map((point) => point.token)).toEqual(["T0432", "T0431"]);
  });

  it("preserves rollback source times even when the browser timezone has a DST gap", () => {
    const parsed = parseNmon([
      "ZZZZ,T0001,02:30:00,08-MAR-2026",
      "ZZZZ,T0002,01:59:00,08-MAR-2026",
    ].join("\n"));
    expect(parsed.qualityIssues.find((issue) => issue.type === "time-rollback")).toMatchObject({
      timeTransition: {
        previousToken: "T0001",
        previousTime: "2026-03-08 02:30:00",
        currentTime: "2026-03-08 01:59:00",
      },
    });
  });

  it.skipIf(realSample === undefined)("parses the bundled localhost sample and exposes its known data-quality boundaries", () => {
    const parsed = parseNmon(realSample!, "localhost_260901_2100.nmon");
    const issueTypes = new Set(parsed.qualityIssues.map((issue) => issue.type));

    expect(parsed.summary.host).toBe("localhost");
    expect(parsed.summary.cpus).toBe(32);
    expect(parsed.summary.declaredSnapshots).toBe(1400);
    expect(parsed.summary.actualSnapshots).toBe(707);
    expect(parsed.diskDevices.length).toBe(8);
    expect(parsed.networkInterfaces.length).toBe(16);
    expect(parsed.systemSeries.length).toBe(707);
    expect(issueTypes.has("snapshot-count-mismatch")).toBe(true);
    expect(issueTypes.has("time-gap")).toBe(true);
    expect(issueTypes.has("time-rollback")).toBe(true);
    expect(issueTypes.has("negative-rate")).toBe(true);
    expect(issueTypes.has("disk-busy-over-100")).toBe(true);
  });
});
