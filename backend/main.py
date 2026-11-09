"""每次執行：抓資料 → 分析 → 產生加密報告 → 推播新的提醒。

環境變數：
  APP_PASSWORD       解密持股設定 / 加密報告用的密碼（必填）
  VAPID_PRIVATE_KEY  Web Push 私鑰（選填，沒有就不推播）
  VAPID_SUBJECT      例如 mailto:you@example.com
  FINMIND_TOKEN      FinMind 金鑰（選填，可提高流量上限）
"""
import hashlib
import os
import sys
import time
import traceback
from datetime import date, datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import analysis  # noqa: E402
import chips  # noqa: E402
import events as ev  # noqa: E402
import fundamentals as fu  # noqa: E402
import news as nw  # noqa: E402
import notify  # noqa: E402
import sources as src  # noqa: E402
import stocklist  # noqa: E402
from crypto_box import load_encrypted, save_encrypted  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG = os.path.join(ROOT, "config")
PORTFOLIO = os.path.join(CONFIG, "portfolio.enc")
SUBS = os.path.join(CONFIG, "subscriptions.enc")
STATE = os.path.join(CONFIG, "state.enc")
REPORT = os.path.join(ROOT, "docs", "data", "report.enc")

NOTIFY_LEVELS = ("danger", "warn", "buy")
LEVEL_ICON = {"danger": "🔴", "warn": "🟠", "buy": "🟢", "info": "🔵"}
# 跟「成本」有關的訊號：多帳戶時要依各帳戶的成本分別計算
COST_KEYS = {"stoploss_pct", "profit_ma20", "profit_ma10", "profit_ma5", "near_stop"}
RANK = {"danger": 0, "warn": 1, "buy": 2, "info": 3}


def positions_of(portfolio):
    """回傳 {代號: [各帳戶持倉]}；舊格式（沒有 holdings）時每檔視為一個持倉。"""
    names = {a["id"]: a["name"] for a in portfolio.get("accounts", [])}
    out = {}
    src_list = portfolio.get("holdings")
    if src_list is None:
        src_list = portfolio.get("stocks", [])
    for h in src_list:
        if float(h.get("shares") or 0) > 0 and float(h.get("cost") or 0) > 0:
            out.setdefault(h["code"], []).append({
                "account": h.get("account"), "account_name": names.get(h.get("account"), ""),
                "cost": float(h["cost"]), "shares": float(h["shares"])})
    return out


def build_stock(st, twse_ex, settings, today, positions=None):
    code = st["code"]
    name = st.get("name") or src.stock_name(code)
    out = {"code": code, "name": name, "cost": st.get("cost"), "shares": st.get("shares"),
           "note": st.get("note", ""), "errors": []}
    stop_pct = float(st.get("stop_pct") or settings.get("stop_pct", 8)) / 100

    def step(label, fn):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            out["errors"].append("%s：%s" % (label, e))
            return None

    bars = step("股價", lambda: src.prices(code)) or []
    tech = step("技術分析", lambda: analysis.analyze(bars, st, stop_pct)) if bars else None
    if tech and "signals" in tech and positions and (len(positions) > 1 or positions[0]["account_name"]):
        # 依各帳戶成本分別判斷停損 / 停利
        sigs = [x for x in tech["signals"] if x["key"] not in COST_KEYS]
        for pos in positions:
            pa = analysis.analyze(bars, pos, stop_pct)
            pos["stop_price"] = pa.get("stop_price")
            for x in pa.get("signals", []):
                if x["key"] in COST_KEYS:
                    sigs.append(dict(x, key="%s~%s" % (x["key"], pos["account"]), account=pos["account"],
                                     title="%s%s" % ("【%s】" % pos["account_name"] if pos["account_name"] else "", x["title"])))
        tech["signals"] = sorted(sigs, key=lambda x: RANK[x["level"]])
    out["positions"] = positions or []
    out["tech"] = tech
    price = tech["close"] if tech and "close" in tech else None

    fetched = step("法人買賣", lambda: chips.fetch(code))
    out["chips"] = step("籌碼分析", lambda: chips.analyze(fetched[0], fetched[1], bars)) if fetched and bars else None
    if tech and "signals" in tech and out["chips"]:
        tech["signals"] = sorted(tech["signals"] + out["chips"]["signals"], key=lambda x: RANK[x["level"]])

    stmts = step("財報", lambda: src.statements(code)) or []
    out["financials"] = step("財報比較", lambda: fu.compare_quarters(stmts))
    rev = step("月營收", lambda: fu.revenue_summary(src.month_revenue(code)))
    out["revenue"] = rev
    per_hist = step("本益比", lambda: src.per_history(code)) or []
    out["valuation"] = step("估值", lambda: fu.valuation(stmts, per_hist, price)) if price else None

    raw = step("新聞", lambda: src.google_news("%s %s" % (name, code)) + src.google_news(name, 3)) or []
    uniq = {}
    for n in raw:
        uniq.setdefault(n["url"], n)
    kept, dropped = nw.filter_news(list(uniq.values()), name, code)
    out["news"], out["news_dropped"] = kept, dropped
    out["competitiveness"] = nw.competitiveness(kept, out["financials"], rev)

    evs = [ev.next_report(out["financials"]["last_q_end"] if out["financials"] else None, today)]
    divs = step("除權息", lambda: src.dividends(code)) or []
    evs += ev.dividend_events(code, twse_ex, divs, today)
    for e in evs:
        e["days"] = (date.fromisoformat(e["date"]) - today).days
    out["events"] = sorted([e for e in evs if e["days"] >= -1], key=lambda e: e["date"])
    return out


