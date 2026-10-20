use chrono::NaiveDateTime;
use serde_json::{json, Map, Value};
use std::collections::HashMap;

#[derive(Clone)]
struct Stamp {
    token: String,
    time: NaiveDateTime,
    source: String,
    line: usize,
}
struct Row {
    token: String,
    values: Vec<Option<f64>>,
    line: usize,
}
type Rows = Vec<(String, Vec<Row>)>;

fn number(s: &str) -> Option<f64> {
    if matches!(s, "" | "-1" | "-1.0") {
        return None;
    }
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return Some(0.0);
    }
    trimmed.parse::<f64>().ok().filter(|v| v.is_finite())
}
fn csv(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut value = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '"' {
            if quoted && chars.peek() == Some(&'"') {
                value.push('"');
                chars.next();
            } else {
                quoted = !quoted;
            }
        } else if ch == ',' && !quoted {
            fields.push(std::mem::take(&mut value));
        } else {
            value.push(ch);
        }
    }
    fields.push(value);
    fields
}
fn token(s: &str) -> bool {
    s.len() == 5 && s.starts_with('T') && s[1..].bytes().all(|v| v.is_ascii_digit())
}
fn sum(values: impl Iterator<Item = f64>) -> Option<f64> {
    let mut it = values.peekable();
    it.peek()?;
    Some(it.sum())
}
fn percent(total: Option<f64>, free: Option<f64>) -> Option<f64> {
    let t = total?;
    if t <= 0.0 {
        None
    } else {
        Some((t - free?) / t * 100.0)
    }
}
fn duration(seconds: i64) -> String {
    if seconds >= 60 {
        format!("（{} 分 {} 秒）", seconds / 60, seconds % 60)
    } else {
        String::new()
    }
}
fn columns<'a>(sections: &'a Map<String, Value>, section: &str) -> Vec<&'a str> {
    sections
        .get(section)
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

