"""验证指定构建的四平台产物，全部上传后才公开 Release。"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.parse
import urllib.request


def main():
    repository = os.environ['GITHUB_REPOSITORY']
    tag = os.environ['RELEASE_TAG']
    run_id = os.environ['BUILD_RUN_ID']
    if not re.fullmatch(r'v\d+\.\d+\.\d+', tag) or not run_id.isdigit():
        raise ValueError('版本号或构建 ID 格式无效')
    api = f'https://api.github.com/repos/{repository}'
    headers = {'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
               'Accept': 'application/vnd.github+json', 'User-Agent': 'nmon-view-release'}

    def request(url, method='GET', body=None, binary=None):
        data = binary if binary is not None else (json.dumps(body).encode() if body is not None else None)
        content_type = 'application/octet-stream' if binary is not None else 'application/json'
        req = urllib.request.Request(url, data=data, method=method,
                                     headers={**headers, 'Content-Type': content_type})
        with urllib.request.urlopen(req, timeout=180) as response:
            return json.load(response)

    run = request(f'{api}/actions/runs/{run_id}')
    if run['path'] != '.github/workflows/desktop-build.yml' or run['head_repository']['full_name'] != repository:
        raise ValueError('产物来源不是本仓库的桌面打包流程')
    platforms = {'Windows-x64': 3, 'Linux-x64': 3, 'macOS-Apple-Silicon': 1, 'macOS-Intel': 1}
    jobs = request(f'{api}/actions/runs/{run_id}/jobs?per_page=100')['jobs']
    if any(not any(j['name'] == name and j['conclusion'] == 'success' for j in jobs) for name in platforms):
        raise ValueError('四个平台的构建任务必须全部成功')
    commit = run['head_sha']
    config = request(f'{api}/contents/desktop/src-tauri/tauri.conf.json?ref={commit}')
    version = json.loads(base64.b64decode(config['content']))['version']
    if tag != f'v{version}':
        raise ValueError('标签与实际构建版本不一致')

    # 标签必须精确指向产物源码；没有标签时交由 Release API 创建。
    try:
        request(f'{api}/git/ref/tags/{tag}')
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
    else:
        existing_tag = request(f'{api}/commits/{tag}')
        if existing_tag['sha'] != commit:
            raise ValueError('已有版本标签指向其他提交，拒绝移动标签')

    files = {}
    for platform, count in platforms.items():
        folder = Path(sys.argv[1]) / f'nmon-view-{platform}'
        metadata = json.loads((folder / '构建信息.json').read_text(encoding='utf-8'))
        if metadata['commit'] != commit or str(metadata['run']) != run_id:
            raise ValueError(f'{platform} 的构建来源不匹配')
        lines = (folder / 'SHA256SUMS.txt').read_text(encoding='utf-8').splitlines()
        if len(lines) != count:
            raise ValueError(f'{platform} 安装包数量不匹配')
        for line in lines:
            expected, name = line.split('  ', 1)
            if Path(name).name != name or '/' in name or '\\' in name:
                raise ValueError('安装包文件名包含路径')
            data = (folder / name).read_bytes()
            if not data or hashlib.sha256(data).hexdigest() != expected:
                raise ValueError(f'{name} 的 SHA256 校验失败')
            # 使用不含空格的名称，避免 GitHub 自动重命名导致校验文件失效。
            name = name.replace(' ', '-')
            if name in files:
                raise ValueError('安装包文件名重复')
            files[name] = data
    checksum = ''.join(f'{hashlib.sha256(data).hexdigest()}  {name}\n' for name, data in sorted(files.items()))
    files['SHA256SUMS.txt'] = checksum.encode()
    print(f'已验证 {len(files) - 1} 个安装包，源码 {commit}', flush=True)
    if '--check' in sys.argv:
        return

    releases = request(f'{api}/releases?per_page=100')
    release = next((r for r in releases if r['tag_name'] == tag), None)
    body = (f'源码提交：`{commit}`\n\n[构建记录]({run["html_url"]})\n\n'
            '- Windows x64：安装 EXE、MSI、便携 EXE（需要 WebView2）。\n'
            '- Linux x64：AppImage、DEB、RPM；需满足 WebKitGTK 4.1 等运行依赖。\n'
            '- macOS：Apple Silicon 与 Intel 两版 DMG，最低 macOS 12.0。\n\n'
            '附件包含 SHA256 校验文件。Windows 未配置发布者签名；macOS 仅 ad-hoc 签名，'
            '未做 Apple 开发者签名和公证，首次打开可能被系统拦截。\n\n'
            '构建与自动化解析测试通过；Mac、Linux 的实际图形界面仍需目标机器验收。')
    if release is None:
        release = request(f'{api}/releases', 'POST', {'tag_name': tag, 'target_commitish': commit,
                          'name': f'nmon View {tag}', 'body': body, 'draft': True, 'prerelease': False})
    assets = {a['name']: a for a in request(f'{api}/releases/{release["id"]}/assets?per_page=100')}
    if set(assets) - set(files):
        raise ValueError('现有 Release 包含额外附件，拒绝修改')
    for name, data in files.items():
        if name in assets:
            asset = assets[name]
        else:
            if not release['draft']:
                raise ValueError('已公开的 Release 缺少附件，拒绝直接修改')
            upload = release['upload_url'].split('{')[0] + '?' + urllib.parse.urlencode({'name': name})
            asset = request(upload, 'POST', binary=data)
        if asset['size'] != len(data) or asset.get('digest') != 'sha256:' + hashlib.sha256(data).hexdigest():
            raise ValueError(f'{name} 的远端校验失败，保留草稿供检查')
        print(f'远端校验通过：{name}', flush=True)
    if release['draft']:
        release = request(f'{api}/releases/{release["id"]}', 'PATCH', {'draft': False})
    print(release['html_url'], flush=True)


if __name__ == '__main__':
    main()
