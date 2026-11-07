"""資料來源：FinMind 開放資料、證交所、Google 新聞 RSS。"""
import json
import os
import re
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta
from email.utils import parsedate_to_datetime

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
FINMIND = "https://api.finmindtrade.com/api/v4/data"


def http_get(url, params=None, retries=3, timeout=30):
    if params:
        url = url + "?" + urllib.parse.urlencode(params)
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode("utf-8", errors="replace")
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 * (i + 1))
    raise RuntimeError("下載失敗 %s: %s" % (url, last))


def finmind(dataset, data_id=None, start=None, end=None):
    params = {"dataset": dataset}
    if data_id:
        params["data_id"] = data_id
    if start:
        params["start_date"] = start
    if end:
        params["end_date"] = end
    token = os.environ.get("FINMIND_TOKEN")
    if token:
        params["token"] = token
    d = json.loads(http_get(FINMIND, params))
    if d.get("status") != 200:
        raise RuntimeError("FinMind %s: %s" % (dataset, d.get("msg")))
    return d.get("data", [])


def _num(s):
    s = str(s).replace(",", "").strip()
    try:
        return float(s)
    except ValueError:
        return None


def roc_to_iso(s):
    """115/11/06 或 115年11月06日 -> 2026-11-06"""
    m = re.match(r"(\d{2,3})\D+(\d{1,2})\D+(\d{1,2})", s)
    if not m:
        return None
    y, mo, d = int(m.group(1)) + 1911, int(m.group(2)), int(m.group(3))
    return "%04d-%02d-%02d" % (y, mo, d)


# ---------- 股價 ----------

def twse_month(code, ym):
    """證交所個股月成交資訊（上市股票，作為 FinMind 尚未更新當日資料時的補充）。"""
    try:
        d = json.loads(http_get("https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY",
                                {"date": ym + "01", "stockNo": code, "response": "json"}))
    except Exception:  # noqa: BLE001
        return []
    if d.get("stat") != "OK":
        return []
    rows = []
    for r in d.get("data", []):
        o, h, l, c = _num(r[3]), _num(r[4]), _num(r[5]), _num(r[6])
        if None in (o, h, l, c):
            continue
        rows.append({"date": roc_to_iso(r[0]), "open": o, "high": h, "low": l, "close": c,
                     "volume": int(_num(r[1]) or 0) // 1000})
    return rows


def prices(code, days=420):
    start = (date.today() - timedelta(days=days)).isoformat()
    rows = []
    for x in finmind("TaiwanStockPrice", code, start):
        if not x.get("close"):
            continue
        rows.append({"date": x["date"], "open": x["open"], "high": x["max"], "low": x["min"],
                     "close": x["close"], "volume": int(x["Trading_Volume"]) // 1000})  # 張
    have = {r["date"] for r in rows}
    for r in twse_month(code, date.today().strftime("%Y%m")):
        if r["date"] and r["date"] not in have and (not rows or r["date"] > rows[-1]["date"]):
            rows.append(r)
    rows.sort(key=lambda r: r["date"])
    return rows


# ---------- 基本面 ----------

def statements(code):
    start = (date.today() - timedelta(days=365 * 3 + 120)).isoformat()
    by_q = {}
    for x in finmind("TaiwanStockFinancialStatements", code, start):
        by_q.setdefault(x["date"], {})[x["type"]] = x["value"]
    return [dict(q=k, **v) for k, v in sorted(by_q.items())]


def month_revenue(code):
    start = (date.today() - timedelta(days=800)).isoformat()
    out = []
    for x in finmind("TaiwanStockMonthRevenue", code, start):
        out.append({"ym": "%d-%02d" % (x["revenue_year"], x["revenue_month"]), "revenue": x["revenue"]})
    out.sort(key=lambda r: r["ym"])
    return out


def per_history(code, years=3):
    start = (date.today() - timedelta(days=365 * years)).isoformat()
    return finmind("TaiwanStockPER", code, start)


def dividends(code):
    start = (date.today() - timedelta(days=500)).isoformat()
    return finmind("TaiwanStockDividend", code, start)


def stock_name(code):
    try:
        for x in finmind("TaiwanStockInfo", code):
            if x.get("stock_id") == code:
                return x.get("stock_name")
    except Exception:  # noqa: BLE001
        pass
    return code


def twse_ex_rights():
    """證交所除權息預告表。"""
    try:
        d = json.loads(http_get("https://www.twse.com.tw/rwd/zh/exRight/TWT48U", {"response": "json"}))
    except Exception:  # noqa: BLE001
        return []
    out = []
    for r in d.get("data", []):
        cash = _num(re.sub(r"<[^>]+>", "", r[7]))
        out.append({"date": roc_to_iso(r[0]), "code": r[1].strip(), "kind": r[3].strip(),
                    "stock_ratio": _num(r[4]), "cash": cash})
    return out


# ---------- 新聞 ----------

def google_news(query, days=7):
    q = "%s when:%dd" % (query, days)
    url = "https://news.google.com/rss/search?" + urllib.parse.urlencode(
        {"q": q, "hl": "zh-TW", "gl": "TW", "ceid": "TW:zh-Hant"})
    root = ET.fromstring(http_get(url))
    items = []
    for it in root.iter("item"):
        title = it.findtext("title") or ""
        source = (it.findtext("source") or "").strip()
        suffix = " - " + source
        if source and title.endswith(suffix):
            title = title[: -len(suffix)]
        try:
            ts = parsedate_to_datetime(it.findtext("pubDate")).timestamp()
        except Exception:  # noqa: BLE001
            ts = time.time()
        items.append({"title": title.strip(), "source": source, "url": it.findtext("link"),
                      "ts": int(ts)})
    return items


def now_tw():
    return datetime.utcnow() + timedelta(hours=8)
