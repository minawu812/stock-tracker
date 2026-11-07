"""產生全台股代號 / 名稱清單（docs/stocklist.json），供 App 輸入代號時自動帶出名稱。"""
import json
import os
from datetime import date, timedelta

import sources as src

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PATH = os.path.join(ROOT, "docs", "stocklist.json")
MARKET = {"twse": "上市", "tpex": "上櫃"}


def build():
    rows = [r for r in src.finmind("TaiwanStockInfo") if str(r.get("date", ""))[:2] in ("19", "20")]
    latest = max(r["date"] for r in rows)
    cutoff = (date.fromisoformat(latest) - timedelta(days=30)).isoformat()
    best = {}
    for r in rows:
        if r.get("type") not in MARKET or r["date"] < cutoff:
            continue
        cur = best.get(r["stock_id"])
        # 同一檔可能屬於多個產業分類，優先保留較具體的（非「電子工業」）
        if not cur or (cur[3] == "電子工業" and r["industry_category"] != "電子工業"):
            best[r["stock_id"]] = [r["stock_id"], r["stock_name"].rstrip("*"), MARKET[r["type"]], r["industry_category"]]
    out = sorted(best.values(), key=lambda x: (len(x[0]), x[0]))
    with open(PATH, "w", encoding="utf-8") as f:
        json.dump({"updated": latest, "built": date.today().isoformat(), "stocks": out}, f, ensure_ascii=False, separators=(",", ":"))
    return len(out)


def refresh_if_old():
    """每天最多重建一次（依檔案內記錄的建立日期判斷）。"""
    try:
        if os.path.exists(PATH):
            with open(PATH, encoding="utf-8") as f:
                if json.load(f).get("built") == date.today().isoformat():
                    return
        print("[stocklist] 更新股票清單：%d 檔" % build())
    except Exception as e:  # noqa: BLE001
        print("[stocklist] 更新失敗：%s" % e)


if __name__ == "__main__":
    print(build())
