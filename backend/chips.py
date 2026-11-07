"""法人籌碼：外資 / 投信 / 自營商買賣超、連買連賣、外資持股比例變化。"""
from datetime import date, timedelta

import sources as src

GROUP = {
    "Foreign_Investor": "foreign", "Foreign_Dealer_Self": "foreign",
    "Investment_Trust": "trust",
    "Dealer_self": "dealer", "Dealer_Hedging": "dealer",
}
NAMES = {"foreign": "外資", "trust": "投信", "dealer": "自營商"}


def fetch(code, days=140):
    start = (date.today() - timedelta(days=days)).isoformat()
    by = {}
    for x in src.finmind("TaiwanStockInstitutionalInvestorsBuySell", code, start):
        g = GROUP.get(x["name"])
        if not g:
            continue
        d = by.setdefault(x["date"], {"foreign": 0, "trust": 0, "dealer": 0})
        d[g] += (x["buy"] - x["sell"]) / 1000  # 張
    inst = [dict(date=k, **{g: round(v) for g, v in d.items()}) for k, d in sorted(by.items())]
    hold = [{"date": x["date"], "ratio": x["ForeignInvestmentSharesRatio"]}
            for x in src.finmind("TaiwanStockShareholding", code, start)]
    hold.sort(key=lambda r: r["date"])
    return inst, hold


def _streak(vals):
    """從最新一天往回算連續同方向天數；正=連買，負=連賣。"""
    n, sgn = 0, 0
    for v in reversed(vals):
        s = (v > 0) - (v < 0)
        if s == 0 or (sgn and s != sgn):
            break
        sgn = s
        n += 1
    return n * sgn


def analyze(inst, hold, bars):
    if len(inst) < 10:
        return None
    vol = {b["date"]: b["volume"] for b in bars}
    close = {b["date"]: b["close"] for b in bars}
    last = inst[-1]
    d = last["date"]
    out = {"date": d, "groups": {}, "signals": []}

    def add(level, key, title, detail, daily=False):
        out["signals"].append({"level": level, "key": "chip_" + key + ("@" + d if daily else ""),
                               "title": title, "detail": detail})

    for g in ("foreign", "trust", "dealer"):
        vals = [r[g] for r in inst]
        avg_abs = sum(abs(v) for v in vals[-60:]) / max(1, len(vals[-60:]))
        today = vals[-1]
        out["groups"][g] = {
            "today": today, "sum5": sum(vals[-5:]), "sum20": sum(vals[-20:]),
            "streak": _streak(vals), "avg_abs": round(avg_abs),
            "pct_vol": round(today / vol[d] * 100, 1) if vol.get(d) else None,
        }
    F, T = out["groups"]["foreign"], out["groups"]["trust"]
    v_today = vol.get(d) or 0

    # 單日大買大賣：超過 60 日平均絕對值 2 倍，且占當日成交量一定比例
    for g, gi, min_pct in (("foreign", F, 5), ("trust", T, 1.5)):
        x = gi["today"]
        if gi["avg_abs"] and abs(x) >= 2 * gi["avg_abs"] and v_today and abs(x) / v_today * 100 >= min_pct:
            big = "大買" if x > 0 else "大賣"
            add("buy" if x > 0 else "warn", "%s_big" % g, "%s%s %s 張" % (NAMES[g], big, format(abs(x), ",")),
                "約占當日成交量 %.1f%%，為近 60 日平均的 %.1f 倍。" % (abs(x) / v_today * 100, abs(x) / gi["avg_abs"]),
                daily=True)
    # 連買連賣
    if F["streak"] <= -5:
        add("warn", "f_sell_streak", "外資連續賣超 %d 天" % -F["streak"],
            "近 5 日累計賣超 %s 張，留意外資撤出。" % format(-F["sum5"], ","))
    if F["streak"] >= 5:
        add("buy", "f_buy_streak", "外資連續買超 %d 天" % F["streak"], "近 5 日累計買超 %s 張。" % format(F["sum5"], ","))
    if T["streak"] >= 3:
        add("buy", "t_buy_streak", "投信連續買超 %d 天" % T["streak"], "投信偏向波段作帳，連買常有延續性。")
    if T["streak"] <= -3:
        add("warn", "t_sell_streak", "投信連續賣超 %d 天" % -T["streak"], "投信調節持股，留意壓力。")
    # 三大法人同步
    if all(out["groups"][g]["today"] < 0 for g in NAMES):
        add("warn", "all_sell", "三大法人同步賣超", "合計 %s 張。" % format(sum(out["groups"][g]["today"] for g in NAMES), ","), daily=True)
    if all(out["groups"][g]["today"] > 0 for g in NAMES):
        add("buy", "all_buy", "三大法人同步買超", "合計 %s 張。" % format(sum(out["groups"][g]["today"] for g in NAMES), ","), daily=True)

    # 外資持股比例
    if len(hold) >= 2:
        now = hold[-1]["ratio"]
        r5 = hold[-6]["ratio"] if len(hold) >= 6 else hold[0]["ratio"]
        r20 = hold[-21]["ratio"] if len(hold) >= 21 else hold[0]["ratio"]
        out["holding"] = {"now": now, "chg5": round(now - r5, 2), "chg20": round(now - r20, 2),
                          "series": [[h["date"], h["ratio"]] for h in hold[-90:]]}
        if now - r20 <= -1:
            add("warn", "f_exit", "外資持股 20 日減少 %.2f 個百分點" % (r20 - now),
                "外資持股比例 %.2f%% → %.2f%%，有撤出跡象。" % (r20, now))
        elif now - r20 >= 1:
            add("buy", "f_enter", "外資持股 20 日增加 %.2f 個百分點" % (now - r20),
                "外資持股比例 %.2f%% → %.2f%%，有回補 / 進場跡象。" % (r20, now))

    s5 = F["sum5"] + T["sum5"]
    avg_vol = sum(vol.get(r["date"], 0) for r in inst[-5:]) / 5 or 1
    if s5 / avg_vol > 0.03:
        out["verdict"] = "籌碼偏多"
    elif s5 / avg_vol < -0.03:
        out["verdict"] = "籌碼偏空"
    else:
        out["verdict"] = "籌碼中性"
    out["verdict_note"] = "外資＋投信近 5 日合計%s %s 張" % ("買超" if s5 >= 0 else "賣超", format(abs(s5), ","))
    out["daily"] = [{**r, "total": r["foreign"] + r["trust"] + r["dealer"], "close": close.get(r["date"]),
                     "volume": vol.get(r["date"])} for r in inst[-60:]]
    return out
