import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseNmon } from "../../src/parser/nmonParser";
import { decodeReport } from "../src/bridge";

// 对照旧解析器全部输出，避免迁移只验证采样条数。
function comparable(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return Number(value.toPrecision(12));
  if (Array.isArray(value)) return value.map(comparable);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, comparable(v)]));
  return value;
}
const fixtures = {
  "模拟完整指标": readFileSync(resolve("tests/fixtures/synthetic.txt"), "utf8"),
  ...(existsSync(resolve("../localhost_260901_2100.nmon")) ? { "本地真实样本": readFileSync(resolve("../localhost_260901_2100.nmon"), "utf8") } : {}),
  "重复 Token 与缺失值": "AAA,interval,60\nAAA,snapshots,4\nCPU_ALL,CPU,User,Sys,Wait,Idle,Steal,Busy,CPUs\nDISKBUSY,Disk,sda\nNET,Net,eth0-read-KB/s,eth0-write-KB/s\nZZZZ,T0001,10:00:00,13-OCT-2026\nCPU_ALL,T0001,10,5,1,84,0,,32\nDISKBUSY,T0001,101\nNET,T0001,-1,-2\nZZZZ,T0002,10:03:00,13-OCT-2026\nZZZZ,T0002,10:01:00,13-OCT-2026",
  "缺少时间与 CSV 引号": 'AAA,host,"host,a"\nDISKBUSY,Disk,"disk,a"\nDISKBUSY,T0001,102',
  "跨日与阈值": "AAA,interval,60\nZZZZ,T0001,23:59:00,12-OCT-2026\nZZZZ,T0002,00:00:30,13-OCT-2026\nZZZZ,T0003,00:02:01,13-OCT-2026\nZZZZ,T0004,23:58:00,12-OCT-2026",
};
describe("Rust 与现有 TypeScript 解析器等价", () => {
  for (const [name, source] of Object.entries(fixtures)) it(name, () => {
    const result = spawnSync(resolve(process.env.CARGO_TARGET_DIR ?? "src-tauri/target", "debug", process.platform === "win32" ? "nmon-json.exe" : "nmon-json"), [], { input: source, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(comparable(decodeReport(JSON.parse(result.stdout)))).toEqual(comparable(parseNmon(source, "sample.nmon")));
  });
});
