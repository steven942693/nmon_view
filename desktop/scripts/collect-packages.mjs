import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';

const [target, platform] = process.argv.slice(2);
const expected = {
  windows: ['.msi', '-setup.exe'],
  linux: ['.deb', '.rpm', '.AppImage'],
  macos: ['.dmg'],
}[platform];
if (!target || !/^[a-z0-9_-]+$/.test(target) || !expected) {
  throw new Error('需要有效的 Rust target 和平台名称');
}
const release = resolve('src-tauri', 'target', target, 'release');
const output = resolve('releases', target);
await mkdir(output, { recursive: true });
async function filesIn(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      // macOS 应用目录已包含在 DMG 中，不另行复制中间产物。
      if (!entry.name.endsWith('.app')) files.push(...await filesIn(path));
    } else if (entry.isFile()) files.push(path);
  }
  return files;
}
const packages = (await filesIn(join(release, 'bundle')))
  .filter(path => expected.some(extension => path.endsWith(extension)));
for (const extension of expected) {
  if (!packages.some(path => path.endsWith(extension))) throw new Error(`缺少安装包：${extension}`);
}
if (platform === 'windows') packages.push(join(release, 'nmon-view-desktop.exe'));
const hashes = [];
for (const source of packages.sort()) {
  if ((await stat(source)).size === 0) throw new Error(`安装包为空：${source}`);
  const name = basename(source);
  await copyFile(source, join(output, name));
  const hash = createHash('sha256').update(await readFile(source)).digest('hex');
  hashes.push(`${hash}  ${name}`);
  console.log(`已收集：${name}`);
}
await writeFile(join(output, 'SHA256SUMS.txt'), `${hashes.join('\n')}\n`);
await writeFile(join(output, '构建信息.json'), JSON.stringify({
  target, platform, commit: process.env.GITHUB_SHA ?? 'local',
  run: process.env.GITHUB_RUN_ID ?? null,
  builtAt: new Date().toISOString(),
  signing: platform === 'macos' ? 'ad-hoc；未进行 Apple 公证' : '未配置发布者签名',
  validation: '编译与自动化解析测试通过；目标系统图形界面需另行验收',
}, null, 2) + '\n');
