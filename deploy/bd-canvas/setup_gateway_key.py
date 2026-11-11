#!/usr/bin/env python3
"""把 VisionQA 平台生成通道接进画布：建一把画布 Key（内容就是平台服务令牌），
写一条 system_settings 指针，并给现有用户补一次模型授权。

在画布机器上执行（需要能读 /opt/visionqa/.env 的权限）：
    /opt/bdcanvas/.venv/bin/python setup_gateway_key.py
    ... --dry-run      只打印将要做什么，不写库

幂等：
- 同名 Key 已存在就复用，不重复建；
- 只给「一条授权都没有」的用户补授权，不动管理员手工收回过的用户。

令牌全程只在内存里用，不打印、不落盘。
"""
import argparse
import sqlite3
from pathlib import Path

import requests

KEY_NAME = "VisionQA 平台生成通道"
KEY_NOTES = "由 VisionQA 后台统一管理；画布出图 / 出视频走这条通道，池里换 Key 不用改画布。"
MODELS = (
    ("volcengine", "doubao-seedream-4.5", "generate"),
    ("volcengine", "doubao-seedream-5.0-pro", "generate"),
    ("volcengine", "doubao-seedream-5.0-flash", "generate"),
    ("volcengine", "seedance2.0", "generate"),
    ("volcengine", "seedance2.0fast", "generate"),
)


def read_gateway_token(env_path: Path) -> str:
    if not env_path.exists():
        raise SystemExit(f"读不到 {env_path}")
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("VQ_GATEWAY_TOKEN="):
            value = line.split("=", 1)[1].strip().strip('"').strip("'")
            if value:
                return value
    raise SystemExit(f"{env_path} 里没有 VQ_GATEWAY_TOKEN：先在 VisionQA 侧生成令牌")


def mask(token: str) -> str:
    return (token[:4] + "•" * 4 + token[-4:]) if len(token) > 10 else "•" * len(token)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--canvas-root", default="/opt/bdcanvas")
    parser.add_argument("--visionqa-env", default="/opt/visionqa/.env")
    parser.add_argument("--base-url", default="http://127.0.0.1:5313")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    root = Path(args.canvas_root).resolve()
    db_path = root / "enterprise_server" / "data" / "enterprise.db"
    if not db_path.exists():
        raise SystemExit(f"找不到画布数据库 {db_path}")

    token = read_gateway_token(Path(args.visionqa_env))

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    admin = conn.execute(
        "SELECT username, password_plaintext FROM enterprise_users WHERE is_system_admin = 1 ORDER BY id LIMIT 1"
    ).fetchone()
    if not admin or not admin["password_plaintext"]:
        raise SystemExit("画布没有可用的超管账号（需要 password_plaintext）")

    session = requests.Session()
    login = session.post(
        args.base_url + "/enterprise/api/admin/auth/login",
        json={"username": admin["username"], "password": admin["password_plaintext"]},
        timeout=20,
    )
    if login.status_code != 200:
        raise SystemExit(f"画布管理员登录失败：HTTP {login.status_code}")
    session.headers["Authorization"] = "Bearer " + login.json()["token"]

    existing = session.get(args.base_url + "/enterprise/api/admin/api-keys", timeout=20)
    if existing.status_code != 200:
        raise SystemExit(f"读取画布 Key 列表失败：HTTP {existing.status_code}")
    keys = existing.json().get("api_keys") or []
    match = next((item for item in keys if str(item.get("name") or "").strip() == KEY_NAME), None)

    if match:
        key_id = int(match["id"])
        print(f"复用已有 Key: #{key_id} {KEY_NAME}")
    else:
        if args.dry_run:
            print(f"[dry-run] 将新建 Key: {KEY_NAME}（令牌 {mask(token)}，provider=volcengine）")
            key_id = 0
        else:
            created = session.post(
                args.base_url + "/enterprise/api/admin/api-keys",
                json={"name": KEY_NAME, "provider": "volcengine", "key": token, "notes": KEY_NOTES},
                timeout=20,
            )
            if created.status_code != 201:
                raise SystemExit(f"建 Key 失败：HTTP {created.status_code} {created.text[:200]}")
            payload = created.json()["api_key"]
            key_id = int(payload["id"])
            print(f"新建 Key: #{key_id} {KEY_NAME}（预览 {payload.get('key_preview')}）")

    if args.dry_run:
        users = conn.execute("SELECT id FROM enterprise_users WHERE is_active = 1 ORDER BY id").fetchall()
        print(f"[dry-run] 将给 {len(users)} 个在用账号补授权，模型 {len(MODELS)} 个，指向 Key #{key_id or '新建的'} ")
        return 0

    with conn:
        conn.execute(
            """
            INSERT INTO system_settings (key, value, is_secret, updated_at)
            VALUES ('visionqa.gateway_key_id', ?, 0, datetime('now', '+8 hours'))
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
            """,
            (str(key_id),),
        )
        users = conn.execute("SELECT id FROM enterprise_users WHERE is_active = 1 ORDER BY id").fetchall()
        granted_users = 0
        for row in users:
            user_id = int(row["id"])
            if conn.execute(
                "SELECT 1 FROM user_model_assignments WHERE user_id = ? LIMIT 1", (user_id,)
            ).fetchone():
                continue
            for provider, model, feature in MODELS:
                conn.execute(
                    """
                    INSERT INTO user_model_assignments
                        (user_id, provider, model, feature, api_key_id, is_enabled, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, 1, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
                    ON CONFLICT(user_id, provider, model, feature) DO NOTHING
                    """,
                    (user_id, provider, model, feature, key_id),
                )
            granted_users += 1
    print(f"写入 visionqa.gateway_key_id = {key_id}；本次补授权 {granted_users} 个账号 × {len(MODELS)} 个模型")
    total = conn.execute("SELECT count(*) FROM user_model_assignments").fetchone()[0]
    print(f"当前授权总数：{total}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
