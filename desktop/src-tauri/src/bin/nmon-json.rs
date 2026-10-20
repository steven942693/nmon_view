use std::io::Read;
fn main() {
    let mut input = String::new();
    std::io::stdin()
        .read_to_string(&mut input)
        .expect("无法读取测试输入");
    match nmon_core::parse_nmon(&input, "sample.nmon") {
        Ok(report) => println!("{}", report),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
