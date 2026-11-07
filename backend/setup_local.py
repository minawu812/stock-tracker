"""初始設定：建立加密的持股檔與推播金鑰。

用法：
  python3 backend/setup_local.py            # 互動輸入密碼
  APP_PASSWORD=xxx python3 backend/setup_local.py
"""
import base64
import getpass
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from crypto_box import load_encrypted, save_encrypted  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SECRETS = os.path.join(ROOT, ".secrets")

DEFAULT = {
    "stocks": [
        {"code": "2337", "name": "旺宏", "cost": 121.7, "shares": 1000},
        {"code": "2330", "name": "台積電", "cost": 2118, "shares": 80},
        {"code": "2327", "name": "國巨", "cost": 963.37, "shares": 250},
    ],
    "settings": {"stop_pct": 8, "notify_days_before": 7},
}


def b64url(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def vapid_keys():
    path = os.path.join(SECRETS, "vapid.json")
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    k = ec.generate_private_key(ec.SECP256R1())
    priv = k.private_numbers().private_value.to_bytes(32, "big")
    pub = k.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    keys = {"private": b64url(priv), "public": b64url(pub)}
    os.makedirs(SECRETS, exist_ok=True)
    with open(path, "w") as f:
        json.dump(keys, f)
    os.chmod(path, 0o600)
    return keys


def main():
    pw = os.environ.get("APP_PASSWORD") or getpass.getpass("請設定 App 密碼（至少 8 碼）：")
    if len(pw) < 8:
        sys.exit("密碼至少 8 碼")
    path = os.path.join(ROOT, "config", "portfolio.enc")
    if os.path.exists(path):
        load_encrypted(path, pw)  # 驗證密碼
        print("已有持股檔，保留不變")
    else:
        save_encrypted(path, DEFAULT, pw)
        print("已建立 config/portfolio.enc")
    keys = vapid_keys()
    repo = os.environ.get("GITHUB_REPO", "")
    with open(os.path.join(ROOT, "docs", "config.js"), "w") as f:
        f.write("window.APP_CONFIG = %s;\n" % json.dumps(
            {"vapidPublicKey": keys["public"], "repo": repo, "branch": "main"}, indent=2))
    print("已寫入 docs/config.js（推播公鑰）")
    print("推播私鑰存在 .secrets/vapid.json（不會上傳），之後要設定到 GitHub Secrets：VAPID_PRIVATE_KEY")


if __name__ == "__main__":
    main()