pub fn parse_nmon(text: &str, name: &str) -> Result<Value, String> {
    let mut meta: HashMap<String, Vec<String>> = HashMap::new();
    let mut sections = Map::new();
    let mut rows: Rows = Vec::new();
    let mut row_sections = HashMap::new();
    let mut stamps: Vec<Stamp> = Vec::new();
    let mut unique: Vec<Stamp> = Vec::new();
    let mut stamp_index = HashMap::new();
    let mut cells = 0usize;
    // 同时兼容 LF、CRLF 和旧式 CR；保留原始行号。
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    for (index, line) in normalized
        .trim_start_matches('\u{feff}')
        .split('\n')
        .enumerate()
    {
        if line.trim().is_empty() {
            continue;
        }
        let f = csv(line);
        if f.len() < 2 || f[0].is_empty() {
            continue;
        }
        let section = &f[0];
        let key = &f[1];
        if section == "AAA" {
            meta.insert(key.clone(), f[2..].to_vec());
            continue;
        }
        if section == "ZZZZ" {
            if f.len() >= 4 && !key.is_empty() {
                if let Ok(time) = NaiveDateTime::parse_from_str(
                    &format!("{} {}", f[3], f[2]),
                    "%d-%b-%Y %H:%M:%S",
                ) {
                    let stamp = Stamp {
                        token: key.clone(),
                        source: time.format("%Y-%m-%d %H:%M:%S").to_string(),
                        time,
                        line: index + 1,
                    };
                    if let Some(&i) = stamp_index.get(key) {
                        unique[i] = stamp.clone();
                    } else {
                        stamp_index.insert(key.clone(), unique.len());
                        unique.push(stamp.clone());
                    }
                    stamps.push(stamp);
                }
            }
            continue;
        }
        if !key.is_empty() && !token(key) {
            sections.insert(section.clone(), json!(f[2..]));
        } else if token(key) {
            cells += f.len() - 2;
            if cells > 2_000_000 {
                return Err("指标数量超过首版安全上限，请拆分 nmon 文件后重试。".into());
            }
            let i = *row_sections.entry(section.clone()).or_insert_with(|| {
                rows.push((section.clone(), Vec::new()));
                rows.len() - 1
            });
            rows[i].1.push(Row {
                token: key.clone(),
                values: f[2..].iter().map(|v| number(v)).collect(),
                line: index + 1,
            });
        }
    }
    if stamps.is_empty() && rows.is_empty() {
        return Err("未发现有效 nmon 采样，请检查文件格式及 UTF-8 编码。".into());
    }
    let get_meta = |key: &str| meta.get(key).and_then(|v| v.first()).map(String::as_str);
    let interval = get_meta("interval").and_then(number);
    let declared = get_meta("snapshots").and_then(number);
    let mut issues: Vec<Value> = Vec::new();
    for pair in stamps.windows(2) {
        if issues.len() >= 20_000 {
            return Err("异常记录超过 20000 条，请拆分文件后重试。".into());
        }
        let a = &pair[0];
        let b = &pair[1];
        let delta = (b.time - a.time).num_seconds();
        let kind = if delta <= 0 {
            "time-rollback"
        } else if interval.is_some_and(|v| v != 0.0 && delta as f64 > v * 1.5) {
            "time-gap"
        } else {
            continue;
        };
        let message = if delta <= 0 {
            format!(
                "{} 到 {} 时间回跳 {} 秒{}。",
                a.token,
                b.token,
                delta.abs(),
                duration(delta.abs())
            )
        } else {
            format!(
                "{} 到 {} 间隔 {} 秒{}，超过采样间隔 {} 秒。",
                a.token,
                b.token,
                delta,
                duration(delta),
                interval.unwrap()
            )
        };
        issues.push(json!({"type":kind,"severity":if delta <= 0 {"critical"} else {"warning"},"token":b.token,"line":b.line,"value":delta,"message":message,"occurrenceTime":b.source,"timeTransition":{"previousToken":a.token,"previousTime":a.source,"currentTime":b.source}}));
    }
    if declared.is_some_and(|v| v != stamps.len() as f64) {
        issues.push(json!({"type":"snapshot-count-mismatch","severity":"warning","value":stamps.len(),"message":format!("声明采样 {} 次，实际解析 {} 次。", declared.unwrap(), stamps.len())}));
    }
    let mut lookup: HashMap<(&str, &str), &Row> = HashMap::new();
    for (section, section_rows) in &rows {
        let cols = columns(&sections, section);
        for row in section_rows {
            lookup.insert((section, &row.token), row);
            let source = stamp_index
                .get(&row.token)
                .map(|&i| unique[i].source.as_str());
            for (i, value) in row.values.iter().enumerate() {
                if issues.len() >= 20_000 {
                    return Err("异常记录超过 20000 条，请拆分文件后重试。".into());
                }
                let Some(v) = value else {
                    continue;
                };
                let metric = cols.get(i).copied();
                if ["NET", "NETPACKET", "DISKREAD", "DISKWRITE", "DISKXFER"]
                    .contains(&section.as_str())
                    && *v < 0.0
                {
                    issues.push(json!({"type":"negative-rate","severity":"warning","token":row.token,"section":section,"metric":metric,"value":v,"line":row.line,"occurrenceTime":source,"message":format!("{} {} 在 {} 出现负速率 {}。", section, metric.map(str::to_owned).unwrap_or_else(|| (i+1).to_string()), row.token, v)}));
                }
                if section == "DISKBUSY" && *v > 100.0 {
                    issues.push(json!({"type":"disk-busy-over-100","severity":"warning","token":row.token,"section":section,"device":metric,"value":v,"line":row.line,"occurrenceTime":source,"message":format!("{} 在 {} busy={}%，超过 100%。", metric.unwrap_or("磁盘"), row.token, v)}));
                }
            }
            if source.is_none() {
                issues.push(json!({"type":"time-gap","severity":"warning","token":row.token,"section":section,"line":row.line,"message":format!("{} {} 没有对应 ZZZZ 时间戳。", section, row.token)}));
            }
        }
    }
    unique.sort_by_key(|s| s.time);
    let value = |section: &str, key: &str, i: usize| {
        lookup
            .get(&(section, key))
            .and_then(|r| r.values.get(i))
            .copied()
            .flatten()
    };
    let total = |section: &str, key: &str| {
        lookup
            .get(&(section, key))
            .and_then(|r| sum(r.values.iter().flatten().copied()))
    };
    let max = |section: &str, key: &str| {
        lookup
            .get(&(section, key))
            .and_then(|r| r.values.iter().flatten().copied().reduce(f64::max))
    };
    let net_cols = columns(&sections, "NET");
    let packets = columns(&sections, "NETPACKET");
    let network_total = |key: &str, suffix: &str| {
        sum(net_cols
            .iter()
            .enumerate()
            .filter(|(_, c)| c.ends_with(suffix))
            .filter_map(|(i, _)| value("NET", key, i)))
    };
    let point = |s: &Stamp| json!({"token":s.token,"timestamp":s.time.format("%Y-%m-%dT%H:%M:%S").to_string()});
    let system: Vec<Value> = unique
        .iter()
        .map(|s| {
            let k = s.token.as_str();
            let mut p = point(s);
            let fields = [
                ("cpuUser", value("CPU_ALL", k, 0)),
                ("cpuSys", value("CPU_ALL", k, 1)),
                ("cpuWait", value("CPU_ALL", k, 2)),
                (
                    "cpuBusy",
                    value("CPU_ALL", k, 5).or_else(|| {
                        sum([value("CPU_ALL", k, 0), value("CPU_ALL", k, 1)]
                            .into_iter()
                            .flatten())
                    }),
                ),
                ("memoryFreeMb", value("MEM", k, 4)),
                (
                    "memoryUsedPercent",
                    percent(value("MEM", k, 0), value("MEM", k, 4)),
                ),
                ("swapFreeMb", value("MEM", k, 7)),
                (
                    "swapUsedPercent",
                    percent(value("MEM", k, 3), value("MEM", k, 7)),
                ),
                ("runnable", value("PROC", k, 0)),
                ("blocked", value("PROC", k, 1)),
                ("diskBusyMax", max("DISKBUSY", k)),
                ("diskReadTotal", total("DISKREAD", k)),
                ("diskWriteTotal", total("DISKWRITE", k)),
                ("diskXferTotal", total("DISKXFER", k)),
                ("networkReadTotal", network_total(k, "-read-KB/s")),
                ("networkWriteTotal", network_total(k, "-write-KB/s")),
                ("filesystemUsedMax", max("JFSFILE", k)),
            ];
            p["line"] = json!(s.line);
            for (name, v) in fields {
                p[name] = json!(v);
            }
            p
        })
        .collect();
    let disk_section = ["DISKBUSY", "DISKREAD", "DISKWRITE"]
        .into_iter()
        .find(|s| sections.contains_key(*s))
        .unwrap_or("DISKBUSY");
    let disks = columns(&sections, disk_section);
    let fs = columns(&sections, "JFSFILE");
    let mut interfaces = Vec::new();
    for c in &net_cols {
        if let Some(n) = c
            .strip_suffix("-read-KB/s")
            .or_else(|| c.strip_suffix("-write-KB/s"))
        {
            if !interfaces.contains(&n) {
                interfaces.push(n);
            }
        }
    }
    if unique
        .len()
        .saturating_mul(disks.len() + fs.len() + interfaces.len() + 1)
        > 500_000
    {
        return Err("时间序列过多，请拆分文件后重试。".into());
    }
    let disk_series: Vec<Value> = disks.iter().enumerate().map(|(i,n)| json!({"name":n,"points":unique.iter().map(|s| {
        let mut p = point(s); for (field,sec) in [("busy","DISKBUSY"),("readKb","DISKREAD"),("writeKb","DISKWRITE"),("xfer","DISKXFER"),("blockSize","DISKBSIZE")] { p[field] = json!(value(sec,&s.token,i)); } p
    }).collect::<Vec<_>>()})).collect();
    let network_series: Vec<Value> = interfaces.iter().map(|n| json!({"name":n,"points":unique.iter().map(|s| {
        let mut p = point(s);
        for (field,sec,cols,suffix) in [("readKb","NET",&net_cols,"-read-KB/s"),("writeKb","NET",&net_cols,"-write-KB/s"),("readPackets","NETPACKET",&packets,"-read/s"),("writePackets","NETPACKET",&packets,"-write/s")] {
            p[field] = json!(cols.iter().position(|c| *c == format!("{n}{suffix}")).and_then(|i| value(sec,&s.token,i)));
        } p
    }).collect::<Vec<_>>()})).collect();
    let filesystems: Vec<Value> = fs.iter().enumerate().map(|(i,n)| json!({"name":n,"points":unique.iter().map(|s| { let mut p = point(s); p["usedPercent"] = json!(value("JFSFILE",&s.token,i)); p }).collect::<Vec<_>>()})).collect();
    Ok(
        json!({"summary":{"fileName":name,"host":get_meta("host"),"os":meta.get("OS").map(|v|v.join(",")),"nmonVersion":get_meta("version"),"cpus":get_meta("cpus").and_then(number),"intervalSeconds":interval,"declaredSnapshots":declared,"actualSnapshots":stamps.len(),"startedAt":unique.first().map(|s|s.time.format("%Y-%m-%dT%H:%M:%S").to_string()),"endedAt":unique.last().map(|s|s.time.format("%Y-%m-%dT%H:%M:%S").to_string())},"sections":sections,"systemSeries":system,"diskDevices":disk_series,"networkInterfaces":network_series,"filesystems":filesystems,"qualityIssues":issues}),
    )
}

pub fn load_file(path: &std::path::Path) -> Result<Value, String> {
    use std::io::Read;
    const LIMIT: u64 = 128 * 1024 * 1024;
    let file = std::fs::File::open(path).map_err(|e| format!("无法打开文件：{e}"))?;
    let meta = file
        .metadata()
        .map_err(|e| format!("无法读取文件信息：{e}"))?;
    if !meta.is_file() {
        return Err("请选择普通 nmon 文件。".into());
    }
    if meta.len() > LIMIT {
        return Err("文件超过 128 MB，请拆分后重试。".into());
    }
    let mut text = String::new();
    file.take(LIMIT + 1)
        .read_to_string(&mut text)
        .map_err(|e| format!("读取失败，请使用 UTF-8 文本：{e}"))?;
    if text.len() as u64 > LIMIT {
        return Err("文件超过 128 MB。".into());
    }
    let report = parse_nmon(
        &text,
        &path.file_name().unwrap_or_default().to_string_lossy(),
    )?;
    if serde_json::to_vec(&report)
        .map_err(|e| e.to_string())?
        .len()
        > 64 * 1024 * 1024
    {
        return Err("解析结果超过 64 MB，请拆分文件后重试。".into());
    }
    Ok(report)
}
