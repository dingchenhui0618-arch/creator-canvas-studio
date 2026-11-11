#!/usr/bin/env python3
"""给 VisionQA 统一登录进来的画布用户，默认授权平台出图 / 出视频模型。

为什么需要：画布的生成接口要求「用户 → 模型 → Key」三元组都在 user_model_assignments 里，
VisionQA 影子用户是登录时自动建的，如果没人给他授权，一进画布点生成就是
「enterprise model is not authorized」。

规则：
- 只在用户一条授权都没有时补一次（首次进入），不覆盖管理员之后单独收回的模型；
- 授权绑定在「平台生成通道」那把 Key 上，Key id 存在 system_settings 的
  visionqa.gateway_key_id，由 setup_gateway_key.py 写入；
- 没配 Key 时什么都不做，画布维持原来的「未授权」提示。

脚本幂等，可重复执行。
"""
import argparse
import sys
from pathlib import Path

ANCHOR_DEF = "def _is_public_web_registration() -> bool:"
ANCHOR_CALL = """                (display_name, user_id),
            )
        conn.commit()"""

HELPER = '''VISIONQA_GATEWAY_MODELS = (
    ("volcengine", "doubao-seedream-4.5", "generate"),
    ("volcengine", "doubao-seedream-5.0-pro", "generate"),
    ("volcengine", "doubao-seedream-5.0-flash", "generate"),
    ("volcengine", "seedance2.0", "generate"),
    ("volcengine", "seedance2.0fast", "generate"),
)


def _grant_visionqa_gateway_models(conn, user_id: int) -> int:
    """VisionQA 用户首次进画布时，默认拿到平台出图 / 出视频模型授权。

    绑定的是「平台生成通道」那把 Key（system_settings: visionqa.gateway_key_id）。
    只在用户没有任何授权时执行：管理员之后单独收回某个模型，不会被下次登录覆盖。
    """
    if conn.execute(
        "SELECT 1 FROM user_model_assignments WHERE user_id = ? LIMIT 1", (user_id,)
    ).fetchone():
        return 0
    row = conn.execute(
        "SELECT value FROM system_settings WHERE key = 'visionqa.gateway_key_id'"
    ).fetchone()
    try:
        key_id = int(str(row["value"]).strip()) if row and str(row["value"]).strip() else 0
    except (TypeError, ValueError):
        key_id = 0
    if not key_id:
        return 0
    if not conn.execute(
        "SELECT 1 FROM enterprise_api_keys WHERE id = ? AND is_active = 1", (key_id,)
    ).fetchone():
        return 0
    granted = 0
    for provider, model, feature in VISIONQA_GATEWAY_MODELS:
        conn.execute(
            """
            INSERT INTO user_model_assignments
                (user_id, provider, model, feature, api_key_id, is_enabled, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 1, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
            ON CONFLICT(user_id, provider, model, feature) DO NOTHING
            """,
            (user_id, provider, model, feature, key_id),
        )
        granted += 1
    return granted


'''

CALL = """        _grant_visionqa_gateway_models(conn, user_id)
"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".", help="画布安装目录（含 enterprise_server/）")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    path = Path(args.root).resolve() / "enterprise_server" / "auth.py"
    source = path.read_text(encoding="utf-8")
    if "VISIONQA_GATEWAY_MODELS" in source:
        print("auth.py: already")
        return 0
    if source.count(ANCHOR_DEF) != 1:
        raise SystemExit(f"{path}: 锚点（函数定义）出现 {source.count(ANCHOR_DEF)} 次，无法安全打补丁")
    if source.count(ANCHOR_CALL) != 1:
        raise SystemExit(f"{path}: 锚点（登录落库）出现 {source.count(ANCHOR_CALL)} 次，无法安全打补丁")
    source = source.replace(ANCHOR_DEF, HELPER + ANCHOR_DEF, 1)
    source = source.replace(ANCHOR_CALL, ANCHOR_CALL.replace("        conn.commit()", CALL + "        conn.commit()"), 1)
    if not args.dry_run:
        path.write_text(source, encoding="utf-8")
    print("auth.py: patched" + (" (dry-run)" if args.dry_run else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
