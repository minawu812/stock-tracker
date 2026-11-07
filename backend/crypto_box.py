"""AES-256-GCM + PBKDF2 加解密，格式與前端 WebCrypto 相容。"""
import base64
import json
import os

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

ITERATIONS = 200_000


def _b64(b):
    return base64.b64encode(b).decode()


def _unb64(s):
    return base64.b64decode(s)


def _key(password, salt, iterations):
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=iterations)
    return kdf.derive(password.encode("utf-8"))


def encrypt_json(obj, password):
    salt = os.urandom(16)
    iv = os.urandom(12)
    data = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ct = AESGCM(_key(password, salt, ITERATIONS)).encrypt(iv, data, None)
    return {"v": 1, "iter": ITERATIONS, "salt": _b64(salt), "iv": _b64(iv), "ct": _b64(ct)}


def decrypt_json(box, password):
    key = _key(password, _unb64(box["salt"]), box.get("iter", ITERATIONS))
    data = AESGCM(key).decrypt(_unb64(box["iv"]), _unb64(box["ct"]), None)
    return json.loads(data.decode("utf-8"))


def load_encrypted(path, password, default=None):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        return decrypt_json(json.load(f), password)


def save_encrypted(path, obj, password):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(encrypt_json(obj, password), f)
