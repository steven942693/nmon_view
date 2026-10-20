import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Activity, ChartNoAxesCombined, Clock3, Cpu, FileChartColumn, FolderOpen,
  HardDrive, Layers, MemoryStick, Network, RotateCcw, Server, ShieldCheck,
  ShieldAlert, Upload, type LucideIcon,
} from "lucide-react";
import * as echarts from "echarts";
import sampleNmon from "../desktop/tests/fixtures/synthetic.txt?raw";
import { parseNmon } from "./parser/nmonParser";
import type { NamedSeries, ParsedNmon, QualityIssue, SystemPoint } from "./model/types";

type Tab = "overview" | "disk" | "network" | "filesystem" | "quality";

const tabs: Array<{ id: Tab; label: string; icon: LucideIcon }> = [
  { id: "overview", label: "总览", icon: ChartNoAxesCombined },
  { id: "disk", label: "磁盘", icon: HardDrive },
  { id: "network", label: "网络", icon: Network },
  { id: "filesystem", label: "文件系统", icon: FolderOpen },
  { id: "quality", label: "质量", icon: ShieldCheck },
];

const issueLabels: Record<QualityIssue["type"], string> = {
  "snapshot-count-mismatch": "采样数不一致",
  "time-gap": "采样缺口",
  "time-rollback": "时间回跳",
  "negative-rate": "负速率",
  "disk-busy-over-100": "磁盘 busy > 100%",
};

const severityLabels: Record<QualityIssue["severity"], string> = {
  info: "信息",
  warning: "警告",
  critical: "严重",
};

