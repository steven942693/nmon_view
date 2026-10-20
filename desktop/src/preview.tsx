import { createRoot } from "react-dom/client";
import App from "./App";
import { decodeReport } from "./bridge";
import "./styles.css";
// 此入口仅供开发环境验证；正式构建只包含 index.html。
if (import.meta.env.DEV) {
  fetch("/tests/preview-report.json").then((response) => response.json()).then((data) => {
    createRoot(document.getElementById("root")!).render(<App initialReport={decodeReport(data)} />);
  });
}
