"""技術分析：均線、MACD、KD、波浪型態（頭頭高底底高）與持股警示。

規則參考朱家泓老師公開教學中常見的順勢操作原則：
  * 趨勢看型態：頭頭高、底底高為多頭；頭頭低、底底低為空頭
  * 均線：5/10/20/60 日線，多頭排列且股價在月線之上才順勢做多
  * 停損：跌破前波低點或虧損達設定比例；空頭不攤平
  * 停利：獲利中依跌破 5 日 / 10 日 / 月線分段出場
  * 進場：多頭回檔不破前低、止跌紅K站回 5 日線；或帶量突破前高
僅供參考，非投資建議。
"""

FEE = 0.001425   # 券商手續費
TAX = 0.003      # 證交稅（賣出）


def sma(vals, n):
    out, s = [], 0.0
    for i, v in enumerate(vals):
        s += v
        if i >= n:
            s -= vals[i - n]
        out.append(round(s / n, 2) if i >= n - 1 else None)
    return out


def ema(vals, n):
    k = 2 / (n + 1)
    out, prev = [], None
    for v in vals:
        prev = v if prev is None else prev + k * (v - prev)
        out.append(prev)
    return out


def macd(closes, fast=12, slow=26, sig=9):
    ef, es = ema(closes, fast), ema(closes, slow)
    dif = [a - b for a, b in zip(ef, es)]
    dea = ema(dif, sig)
    osc = [a - b for a, b in zip(dif, dea)]
    r = lambda xs: [round(x, 3) for x in xs]  # noqa: E731
    return r(dif), r(dea), r(osc)


def kd(highs, lows, closes, n=9):
    k_prev = d_prev = 50.0
    ks, ds = [], []
    for i in range(len(closes)):
        lo = min(lows[max(0, i - n + 1): i + 1])
        hi = max(highs[max(0, i - n + 1): i + 1])
        rsv = 50.0 if hi == lo else (closes[i] - lo) / (hi - lo) * 100
        k_prev = k_prev * 2 / 3 + rsv / 3
        d_prev = d_prev * 2 / 3 + k_prev / 3
        ks.append(round(k_prev, 2))
        ds.append(round(d_prev, 2))
    return ks, ds


def pivots(highs, lows, w=4):
    """轉折高低點：左右各 w 根K線內的最高 / 最低。"""
    ph, pl = [], []
    for i in range(w, len(highs) - w):
        if highs[i] == max(highs[i - w: i + w + 1]):
            if not ph or i - ph[-1][0] > w:
                ph.append((i, highs[i]))
        if lows[i] == min(lows[i - w: i + w + 1]):
            if not pl or i - pl[-1][0] > w:
                pl.append((i, lows[i]))
    return ph, pl


def trend_of(ph, pl, close):
    if len(ph) < 2 or len(pl) < 2:
        return "盤整", "轉折點不足，暫判盤整"
    h1, h2 = ph[-2][1], ph[-1][1]
    l1, l2 = pl[-2][1], pl[-1][1]
    if close < l2:
        return "空頭", "跌破前波低點 %.2f，趨勢轉弱" % l2
    if close > h2 and l2 > l1:
        return "多頭", "突破前波高點 %.2f 且底底高，多頭確認" % h2
    if h2 > h1 and l2 > l1:
        return "多頭", "頭頭高（%.2f→%.2f）、底底高（%.2f→%.2f）" % (h1, h2, l1, l2)
    if h2 < h1 and l2 < l1:
        return "空頭", "頭頭低（%.2f→%.2f）、底底低（%.2f→%.2f）" % (h1, h2, l1, l2)
    return "盤整", "高低點未同步墊高或下移，區間整理"


def _cross_up(a, b, i):
    return a[i - 1] is not None and b[i - 1] is not None and a[i - 1] <= b[i - 1] and a[i] > b[i]


def _cross_dn(a, b, i):
    return a[i - 1] is not None and b[i - 1] is not None and a[i - 1] >= b[i - 1] and a[i] < b[i]


