"""下载 boxes 上游的 static/（作品照片）和 locale/（翻译）到 boxes_assets/.

为什么需要：boxes 通过 git URL 安装进 .venv 时，上游仓库根目录的
static/ 不会被安装（只装 boxes 包本身），导致作品参考图全部丢失。
本脚本按 uv.lock 里锁定的 commit 下载上游源码包，只解出这两个目录。

用法：uv run python scripts/fetch_boxes_assets.py [--force]
只依赖标准库；已下载且 commit 未变化时直接跳过（离线可用）。
"""
from __future__ import annotations

import io
import os
import re
import shutil
import sys
import tarfile
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEST = os.path.join(ROOT, "boxes_assets")
MARKER = os.path.join(DEST, ".commit")
KINDS = ("static", "locale")


def locked_commit() -> str:
    """从 uv.lock 读取 boxes 锁定的 commit（保证与 .venv 里的 boxes 一致）."""
    with open(os.path.join(ROOT, "uv.lock"), encoding="utf-8") as f:
        text = f.read()
    m = re.search(r'github\.com/florianfesti/boxes\?rev=[^#"]+#([0-9a-f]{40})', text)
    if not m:
        sys.exit("[X] uv.lock 中找不到 boxes 的 git commit，请先运行 uv lock")
    return m.group(1)


def main() -> None:
    commit = locked_commit()
    force = "--force" in sys.argv
    if not force and os.path.isfile(MARKER):
        with open(MARKER, encoding="utf-8") as f:
            if f.read().strip() == commit and all(
                os.path.isdir(os.path.join(DEST, k)) for k in KINDS
            ):
                print(f"[*] boxes 资源已是最新（{commit[:8]}），跳过下载")
                return

    url = f"https://codeload.github.com/florianfesti/boxes/tar.gz/{commit}"
    print(f"[*] 下载 boxes 上游资源 {commit[:8]} ...")
    print(f"    {url}")
    try:
        with urllib.request.urlopen(url, timeout=120) as resp:
            data = resp.read()
    except Exception as exc:
        sys.exit(f"[X] 下载失败：{exc}\n    （需要能访问 GitHub；下载一次后可离线使用）")
    print(f"[*] 已下载 {len(data) / 1e6:.1f} MB，解压 static/ 和 locale/ ...")

    tmp = DEST + ".tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp)
    count = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        for member in tar.getmembers():
            parts = member.name.split("/", 1)  # 去掉顶层 boxes-<commit>/
            if len(parts) < 2 or parts[1].split("/", 1)[0] not in KINDS:
                continue
            if not (member.isfile() or member.isdir()):
                continue  # 跳过符号链接等
            rel = os.path.normpath(parts[1])
            if rel.startswith("..") or os.path.isabs(rel):
                continue  # 防路径穿越
            target = os.path.join(tmp, rel)
            if member.isdir():
                os.makedirs(target, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            src = tar.extractfile(member)
            if src is None:
                continue
            with src, open(target, "wb") as out:
                shutil.copyfileobj(src, out)
            count += 1

    with open(os.path.join(tmp, ".commit"), "w", encoding="utf-8") as f:
        f.write(commit + "\n")
    shutil.rmtree(DEST, ignore_errors=True)
    os.replace(tmp, DEST)
    print(f"[OK] 已写入 {count} 个文件到 boxes_assets/")


if __name__ == "__main__":
    main()