export default function App() {
  const [parsed, setParsed] = useState<ParsedNmon>(() =>
    parseNmon(sampleNmon, "模拟示例.nmon"),
  );
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [dragging, setDragging] = useState(false);

  const metrics = useMemo(() => summarize(parsed), [parsed]);
  const topIssues = useMemo(
    () =>
      [...parsed.qualityIssues].sort((left, right) => severityRank(right) - severityRank(left)),
    [parsed],
  );

  function loadFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      setParsed(parseNmon(String(reader.result ?? ""), file.name));
      setActiveTab("overview");
    };
    reader.readAsText(file);
  }

  return (
    <main
      className={`app ${dragging ? "is-dragging" : ""}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const file = event.dataTransfer.files[0];
        if (file) loadFile(file);
      }}
    >
      <header className="app-bar">
        <div className="shell app-bar-inner">
          <div className="brand"><Activity size={22} aria-hidden="true" /><span>nmon<span className="brand-light"> View</span></span></div>
          <span className="local-status"><ShieldCheck size={14} aria-hidden="true" />本地分析</span>
        </div>
      </header>

      <section className="report-header shell" aria-label="当前监控文件">
        <div className="report-heading">
          <div className="report-title">
            <p className="eyebrow"><FileChartColumn size={14} aria-hidden="true" />监控报告</p>
            <h1>{parsed.summary.fileName}</h1>
            <p className="summary-line"><Clock3 size={14} aria-hidden="true" /><span>{formatRange(parsed)}</span></p>
          </div>
        <label className="file-button">
          <input
            type="file"
            accept=".nmon,.txt,.csv"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) loadFile(file);
              event.currentTarget.value = "";
            }}
          />
          <Upload size={16} aria-hidden="true" />选择 nmon 文件
        </label>
        </div>
        <dl className="metadata">
          <div><dt><Server size={14} aria-hidden="true" />主机</dt><dd>{parsed.summary.host ?? "未知主机"}</dd></div>
          <div><dt><Cpu size={14} aria-hidden="true" />CPU</dt><dd>{parsed.summary.cpus ?? "-"}<small>核</small></dd></div>
          <div><dt><Clock3 size={14} aria-hidden="true" />采样间隔</dt><dd>{parsed.summary.intervalSeconds ?? "-"}<small>秒</small></dd></div>
          <div><dt><Layers size={14} aria-hidden="true" />实际 / 声明采样</dt><dd>{parsed.summary.actualSnapshots}<span className="meta-divider">/</span>{parsed.summary.declaredSnapshots ?? "-"}</dd></div>
        </dl>
      </section>

      <section className="meta-grid shell" aria-label="全时段峰值">
        <Metric label="CPU 使用峰值" value={formatNumber(metrics.maxCpuBusy)} unit="%" icon={Cpu} />
        <Metric label="CPU wait 峰值" value={formatNumber(metrics.maxCpuWait)} unit="%" icon={Clock3} />
        <Metric label="内存使用峰值" value={formatNumber(metrics.maxMemoryUsed)} unit="%" icon={MemoryStick} />
        <Metric label="磁盘 busy 峰值" value={formatNumber(metrics.maxDiskBusy)} unit="%" icon={HardDrive} />
      </section>

      <div className="navigation-band">
      <nav className="tabs shell" aria-label="分析视图" role="tablist">
        {tabs.map(({ id, label, icon: Icon }, index) => (
          <button
            key={id}
            id={`tab-${id}`}
            role="tab"
            aria-selected={activeTab === id}
            aria-controls="analysis-panel"
            tabIndex={activeTab === id ? 0 : -1}
            className={activeTab === id ? "active" : ""}
            onClick={() => setActiveTab(id)}
            onKeyDown={(event) => {
              const nextIndex = event.key === "ArrowRight" ? (index + 1) % tabs.length
                : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
                : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : undefined;
              if (nextIndex === undefined) return;
              event.preventDefault();
              setActiveTab(tabs[nextIndex].id);
              document.getElementById(`tab-${tabs[nextIndex].id}`)?.focus();
            }}
            type="button"
          >
            <Icon size={16} aria-hidden="true" /><span>{label}</span>
            {id === "quality" && <span className={`tab-count ${parsed.qualityIssues.length ? "has-issues" : ""}`}>{parsed.qualityIssues.length}</span>}
          </button>
        ))}
      </nav>
      </div>

      <div className="analysis-body shell" id="analysis-panel" role="tabpanel" aria-labelledby={`tab-${activeTab}`} tabIndex={0}>
      {activeTab === "overview" && <Overview parsed={parsed} topIssues={topIssues} />}
      {activeTab === "disk" && <DiskView parsed={parsed} />}
      {activeTab === "network" && <NetworkView parsed={parsed} />}
      {activeTab === "filesystem" && <FilesystemView parsed={parsed} />}
      {activeTab === "quality" && <QualityView issues={topIssues} />}
      </div>
      <footer className="report-footer shell"><span>nmon View</span><span>{parsed.summary.actualSnapshots} 个采样点<span className="footer-dot">·</span>{parsed.summary.host ?? "未知主机"}</span></footer>
    </main>
  );
}

function Overview({ parsed, topIssues }: { parsed: ParsedNmon; topIssues: QualityIssue[] }) {
  return (
    <section className="content-grid overview-grid">
      <Panel title="系统负载时间线">
        <LineChart
          height={330}
          series={[
            seriesFromSystem(parsed.systemSeries, "CPU busy", "cpuBusy"),
            seriesFromSystem(parsed.systemSeries, "CPU wait", "cpuWait"),
            seriesFromSystem(parsed.systemSeries, "磁盘 busy max", "diskBusyMax"),
            seriesFromSystem(parsed.systemSeries, "内存使用", "memoryUsedPercent"),
          ]}
          unit="%"
        />
      </Panel>
      <Panel title="吞吐时间线">
        <LineChart
          height={330}
          series={[
            seriesFromSystem(parsed.systemSeries, "磁盘读", "diskReadTotal"),
            seriesFromSystem(parsed.systemSeries, "磁盘写", "diskWriteTotal"),
            seriesFromSystem(parsed.systemSeries, "网络读", "networkReadTotal"),
            seriesFromSystem(parsed.systemSeries, "网络写", "networkWriteTotal"),
          ]}
          unit="KB/s"
        />
      </Panel>
      <Panel title="进程和等待">
        <LineChart
          height={260}
          series={[
            seriesFromSystem(parsed.systemSeries, "Runnable", "runnable"),
            seriesFromSystem(parsed.systemSeries, "Blocked", "blocked"),
            seriesFromSystem(parsed.systemSeries, "磁盘传输/s", "diskXferTotal"),
          ]}
        />
      </Panel>
      <Panel title="瓶颈时间点" detail={`数据质量提示 · ${topIssues.length} 项`}>
        <IssueList issues={topIssues.slice(0, 8)} />
      </Panel>
    </section>
  );
}

function DiskView({ parsed }: { parsed: ParsedNmon }) {
  const ranked = rankSeries(parsed.diskDevices, (point) => point.busy);
  return (
    <section className="content-grid detail-grid">
      <Panel title="磁盘 busy">
        <LineChart
          height={340}
          series={ranked.slice(0, 6).map((disk) => ({
            name: disk.name,
            data: disk.points.map((point) => tuplePoint(point.timestamp, point.busy)),
          }))}
          unit="%"
        />
      </Panel>
      <Panel title="磁盘读写">
        <LineChart
          height={340}
          series={[
            ...ranked.slice(0, 4).map((disk) => ({
              name: `${disk.name} read`,
              data: disk.points.map((point) => tuplePoint(point.timestamp, point.readKb)),
            })),
            ...ranked.slice(0, 4).map((disk) => ({
              name: `${disk.name} write`,
              data: disk.points.map((point) => tuplePoint(point.timestamp, point.writeKb)),
            })),
          ]}
          unit="KB/s"
        />
      </Panel>
      <Panel title="设备峰值排行" detail={`${ranked.length} 个设备`}>
        <RankTable
          rows={ranked.map((disk) => ({
            name: disk.name,
            max: maxValue(disk.points.map((point) => point.busy)),
            avg: avgValue(disk.points.map((point) => point.busy)),
            read: maxValue(disk.points.map((point) => point.readKb)),
            write: maxValue(disk.points.map((point) => point.writeKb)),
          }))}
          columns={["设备", "busy峰值", "busy均值", "读峰值", "写峰值"]}
          formats={{ max: "percent", avg: "percent", read: "throughput", write: "throughput" }}
        />
      </Panel>
    </section>
  );
}

function NetworkView({ parsed }: { parsed: ParsedNmon }) {
  const ranked = rankSeries(parsed.networkInterfaces, (point) =>
    sumDefined([point.readKb, point.writeKb]),
  );
  return (
    <section className="content-grid detail-grid">
      <Panel title="网卡吞吐">
        <LineChart
          height={360}
          series={ranked.slice(0, 8).flatMap((iface) => [
            {
              name: `${iface.name} read`,
              data: iface.points.map((point) => tuplePoint(point.timestamp, point.readKb)),
            },
            {
              name: `${iface.name} write`,
              data: iface.points.map((point) => tuplePoint(point.timestamp, point.writeKb)),
            },
          ])}
          unit="KB/s"
        />
      </Panel>
      <Panel title="网卡包速率">
        <LineChart
          height={360}
          series={ranked.slice(0, 6).flatMap((iface) => [
            {
              name: `${iface.name} read pkt`,
              data: iface.points.map((point) => tuplePoint(point.timestamp, point.readPackets)),
            },
            {
              name: `${iface.name} write pkt`,
              data: iface.points.map((point) => tuplePoint(point.timestamp, point.writePackets)),
            },
          ])}
          unit="/s"
        />
      </Panel>
      <Panel title="网卡峰值排行" detail={`${ranked.length} 个网卡`}>
        <RankTable
          rows={ranked.map((iface) => ({
            name: iface.name,
            max: maxValue(iface.points.map((point) => sumDefined([point.readKb, point.writeKb]))),
            avg: avgValue(iface.points.map((point) => sumDefined([point.readKb, point.writeKb]))),
            read: maxValue(iface.points.map((point) => point.readKb)),
            write: maxValue(iface.points.map((point) => point.writeKb)),
          }))}
          columns={["网卡", "吞吐峰值", "吞吐均值", "读峰值", "写峰值"]}
          formats={{ max: "throughput", avg: "throughput", read: "throughput", write: "throughput" }}
        />
      </Panel>
    </section>
  );
}

function FilesystemView({ parsed }: { parsed: ParsedNmon }) {
  const ranked = rankSeries(parsed.filesystems, (point) => point.usedPercent);
  return (
    <section className="content-grid detail-grid">
      <Panel title="文件系统使用率">
        <LineChart
          height={360}
          series={ranked.map((fs) => ({
            name: fs.name,
            data: fs.points.map((point) => tuplePoint(point.timestamp, point.usedPercent)),
          }))}
          unit="%"
        />
      </Panel>
      <Panel title="文件系统排行" detail={`${ranked.length} 个挂载点`}>
        <RankTable
          rows={ranked.map((fs) => ({
            name: fs.name,
            max: maxValue(fs.points.map((point) => point.usedPercent)),
            avg: avgValue(fs.points.map((point) => point.usedPercent)),
          }))}
          columns={["挂载点", "使用率峰值", "使用率均值"]}
          formats={{ max: "percent", avg: "percent" }}
        />
      </Panel>
    </section>
  );
}

function QualityView({ issues }: { issues: QualityIssue[] }) {
  return (
    <section className="content-grid">
      <Panel title="数据质量问题" detail={`${issues.length} 项`}>
        <div className="table-wrap" tabIndex={0} role="region" aria-label="数据质量问题表">
          <table>
            <thead>
              <tr>
                <th>级别</th>
                <th>类型</th>
                <th>Token</th>
                <th>发生时间</th>
                <th>段</th>
                <th>指标/设备</th>
                <th className="numeric">值</th>
                <th className="numeric">行号</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {!issues.length && <tr><td colSpan={9} className="empty">未发现质量问题。</td></tr>}
              {issues.map((issue, index) => (
                <tr key={`${issue.type}-${issue.token}-${issue.line}-${index}`}>
                  <td>
                    <span className={`severity ${issue.severity}`}>
                      {severityLabels[issue.severity]}
                    </span>
                  </td>
                  <td>{issueLabels[issue.type]}</td>
                  <td>{issue.token ?? "-"}</td>
                  <td className="occurrence-time">
                    {issue.occurrenceTime
                      ? <time dateTime={issue.occurrenceTime.replace(" ", "T")}>{issue.occurrenceTime}</time>
                      : "-"}
                  </td>
                  <td>{issue.section ?? "-"}</td>
                  <td>{issue.device ?? issue.metric ?? "-"}</td>
                  <td className="numeric">{issue.value ?? "-"}</td>
                  <td className="numeric">{issue.line ?? "-"}</td>
                  <td><IssueDetails issue={issue} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </section>
  );
}

function Panel({ title, detail, children }: { title: string; detail?: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <header className="panel-header">
        <h2>{title}</h2>
        {detail && <span className="panel-detail">{detail}</span>}
      </header>
      {children}
    </section>
  );
}

function Metric({
  label,
  value,
  unit,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  unit?: string;
  icon: LucideIcon;
}) {
  return (
    <div className="metric">
      <span className="metric-label">{label}<Icon size={16} aria-hidden="true" /></span>
      <strong>
        {value}
        {unit ? <small>{unit}</small> : null}
      </strong>
    </div>
  );
}

function LineChart({
  series,
  height,
  unit,
}: {
  series: Array<{ name: string; data: Array<[number, number | null]> }>;
  height: number;
  unit?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const resetId = useId();

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current);
    chartRef.current = chart;
    const compact = ref.current.clientWidth < 600;
    const devices = [...new Set(series.map((item) => item.name.replace(/ (read|write)( pkt)?$/, "")))];
    chart.setOption({
      animation: false,
      textStyle: { fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif', fontSize: 11 },
      tooltip: {
        trigger: "axis",
        confine: true,
        backgroundColor: "#ffffff",
        borderColor: "#e4e7e6",
        padding: [10, 14],
        textStyle: { color: "#333b39", fontSize: 12 },
        extraCssText: "max-height:240px;overflow:auto;box-shadow:0 4px 20px #182b2014;border-radius:6px;",
        axisPointer: { type: "line", lineStyle: { color: "#7b8984", type: "dashed" } },
        valueFormatter: (value: unknown) =>
          typeof value === "number" ? formatChartValue(value, unit) : "-",
      },
      legend: {
        type: "scroll",
        top: 10,
        left: 18,
        width: Math.max(100, ref.current.clientWidth - 110),
        icon: "roundRect",
        itemWidth: 12,
        itemHeight: 3,
        itemGap: 20,
        pageIconColor: "#0f766e",
        pageIconInactiveColor: "#c9d0cc",
        textStyle: { color: "#59645e", fontSize: 11, width: compact ? 98 : 160, overflow: "truncate" },
      },
      grid: { left: 18, right: 28, top: 60, bottom: 68, containLabel: true },
      xAxis: {
        type: "time",
        splitNumber: compact ? 3 : 8,
        axisLabel: {
          color: "#6b746f", hideOverlap: true, margin: 14, fontSize: 11,
          formatter: (value: number) => {
            const date = new Date(value);
            const pad = (part: number) => String(part).padStart(2, "0");
            return date.getHours() === 0 && date.getMinutes() === 0
              ? `${pad(date.getMonth() + 1)}/${pad(date.getDate())}`
              : `${pad(date.getHours())}:${pad(date.getMinutes())}`;
          },
        },
        axisTick: { show: false },
        axisLine: { lineStyle: { color: "#e1e6e3" } },
      },
      yAxis: {
        type: "value",
        axisLabel: {
          color: "#6b746f",
          margin: 12,
          formatter: (value: number) => formatChartValue(value, unit),
        },
        splitNumber: 4,
        splitLine: { lineStyle: { color: "#edf0ee", type: "dashed" } },
      },
      dataZoom: [
        { type: "inside", throttle: 50 },
        { type: "slider", height: 20, bottom: 14, left: 72, right: 28,
          borderColor: "#e3e8e5", backgroundColor: "#f6f8f7", fillerColor: "#0f766e12",
          dataBackground: { lineStyle: { color: "#b8c7c0" }, areaStyle: { color: "#dfe7e2" } },
          selectedDataBackground: { lineStyle: { color: "#52978b" }, areaStyle: { color: "#bcd6ce" } },
          handleStyle: { color: "#ffffff", borderColor: "#83aa9e" }, moveHandleSize: 0,
          textStyle: { color: "#59645e", fontSize: 10 }, showDetail: false },
      ],
      series: series.map((item) => ({
        name: item.name,
        type: "line",
        showSymbol: false,
        connectNulls: false,
        itemStyle: { color: chartColor(item.name, devices.indexOf(item.name.replace(/ (read|write)( pkt)?$/, ""))) },
        lineStyle: { width: 1.6, type: /write|写/.test(item.name) ? "dashed" : "solid" },
        emphasis: { focus: "series", lineStyle: { width: 2.4 } },
        data: item.data,
      })),
    });

    const observer = new ResizeObserver(() => {
      chart.resize();
      const narrow = (ref.current?.clientWidth ?? 0) < 600;
      chart.setOption({
        xAxis: { splitNumber: narrow ? 3 : 8 },
        legend: { width: Math.max(100, (ref.current?.clientWidth ?? 0) - 110), textStyle: { width: narrow ? 98 : 160 } },
      });
    });
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      chartRef.current = null;
      chart.dispose();
    };
  }, [series, unit]);

  return <div className="chart-shell">
    <div className="chart" ref={ref} style={{ height }} role="img" aria-label={`${series.map((item) => item.name).join("、")}时间线`} />
    <div className="chart-actions">
      <button type="button" className="icon-button" aria-label="重置时间范围" aria-describedby={resetId}
        onClick={() => chartRef.current?.dispatchAction({ type: "dataZoom", start: 0, end: 100 })}>
        <RotateCcw size={15} aria-hidden="true" />
      </button>
      <span className="tool-tip" role="tooltip" id={resetId}>重置时间范围</span>
    </div>
    {!series.some((item) => item.data.some(([, value]) => value !== null)) && <p className="chart-empty">暂无指标数据</p>}
  </div>;
}

function chartColor(name: string, deviceIndex: number): string {
  const fixed: Record<string, string> = {
    "CPU busy": "#168471", "CPU wait": "#b87c24", "磁盘 busy max": "#397ac2", "内存使用": "#8a63b3",
    "磁盘读": "#168471", "磁盘写": "#397ac2", "网络读": "#8a63b3", "网络写": "#b87c24",
    "Runnable": "#168471", "Blocked": "#b87c24", "磁盘传输/s": "#397ac2",
  };
  const palette = ["#168471", "#397ac2", "#b87c24", "#8a63b3", "#b25883", "#278a9b", "#777d29", "#637385"];
  return fixed[name] ?? palette[deviceIndex % palette.length];
}

function IssueDetails({ issue }: { issue: QualityIssue }) {
  const transition = issue.timeTransition;
  return (
    <div className="issue-details">
      <p>{issue.message}</p>
      {transition && (
        <div className="issue-time-block">
          <span className="issue-time-note">文件记录时间</span>
          <dl className="issue-time-transition">
            <div>
              <dt>{issue.type === "time-rollback" ? "回跳前" : "上一采样"}</dt>
              <dd><time dateTime={transition.previousTime.replace(" ", "T")}>{transition.previousTime}</time><span>{transition.previousToken}</span></dd>
            </div>
            <div>
              <dt>{issue.type === "time-rollback" ? "回跳后" : "下一采样"}</dt>
              <dd><time dateTime={transition.currentTime.replace(" ", "T")}>{transition.currentTime}</time><span>{issue.token}</span></dd>
            </div>
          </dl>
        </div>
      )}
    </div>
  );
}

function IssueList({ issues }: { issues: QualityIssue[] }) {
  if (!issues.length) return <p className="empty">未发现质量问题。</p>;
  return (
    <ul className="issue-list">
      {issues.map((issue, index) => (
        <li key={`${issue.type}-${issue.token}-${issue.line}-${index}`}>
          <span className={`severity ${issue.severity}`}><ShieldAlert size={12} aria-hidden="true" />{severityLabels[issue.severity]}</span>
          <div>
            <strong>{issueLabels[issue.type]}</strong>
            <IssueDetails issue={issue} />
          </div>
          <span className="issue-location">{issue.token ?? "文件"}{issue.line ? ` · 行 ${issue.line}` : ""}</span>
        </li>
      ))}
    </ul>
  );
}

function RankTable({
  rows,
  columns,
  formats = {},
}: {
  rows: Array<Record<string, string | number | undefined>>;
  columns: string[];
  formats?: Record<string, "number" | "percent" | "throughput">;
}) {
  const keys = ["name", "max", "avg", "read", "write"];
  return (
    <div className="table-wrap" tabIndex={0} role="region" aria-label={columns[0] + "排行表"}>
      <table>
        <thead>
          <tr>
            {columns.map((column, index) => (
              <th key={column} className={index ? "numeric" : ""}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {!rows.length && <tr><td className="empty" colSpan={columns.length}>暂无数据。</td></tr>}
          {rows.map((row) => (
            <tr key={String(row.name)}>
              {keys.slice(0, columns.length).map((key) => (
                <td key={key} className={key === "name" ? "device-name" : "numeric"}>
                  {key === "name" ? row[key] : formatTableValue(row[key] as number, formats[key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function summarize(parsed: ParsedNmon) {
  return {
    maxCpuBusy: maxValue(parsed.systemSeries.map((point) => point.cpuBusy)),
    maxCpuWait: maxValue(parsed.systemSeries.map((point) => point.cpuWait)),
    maxDiskBusy: maxValue(parsed.systemSeries.map((point) => point.diskBusyMax)),
    maxMemoryUsed: maxValue(parsed.systemSeries.map((point) => point.memoryUsedPercent)),
  };
}

function seriesFromSystem(
  points: SystemPoint[],
  name: string,
  field: keyof SystemPoint,
): { name: string; data: Array<[number, number | null]> } {
  return {
    name,
    data: points.map((point) => {
      const value = point[field];
      return [point.timestamp.getTime(), typeof value === "number" ? value : null] as [
        number,
        number | null,
      ];
    }),
  };
}

function tuplePoint(timestamp: Date, value?: number): [number, number | null] {
  return [timestamp.getTime(), value ?? null];
}

function rankSeries<TPoint>(
  series: NamedSeries<TPoint>[],
  selector: (point: TPoint) => number | undefined,
) {
  return [...series].sort(
    (left, right) =>
      maxValue(right.points.map(selector)) - maxValue(left.points.map(selector)),
  );
}

function maxValue(values: Array<number | undefined>): number {
  const valid = values.filter((value) => value !== undefined && Number.isFinite(value)) as number[];
  return valid.length ? Math.max(...valid) : 0;
}

function avgValue(values: Array<number | undefined>): number {
  const valid = values.filter((value) => value !== undefined && Number.isFinite(value)) as number[];
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : 0;
}

function sumDefined(values: Array<number | undefined>): number | undefined {
  const valid = values.filter((value) => value !== undefined && Number.isFinite(value)) as number[];
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) : undefined;
}

function formatNumber(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "-";
  if (Math.abs(value) >= 1000) return value.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 1 });
}

function formatChartValue(value: number, unit?: string): string {
  if (unit === "KB/s") {
    return formatThroughput(value);
  }
  return `${formatNumber(value)}${unit ?? ""}`;
}

function formatTableValue(
  value: number | undefined,
  format: "number" | "percent" | "throughput" = "number",
): string {
  if (format === "throughput") return formatThroughput(value);
  if (format === "percent") return `${formatNumber(value)}%`;
  return formatNumber(value);
}

function formatThroughput(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "-";
  const abs = Math.abs(value);
  if (abs >= 1024 * 1024) return `${formatNumber(value / 1024 / 1024)}GB/s`;
  if (abs >= 1024) return `${formatNumber(value / 1024)}MB/s`;
  return `${formatNumber(value)}KB/s`;
}

function formatRange(parsed: ParsedNmon): string {
  const start = parsed.summary.startedAt;
  const end = parsed.summary.endedAt;
  if (!start || !end) return "未知时间";
  return `${formatDate(start)} - ${formatDate(end)}`;
}

function formatDate(date: Date): string {
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function severityRank(issue: QualityIssue): number {
  return issue.severity === "critical" ? 3 : issue.severity === "warning" ? 2 : 1;
}