def collect_alerts(stocks, state, settings, today):
    """比對上次狀態，只推播「新出現」的提醒。"""
    sent = state.setdefault("sent", {})
    prev_active = set(state.get("active", []))
    active = set()
    days_before = int(settings.get("notify_days_before", 7))
    msgs = []
    now = time.time()
    for s in stocks:
        lines = []
        t = s.get("tech") or {}
        for sig in t.get("signals", []):
            if sig["level"] not in NOTIFY_LEVELS:
                continue
            key = "%s:%s" % (s["code"], sig["key"])
            if "@" in sig["key"]:
                if key in sent:
                    continue
                sent[key] = today.isoformat()
            else:
                active.add(key)
                if key in prev_active:
                    continue
            lines.append("%s %s" % (LEVEL_ICON[sig["level"]], sig["title"]))
        for n in s.get("news", []):
            if not n["important"] or now - n["ts"] > 86400:
                continue
            key = "news:%s:%s" % (s["code"], hashlib.md5(nw._norm(n["title"]).encode()).hexdigest()[:10])
            if key in sent:
                continue
            sent[key] = today.isoformat()
            lines.append("📰 %s（%s）" % (n["title"], n["source"]))
        for e in s.get("events", []):
            if e["type"] not in ("report", "dividend"):
                continue
            for stage, cond in (("w", 1 < e["days"] <= days_before), ("d", 0 <= e["days"] <= 1)):
                key = "ev:%s:%s:%s:%s" % (s["code"], e["type"], e["date"], stage)
                if cond and key not in sent:
                    sent[key] = today.isoformat()
                    when = "明天" if e["days"] == 1 else "今天" if e["days"] == 0 else "%d 天後" % e["days"]
                    lines.append("📅 %s %s（%s）" % (when, e["title"], e["date"]))
        if lines:
            msgs.append({"title": "%s %s：%d 則提醒" % (s["code"], s["name"], len(lines)),
                         "body": "\n".join(lines[:5]) + ("\n…還有 %d 則" % (len(lines) - 5) if len(lines) > 5 else ""),
                         "url": "./#/stock/%s" % s["code"], "tag": "stock-%s" % s["code"]})
    cutoff = (today - timedelta(days=60)).isoformat()
    state["sent"] = {k: v for k, v in sent.items() if v >= cutoff}
    state["active"] = sorted(active)
    return msgs


def summarize(stocks):
    cost = value = net = day = 0.0
    for s in stocks:
        p = (s.get("tech") or {}).get("pnl")
        if p:
            cost += p["cost_total"]; value += p["value"]; net += p["net"]
            day += (s["tech"]["chg"] or 0) * float(s.get("shares") or 0)
    return {"cost": round(cost), "value": round(value), "pnl": round(value - cost), "net": round(net),
            "pnl_pct": round((value - cost) / cost * 100, 2) if cost else None, "day": round(day)}


def main():
    pw = os.environ.get("APP_PASSWORD")
    if not pw:
        sys.exit("請設定 APP_PASSWORD 環境變數")
    portfolio = load_encrypted(PORTFOLIO, pw)
    if portfolio is None:
        sys.exit("找不到 config/portfolio.enc，請先執行 backend/setup_local.py")
    settings = portfolio.setdefault("settings", {"stop_pct": 8, "notify_days_before": 7})
    today = src.now_tw().date()
    twse_ex = src.twse_ex_rights()
    stocklist.refresh_if_old()

    pos = positions_of(portfolio)
    stocks, seen = [], set()
    for st in portfolio.get("stocks", []):
        if st["code"] in seen:  # 同一檔在多個帳戶只分析一次
            continue
        seen.add(st["code"])
        print("== %s %s" % (st["code"], st.get("name", "")))
        stocks.append(build_stock(st, twse_ex, settings, today, pos.get(st["code"])))

    state = load_encrypted(STATE, pw, default={}) or {}
    msgs = collect_alerts(stocks, state, settings, today)
    all_events = sorted(
        [dict(e, code=s["code"], name=s["name"]) for s in stocks for e in s["events"] if e["days"] <= 90],
        key=lambda e: e["date"])
    report = {"generated": src.now_tw().strftime("%Y-%m-%d %H:%M"), "portfolio": portfolio,
              "summary": summarize(stocks), "stocks": stocks, "events": all_events,
              "last_alerts": msgs}
    save_encrypted(REPORT, report, pw)

    subs = load_encrypted(SUBS, pw, default=[]) or []
    alive = notify.send_all(subs, msgs, os.environ.get("VAPID_PRIVATE_KEY"),
                            os.environ.get("VAPID_SUBJECT", "mailto:stock-tracker@example.com"))
    if len(alive) != len(subs):
        save_encrypted(SUBS, alive, pw)
    notify.mac_local(msgs)
    # 雲端沒有任何裝置訂閱時不記錄「已通知」，等開啟通知後仍會收到
    if alive or not os.environ.get("CI"):
        save_encrypted(STATE, state, pw)
    print("完成：%d 檔股票，%d 則新提醒" % (len(stocks), len(msgs)))
    for m in msgs:
        print("-", m["title"], "\n ", m["body"].replace("\n", "\n  "))


if __name__ == "__main__":
    main()
