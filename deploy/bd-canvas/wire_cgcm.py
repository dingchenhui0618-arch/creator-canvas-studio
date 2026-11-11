#!/usr/bin/env python3
"""把画布的 CGCM / SeeAPI 渠道也接到 VisionQA 平台生成通道。

背景：画布原本把 `https://api.cgcm-api.com` 写死在代码里、密钥也用它自己的 Key 表。
平台池里已经放了 SeeAPI 的 Key，画布要能共用 —— 换 Key 时只改 VisionQA 后台，画布不动。

做三件事（幂等）：
1. 源码：CGCM 的 base 改读 `BD_CGCM_BASE_URL`（不设时行为完全不变）；
2. 密钥：画布 Key 表里建一把 provider=cgcm 的「VisionQA 平台生成通道（CGCM）」，
   值就是平台服务令牌（cgcm 组 Key 覆盖全部 cgcm 模型，不按单个模型绑）；
3. 授权：给已经有授权的账号补上 CGCM 那批模型。

在画布机器上执行（需要读 /opt/visionqa/.env 的权限）：
    /opt/bdcanvas/.venv/bin/python wire_cgcm.py
    ... --dry-run      只打印将要做什么

令牌只在内存里用，不打印、不落盘。
"""
import argparse
import os
import re
import sqlite3
import sys
from pathlib import Path

KEY_NAME = "VisionQA 平台生成通道（CGCM）"
KEY_NOTES = "由 VisionQA 后台统一管理：画布的 CGCM 出图 / 出视频走平台通道，池里换 Key 不用改画布。"
DEFAULT_CGCM = "https://api.cgcm-api.com"
ENV_KEY = "BD_CGCM_BASE_URL"

# 画布模型目录里的 CGCM 模型（provider, model）。provider 决定画布用哪条协议与参数集。
CGCM_MODELS = (
    ("cgcm-seedance", "cgcm-seedance-2-0"),
    ("cgcm-seedance", "cgcm-seedance-2-0-fast"),
    ("cgcm-seedance", "cgcm-seedance-2-0-mini"),
    ("cgcm-seedance", "cgcm-seedance-2-5"),
    ("cgcm-seedance", "cgcm-minimax-h3"),
    ("cgcm-seedance", "cgcm-wan-3-0"),
    ("cgcm-seedance", "cgcm-wan-3-0-prime"),
    ("cgcm-seedance", "cgcm-happy-horse-1-1"),
    ("cgcm-image2", "image-2-pro"),
    ("cgcm-image2", "image-2.5"),
    ("cgcm-nano-banana", "nano-banana-flash"),
    ("cgcm-nano-banana", "nano-banana-pro"),
    ("seeapi", "seeapi-seedream-5.0-pro"),
)

SOURCE_PATCHES = (
    (
        "enterprise_server/generation_seedance.py",
        'CGCM_SEEDANCE_BASE_URL = "' + DEFAULT_CGCM + '"',
        'CGCM_SEEDANCE_BASE_URL = (' + 'os.environ.get("' + ENV_KEY + '") or "' + DEFAULT_CGCM + '").rstrip("/")',
    ),
    (
        "enterprise_server/generation_image2.py",
        'CGCM_IMAGE2_BASE_URL = "' + DEFAULT_CGCM + '"',
        'CGCM_IMAGE2_BASE_URL = (' + 'os.environ.get("' + ENV_KEY + '") or "' + DEFAULT_CGCM + '").rstrip("/")',
    ),
)

DIAGNOSTICS = "enterprise_server/admin_diagnostics.py"
PROBE_CONST = '_CGCM_BASE = ((os.environ.get("' + ENV_KEY + '") or "' + DEFAULT_CGCM + '").rstrip("/")) + "/v1"'


def read_gateway_token(env_path: Path) -> str:
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("VQ_GATEWAY_TOKEN="):
            value = line.split("=", 1)[1].strip().strip('"').strip("'")
            if value:
                return value
    raise SystemExit(f"{env_path} 里没有 VQ_GATEWAY_TOKEN")