def analyze(bars, holding, stop_pct=0.08):
    """bars: [{date,open,high,low,close,volume}]；holding: {cost, shares}"""
    if len(bars) < 30:
        return {"error": "歷史資料不足"}
    o = [b["open"] for b in bars]
    h = [b["high"] for b in bars]
    l = [b["low"] for b in bars]
    c = [b["close"] for b in bars]
    v = [b["volume"] for b in bars]
    ma5, ma10, ma20, ma60 = sma(c, 5), sma(c, 10), sma(c, 20), sma(c, 60)
    vma5 = sma(v, 5)
    dif, dea, osc = macd(c)
    k, d = kd(h, l, c)
    ph, pl = pivots(h, l)
    i = len(c) - 1
    close, prev = c[i], c[i - 1]
    trend, trend_note = trend_of(ph, pl, close)

    def ok(x):
        return x is not None

    aligned_bull = all(map(ok, (ma5[i], ma10[i], ma20[i], ma60[i]))) and ma5[i] > ma10[i] > ma20[i] > ma60[i]
    aligned_bear = all(map(ok, (ma5[i], ma10[i], ma20[i], ma60[i]))) and ma5[i] < ma10[i] < ma20[i] < ma60[i]
    ma_state = "多頭排列" if aligned_bull else "空頭排列" if aligned_bear else "糾結 / 未排列"

    last_high = ph[-1][1] if ph else max(h[-20:])
    last_low = pl[-1][1] if pl else min(l[-20:])
    cost = float(holding.get("cost") or 0)
    shares = float(holding.get("shares") or 0)

    sig = []

    def add(level, key, title, detail, daily=False):
        sig.append({"level": level, "key": key + ("@" + bars[i]["date"] if daily else ""),
                    "title": title, "detail": detail})

    # --- 持股損益與停損 ---
    pnl = None
    stop_price = None
    if cost > 0:
        pct = (close - cost) / cost
        gross = (close - cost) * shares
        net = close * shares * (1 - FEE - TAX) - cost * shares
        pnl = {"pct": round(pct * 100, 2), "gross": round(gross), "net": round(net),
               "value": round(close * shares), "cost_total": round(cost * shares)}
        pct_stop = round(cost * (1 - stop_pct), 2)
        stop_price = max(pct_stop, last_low) if last_low < close else pct_stop
        if pct <= -stop_pct:
            add("danger", "stoploss_pct", "虧損已達 %.1f%%（停損線 -%d%%）" % (pct * 100, stop_pct * 100),
                "依紀律應考慮停損或減碼；%s，不建議向下攤平。" % ("目前為空頭趨勢" if trend == "空頭" else "趨勢未轉強前"))
        if close < last_low:
            add("danger", "break_low", "跌破前波低點 %.2f" % last_low,
                "型態轉弱（底底低），朱老師常用的停損 / 出場依據。")
        if pct > 0:
            if ok(ma20[i]) and close < ma20[i]:
                add("danger", "profit_ma20", "獲利中跌破月線 %.2f" % ma20[i], "中期趨勢轉弱，建議獲利出場。")
            elif ok(ma10[i]) and close < ma10[i]:
                add("warn", "profit_ma10", "獲利中跌破 10 日線 %.2f" % ma10[i], "可考慮減碼一半，保住獲利。")
            elif ok(ma5[i]) and close < ma5[i]:
                add("info", "profit_ma5", "獲利中跌破 5 日線 %.2f" % ma5[i], "短線轉弱，留意是否續跌。")
        if pct <= -stop_pct * 0.75 and pct > -stop_pct:
            add("warn", "near_stop", "接近停損線（目前 %.1f%%）" % (pct * 100), "停損價約 %.2f。" % pct_stop)

    # --- K線與量價 ---
    body = (close - o[i]) / o[i] if o[i] else 0
    if ok(vma5[i - 1]) and vma5[i - 1] > 0:
        vr = v[i] / vma5[i - 1]
        if body <= -0.03 and vr >= 1.8 and ok(ma20[i]) and close > ma20[i] * 1.05:
            add("warn", "high_black", "高檔爆量長黑（量為 5 日均量 %.1f 倍）" % vr, "多頭可能出現反轉，留意出貨。", daily=True)
        if close > last_high and prev <= last_high and vr >= 1.5 and body > 0.02:
            add("buy", "breakout", "帶量突破前高 %.2f" % last_high, "量增價漲的突破，可列為進場 / 加碼參考，停損設在突破K棒低點 %.2f。" % l[i], daily=True)

    # --- 均線交叉 ---
    if _cross_dn(c, ma20, i):
        add("warn", "x_ma20_dn", "跌破月線 %.2f" % ma20[i], "短中期趨勢轉弱。", daily=True)
    if _cross_up(c, ma20, i):
        add("info", "x_ma20_up", "站回月線 %.2f" % ma20[i], "需搭配底底高確認轉強。", daily=True)
    if _cross_dn(c, ma60, i):
        add("warn", "x_ma60_dn", "跌破季線 %.2f" % ma60[i], "中長期轉弱訊號。", daily=True)

    # --- 多頭回檔買點 ---
    if trend == "多頭" and ok(ma20[i]) and ok(ma5[i]):
        near20 = min(l[i - 2: i + 1]) <= ma20[i] * 1.02 and close > ma20[i]
        if near20 and close > ma5[i] and body > 0:
            add("buy", "pullback", "多頭回測月線止跌", "回檔不破月線並以紅K站回 5 日線，屬低接參考點，停損設前低 %.2f。" % last_low, daily=True)

    # --- MACD / KD ---
    if _cross_up(dif, dea, i):
        add("info", "macd_gc", "MACD 黃金交叉", "DIF 上穿 MACD 線%s。" % ("（零軸下，偏反彈）" if dif[i] < 0 else "（零軸上，偏多）"), daily=True)
    if _cross_dn(dif, dea, i):
        add("warn" if dif[i] > 0 else "info", "macd_dc", "MACD 死亡交叉", "動能轉弱。", daily=True)
    if _cross_up(k, d, i) and k[i] < 25:
        add("info", "kd_gc_low", "KD 低檔黃金交叉 (K=%.0f)" % k[i], "超賣區反彈訊號，空頭中僅視為反彈。", daily=True)
    if _cross_dn(k, d, i) and k[i] > 80:
        add("warn", "kd_dc_high", "KD 高檔死亡交叉 (K=%.0f)" % k[i], "超買區轉弱。", daily=True)
    if len(ph) >= 2:
        (i1, p1), (i2, p2) = ph[-2], ph[-1]
        if p2 > p1 and dif[i2] < dif[i1] and i - i2 <= 10:
            add("warn", "bear_div@%s" % bars[i2]["date"], "MACD 頂背離", "股價創高但 MACD 未創高，上漲動能減弱。")

    # --- 價位參考 ---
    sup = sorted({round(x, 2) for x in (last_low, ma20[i], ma60[i]) if ok(x) and x < close}, reverse=True)
    res = sorted({round(x, 2) for x in (last_high, ma20[i], ma60[i]) if ok(x) and x > close})
    if trend == "多頭":
        buy_zone = [round(min(x for x in (ma20[i], last_low) if ok(x)), 2), round(ma20[i] * 1.02, 2) if ok(ma20[i]) else None]
        buy_note = "多頭回檔至月線～前低附近、出現止跌紅K時可分批承接"
    elif trend == "空頭":
        buy_zone = None
        buy_note = "空頭趨勢不建議買進或攤平；等待「底底高」並帶量突破前高 %.2f 後再考慮" % last_high
    else:
        buy_zone = [round(last_low, 2), round(last_low * 1.03, 2)]
        buy_note = "盤整區間：靠近區間下緣 %.2f 不破可小量試單，突破上緣 %.2f 再加碼" % (last_low, last_high)

    checklist = [
        {"name": "型態：頭頭高、底底高", "ok": trend == "多頭"},
        {"name": "均線多頭排列（5>10>20>60）", "ok": aligned_bull},
        {"name": "股價在月線之上", "ok": ok(ma20[i]) and close > ma20[i]},
        {"name": "股價在季線之上", "ok": ok(ma60[i]) and close > ma60[i]},
        {"name": "MACD 在零軸之上", "ok": dif[i] > 0},
        {"name": "KD 未過熱（K<80）", "ok": k[i] < 80},
    ]

    level_rank = {"danger": 0, "warn": 1, "buy": 2, "info": 3}
    sig.sort(key=lambda s: level_rank[s["level"]])

    n = min(len(bars), 260)
    sl = slice(len(bars) - n, None)
    return {
        "close": close, "prev": prev, "chg": round(close - prev, 2),
        "chg_pct": round((close - prev) / prev * 100, 2) if prev else 0,
        "date": bars[i]["date"], "volume": v[i],
        "trend": trend, "trend_note": trend_note, "ma_state": ma_state,
        "ma": {"ma5": ma5[i], "ma10": ma10[i], "ma20": ma20[i], "ma60": ma60[i]},
        "macd": {"dif": dif[i], "dea": dea[i], "osc": osc[i]},
        "kd": {"k": k[i], "d": d[i]},
        "last_high": last_high, "last_low": last_low,
        "support": sup, "resistance": res,
        "stop_price": stop_price, "stop_pct": stop_pct * 100,
        "buy_zone": buy_zone, "buy_note": buy_note, "checklist": checklist,
        "pnl": pnl, "signals": sig,
        "series": {
            "bars": [[b["date"], b["open"], b["high"], b["low"], b["close"], b["volume"]] for b in bars[sl]],
            "ma5": ma5[sl], "ma10": ma10[sl], "ma20": ma20[sl], "ma60": ma60[sl],
            "dif": dif[sl], "dea": dea[sl], "osc": osc[sl], "k": k[sl], "d": d[sl],
            "pivots_high": [[bars[j]["date"], p] for j, p in ph if j >= len(bars) - n],
            "pivots_low": [[bars[j]["date"], p] for j, p in pl if j >= len(bars) - n],
        },
    }
