#!/usr/bin/env python3
"""把 BD Canvas 企业版的出图 / 出视频地址指向 VisionQA 平台生成通道。

背景：画布原本把火山方舟的地址写死在代码里，平台 Key 池就用不上。这个脚本把地址
改成读环境变量，默认值仍是方舟官方地址，所以不改环境变量时行为完全不变。

用法（在画布安装目录执行，或用 --root 指定）：
    python wire_gateway.py --root /opt/bdcanvas
    python wire_gateway.py --root /opt/bdcanvas --dry-run

环境变量：
    BD_IMAGE_GATEWAY_ENDPOINT     出图地址（三款 Seedream 共用）
    BD_SEEDREAM45_ENDPOINT        仅 Seedream 4.5 覆盖
    BD_SEEDREAM50_PRO_ENDPOINT    仅 Seedream 5.0 Pro 覆盖
    BD_SEEDREAM50_FLASH_ENDPOINT  仅 Seedream 5.0 Flash 覆盖
    BD_SEEDANCE_BASE_URL          出视频 base（方舟协议：<base>/contents/generations/tasks）

脚本是幂等的：已经改过的文件会跳过。
"""
import argparse
import sys
from pathlib import Path

SEEDREAM_HELPER = '''def _gateway_endpoint(override_env: str) -> str:
    """出图地址：先看模型级环境变量，再看平台生成通道，最后回落到火山方舟官方地址。"""
    return (
        (os.environ.get(override_env) or "").strip()
        or (os.environ.get("BD_IMAGE_GATEWAY_ENDPOINT") or "").strip()
        or "https://ark.cn-beijing.volces.com/api/v3/images/generations"
    )


'''

ARK_IMAGE = "https://ark.cn-beijing.volces.com/api/v3/images/generations"
SEEDREAM_REPLACEMENTS = [
    (
        f'SEEDREAM45_MODEL = "doubao-seedream-4.5"',
        f'SEEDREAM45_MODEL = "doubao-seedream-4.5"',
    ),
    (
        f'SEEDREAM45_ENDPOINT = "{ARK_IMAGE}"',
        'SEEDREAM45_ENDPOINT = _gateway_endpoint("BD_SEEDREAM45_ENDPOINT")',
    ),
    (
        f'SEEDREAM50_PRO_ENDPOINT = "{ARK_IMAGE}"',
        'SEEDREAM50_PRO_ENDPOINT = _gateway_endpoint("BD_SEEDREAM50_PRO_ENDPOINT")',
    ),
    (
        f'SEEDREAM50_FLASH_ENDPOINT = "{ARK_IMAGE}"',
        'SEEDREAM50_FLASH_ENDPOINT = _gateway_endpoint("BD_SEEDREAM50_FLASH_ENDPOINT")',
    ),
]

SEEDANCE_OLD = 'SEEDANCE_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"'
SEEDANCE_NEW = '''SEEDANCE_BASE_URL = (
    (os.environ.get("BD_SEEDANCE_BASE_URL") or "").strip()
    or "https://ark.cn-beijing.volces.com/api/v3"
)'''


def patch_seedream(path: Path, dry_run: bool) -> str:
    source = path.read_text(encoding="utf-8")
    if "BD_IMAGE_GATEWAY_ENDPOINT" in source:
        return "already"
    anchor = 'SEEDREAM45_MODEL = "doubao-seedream-4.5"'
    if anchor not in source:
        raise SystemExit(f"{path}: 找不到锚点 {anchor}，画布版本可能变了")
    source = source.replace(anchor, SEEDREAM_HELPER + anchor, 1)
    for old, new in SEEDREAM_REPLACEMENTS:
        if old not in source:
            raise SystemExit(f"{path}: 找不到 {old}")
        source = source.replace(old, new, 1)
    if not dry_run:
        path.write_text(source, encoding="utf-8")
    return "patched"


def patch_seedance(path: Path, dry_run: bool) -> str:
    source = path.read_text(encoding="utf-8")
    if "BD_SEEDANCE_BASE_URL" in source:
        return "already"
    if SEEDANCE_OLD not in source:
        raise SystemExit(f"{path}: 找不到 {SEEDANCE_OLD}")
    source = source.replace(SEEDANCE_OLD, SEEDANCE_NEW, 1)
    if not dry_run:
        path.write_text(source, encoding="utf-8")
    return "patched"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".", help="画布安装目录（含 enterprise_server/）")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    targets = [
        (root / "enterprise_server" / "generation_seedream.py", patch_seedream),
        (root / "enterprise_server" / "generation_seedance.py", patch_seedance),
    ]
    for path, fn in targets:
        if not path.exists():
            raise SystemExit(f"找不到 {path}")
        print(f"{path.name}: {fn(path, args.dry_run)}")
    # 打印改完后的取值：环境变量是进程启动时读的，所以这里直接看当前进程的取值
    import os

    for name in (
        "BD_IMAGE_GATEWAY_ENDPOINT",
        "BD_SEEDREAM45_ENDPOINT",
        "BD_SEEDREAM50_PRO_ENDPOINT",
        "BD_SEEDREAM50_FLASH_ENDPOINT",
        "BD_SEEDANCE_BASE_URL",
    ):
        print(f"{name} = {os.environ.get(name) or '(未设置，回落到方舟官方地址)'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