def patch_sources(root: Path, dry: bool) -> None:
    for rel, old, new in SOURCE_PATCHES:
        path = root / rel
        text = path.read_text(encoding="utf-8")
        if new in text:
            print(f"[skip] 已改过：{rel}")
            continue
        if old not in text:
            print(f"[warn] 没找到常量：{rel}（可能上游已改，跳过）")
            continue
        if dry:
            print(f"[dry-run] 改 {rel}：base 读 {ENV_KEY}")
            continue
        path.write_text(text.replace(old, new, 1), encoding="utf-8")
        print(f"[ok] 改 {rel}：base 读 {ENV_KEY}")

    path = root / DIAGNOSTICS
    text = path.read_text(encoding="utf-8")
    if PROBE_CONST in text:
        print(f"[skip] 已改过：{DIAGNOSTICS}")
        return
    if 'import os' not in text:
        text = text.replace("import json\n", "import json\nimport os\n", 1)
    text = text.replace('"base_url": "' + DEFAULT_CGCM + '/v1"', '"base_url": _CGCM_BASE')
    text = text.replace('"models_url": "' + DEFAULT_CGCM + '/v1/models"', '"models_url": _CGCM_BASE + "/models"')
    anchor = "CGCM_SEEDANCE_CONFIG = {"
    if anchor not in text:
        print(f"[warn] 没找到 {anchor}，诊断页探测地址保持原样")
        return
    text = text.replace(anchor, PROBE_CONST + "\n\n" + anchor, 1)
    if dry:
        print(f"[dry-run] 改 {DIAGNOSTICS}：诊断页探测地址也走平台通道")
        return
    path.write_text(text, encoding="utf-8")
    print(f"[ok] 改 {DIAGNOSTICS}：诊断页探测地址也走平台通道")


def ensure_key(conn, token: str, preview_fn, encrypt_fn, dry: bool) -> int:
    row = conn.execute(
        "SELECT id FROM enterprise_api_keys WHERE name = ? AND provider = 'cgcm'", (KEY_NAME,)
    ).fetchone()
    if row:
        print(f"[skip] 画布已有 CGCM 通道 Key：#{row[0]}")
        return int(row[0])
    if dry:
        print(f"[dry-run] 将新建画布 Key：{KEY_NAME}（provider=cgcm，值=平台服务令牌）")
        return 0
    cursor = conn.execute(
        """
        INSERT INTO enterprise_api_keys
            (name, provider, model, key_ciphertext, key_preview, is_active, created_by, created_at, updated_at, notes)
        VALUES (?, 'cgcm', NULL, ?, ?, 1, 1, datetime('now', '+8 hours'), datetime('now', '+8 hours'), ?)
        """,
        (KEY_NAME, encrypt_fn(token), preview_fn(token), KEY_NOTES),
    )
    key_id = int(cursor.lastrowid)
    print(f"[ok] 新建画布 Key：#{key_id} {KEY_NAME}（预览 {preview_fn(token)}）")
    return key_id


def grant_models(conn, key_id: int, dry: bool) -> int:
    users = [int(row[0]) for row in conn.execute("SELECT DISTINCT user_id FROM user_model_assignments")]
    if dry:
        print(f"[dry-run] 将给 {len(users)} 个账号补 {len(CGCM_MODELS)} 个 CGCM 模型授权（Key #{key_id or '新建的'}）")
        return 0
    added = 0
    for user_id in users:
        for provider, model in CGCM_MODELS:
            exists = conn.execute(
                "SELECT 1 FROM user_model_assignments WHERE user_id = ? AND provider = ? AND model = ? AND feature = 'generate'",
                (user_id, provider, model),
            ).fetchone()
            if exists:
                continue
            conn.execute(
                """
                INSERT INTO user_model_assignments
                    (user_id, provider, model, feature, api_key_id, is_enabled, created_at, updated_at)
                VALUES (?, ?, ?, 'generate', ?, 1, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
                """,
                (user_id, provider, model, key_id),
            )
            added += 1
    print(f"[ok] 补授权 {added} 条（{len(users)} 个账号）")
    return added


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--canvas-root", default="/opt/bdcanvas")
    parser.add_argument("--visionqa-env", default="/opt/visionqa/.env")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    root = Path(args.canvas_root).resolve()
    db_path = root / "enterprise_server" / "data" / "enterprise.db"
    token = read_gateway_token(Path(args.visionqa_env))
    sys.path.insert(0, str(root))
    os.chdir(root)
    from enterprise_server.keys import encrypt_key, key_preview  # noqa: E402  （要在 sys.path / cwd 就位之后）

    patch_sources(root, args.dry_run)

    conn = sqlite3.connect(db_path)
    try:
        key_id = ensure_key(conn, token, key_preview, encrypt_key, args.dry_run)
        with conn:
            grant_models(conn, key_id, args.dry_run)
    finally:
        conn.close()

    print("\n重启画布后端后才生效：systemctl restart bdc-enterprise")
    print("生效前记得把 " + ENV_KEY + "=平台通道地址写进它的环境变量。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
