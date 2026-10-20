use nmon_core::parse_nmon;

#[test]
fn preserves_metrics_and_source_transitions() {
    let text = "AAA,interval,60\nAAA,snapshots,4\nCPU_ALL,CPU,User,Sys,Wait,Idle,Steal,Busy,CPUs\nDISKBUSY,Disk,sda\nNET,Net,eth0-read-KB/s,eth0-write-KB/s\nZZZZ,T0001,10:00:00,13-OCT-2026\nCPU_ALL,T0001,10,5,1,84,0,,32\nDISKBUSY,T0001,101\nNET,T0001,-1,-2\nZZZZ,T0002,10:03:00,13-OCT-2026\nZZZZ,T0002,10:01:00,13-OCT-2026";
    let p = parse_nmon(text, "sample.nmon").unwrap();
    assert_eq!(p["summary"]["actualSnapshots"], 3);
    assert_eq!(p["systemSeries"][0]["cpuBusy"], 15.0);
    assert_eq!(p["systemSeries"].as_array().unwrap().len(), 2);
    let issues = p["qualityIssues"].as_array().unwrap();
    assert!(issues
        .iter()
        .any(|i| i["type"] == "time-gap" && i["occurrenceTime"] == "2026-10-13 10:03:00"));
    assert!(issues
        .iter()
        .any(|i| i["type"] == "time-rollback" && i["occurrenceTime"] == "2026-10-13 10:01:00"));
    assert_eq!(
        issues
            .iter()
            .filter(|i| i["type"] == "negative-rate")
            .count(),
        1
    );
    assert!(issues.iter().any(|i| i["type"] == "disk-busy-over-100"));
}

#[test]
fn rejects_non_nmon_and_preserves_unknown_time() {
    assert!(parse_nmon("hello", "bad.txt").is_err());
    let p = parse_nmon("CPU_ALL,CPU,User,Sys\nCPU_ALL,T0001,10,5", "missing.nmon").unwrap();
    assert!(p["qualityIssues"][0]["occurrenceTime"].is_null());
}

#[test]
fn synthetic_sample_counts() {
    let p = parse_nmon(include_str!("../../tests/fixtures/synthetic.txt"), "sample.nmon").unwrap();
    assert_eq!(p["summary"]["actualSnapshots"], 3);
    assert_eq!(p["diskDevices"].as_array().unwrap().len(), 2);
    assert_eq!(p["networkInterfaces"].as_array().unwrap().len(), 2);
    assert_eq!(p["filesystems"].as_array().unwrap().len(), 2);
}

#[test]
#[ignore = "仅在本机具备真实样本时运行，不上传监控数据"]
fn local_real_sample_counts() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../localhost_260901_2100.nmon");
    let text = std::fs::read_to_string(path).unwrap();
    let p = parse_nmon(&text, "sample.nmon").unwrap();
    assert_eq!(p["summary"]["actualSnapshots"], 707);
    assert_eq!(p["diskDevices"].as_array().unwrap().len(), 8);
    assert_eq!(p["networkInterfaces"].as_array().unwrap().len(), 16);
}

#[test]
fn reads_unicode_path_and_rejects_non_files() {
    let folder = std::env::temp_dir().join(format!("nmon-桌面测试-{}", std::process::id()));
    std::fs::create_dir_all(&folder).unwrap();
    let path = folder.join("中文监控.nmon");
    std::fs::write(&path, "ZZZZ,T0001,10:00:00,13-OCT-2026").unwrap();
    let report = nmon_core::load_file(&path).unwrap();
    assert_eq!(report["summary"]["fileName"], "中文监控.nmon");
    assert_eq!(report["summary"]["actualSnapshots"], 1);
    assert!(nmon_core::load_file(&folder).is_err());
    std::fs::write(&path, [0xff, 0xfe, 0x00]).unwrap();
    assert!(nmon_core::load_file(&path).is_err());
    std::fs::remove_file(path).unwrap();
    std::fs::remove_dir(folder).unwrap();
}
