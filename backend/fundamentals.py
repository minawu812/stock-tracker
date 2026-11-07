"""財報季增 / 年增比較、月營收、EPS 與本益比合理價。"""


def _pct(a, b):
    if a is None or b is None or b == 0:
        return None
    return round((a - b) / abs(b) * 100, 2)


def _qlabel(q):
    y, m = int(q[:4]), int(q[5:7])
    return "%dQ%d" % (y, (m - 1) // 3 + 1)


def _metrics(s):
    rev = s.get("Revenue")
    gp = s.get("GrossProfit")
    op = s.get("OperatingIncome")
    ni = s.get("EquityAttributableToOwnersOfParent", s.get("IncomeAfterTaxes"))
    m = {"revenue": rev, "gross_profit": gp, "op_income": op, "net_income": ni, "eps": s.get("EPS")}
    if rev:
        m["gross_margin"] = round(gp / rev * 100, 2) if gp is not None else None
        m["op_margin"] = round(op / rev * 100, 2) if op is not None else None
        m["net_margin"] = round(ni / rev * 100, 2) if ni is not None else None
    return m


METRICS = [
    ("revenue", "營業收入", "amount"),
    ("gross_profit", "營業毛利", "amount"),
    ("op_income", "營業利益", "amount"),
    ("net_income", "稅後淨利", "amount"),
    ("eps", "EPS（元）", "eps"),
    ("gross_margin", "毛利率", "margin"),
    ("op_margin", "營益率", "margin"),
    ("net_margin", "淨利率", "margin"),
]


def compare_quarters(stmts):
    if not stmts:
        return None
    qs = [s for s in stmts if s.get("Revenue")]
    if not qs:
        return None
    cur = qs[-1]
    prev = qs[-2] if len(qs) >= 2 else None
    yoy_q = "%d%s" % (int(cur["q"][:4]) - 1, cur["q"][4:])
    yago = next((s for s in qs if s["q"] == yoy_q), None)
    mc, mp, my = _metrics(cur), _metrics(prev) if prev else {}, _metrics(yago) if yago else {}
    rows = []
    better = worse = 0
    for key, name, kind in METRICS:
        a, b, y = mc.get(key), mp.get(key), my.get(key)
        if kind == "margin":
            qoq = round(a - b, 2) if a is not None and b is not None else None
            yoy = round(a - y, 2) if a is not None and y is not None else None
        else:
            qoq, yoy = _pct(a, b), _pct(a, y)
        for x in (qoq, yoy):
            if x is not None:
                better += x > 0
                worse += x < 0
        rows.append({"key": key, "name": name, "kind": kind, "cur": a, "prev": b, "yago": y,
                     "qoq": qoq, "yoy": yoy})
    if better >= worse * 2:
        verdict = "進步"
    elif worse >= better * 2:
        verdict = "退步"
    else:
        verdict = "持平 / 互有增減"
    history = [{"q": _qlabel(s["q"]), **_metrics(s)} for s in qs[-8:]]
    return {"cur_q": _qlabel(cur["q"]), "prev_q": _qlabel(prev["q"]) if prev else None,
            "yago_q": _qlabel(yago["q"]) if yago else None, "rows": rows,
            "better": better, "worse": worse, "verdict": verdict, "history": history,
            "last_q_end": cur["q"]}


def revenue_summary(rev):
    if not rev:
        return None
    by = {r["ym"]: r["revenue"] for r in rev}
    out = []
    for r in rev[-13:]:
        y, m = int(r["ym"][:4]), int(r["ym"][5:])
        pm = "%d-%02d" % (y - (m == 1), 12 if m == 1 else m - 1)
        py = "%d-%02d" % (y - 1, m)
        out.append({"ym": r["ym"], "revenue": r["revenue"], "mom": _pct(r["revenue"], by.get(pm)),
                    "yoy": _pct(r["revenue"], by.get(py))})
    last = rev[-1]
    y = last["ym"][:4]
    cum = sum(r["revenue"] for r in rev if r["ym"][:4] == y)
    cum_prev = sum(r["revenue"] for r in rev if r["ym"][:4] == str(int(y) - 1) and r["ym"][5:] <= last["ym"][5:])
    return {"months": out, "cum_yoy": _pct(cum, cum_prev), "latest": out[-1]}


def _percentile(xs, p):
    xs = sorted(xs)
    if not xs:
        return None
    k = (len(xs) - 1) * p
    f = int(k)
    c = min(f + 1, len(xs) - 1)
    return xs[f] + (xs[c] - xs[f]) * (k - f)


def valuation(stmts, per_hist, price):
    eps_list = [s.get("EPS") for s in stmts if s.get("EPS") is not None]
    if len(eps_list) < 4:
        return None
    ttm = round(sum(eps_list[-4:]), 2)
    annualized = round(eps_list[-1] * 4, 2)
    pers = [x["PER"] for x in per_hist if x.get("PER") and x["PER"] > 0]
    out = {"eps_ttm": ttm, "eps_annualized": annualized, "last_q_eps": eps_list[-1],
           "per_now": round(price / ttm, 2) if ttm > 0 else None,
           "per_fwd": round(price / annualized, 2) if annualized > 0 else None,
           "dividend_yield": per_hist[-1].get("dividend_yield") if per_hist else None,
           "pbr": per_hist[-1].get("PBR") if per_hist else None}
    had_loss = any(e <= 0 for e in eps_list[-12:])
    if len(pers) >= 250 and not had_loss:
        bands = {k: round(_percentile(pers, p), 2) for k, p in
                 (("min", 0), ("p25", 0.25), ("p50", 0.5), ("p75", 0.75), ("max", 1))}
        out["band_source"] = "近 3 年歷史本益比"
    else:
        bands = {"min": 8, "p25": 12, "p50": 15, "p75": 20, "max": 25}
        out["band_source"] = "一般產業參考本益比 12～20 倍（近 3 年曾虧損或歷史資料不足，歷史本益比不具參考性）"
    out["per_bands"] = bands
    base = ttm if ttm > 0 else None
    if base:
        out["price_bands"] = {k: round(base * v, 2) for k, v in bands.items()}
        pn = out["per_now"]
        if pn < bands["p25"]:
            status, note = "便宜", "本益比 %.1f 倍，低於參考區間下緣 %.1f 倍" % (pn, bands["p25"])
        elif pn < bands["p50"]:
            status, note = "合理偏低", "本益比 %.1f 倍，位於參考區間中下段" % pn
        elif pn < bands["p75"]:
            status, note = "合理偏高", "本益比 %.1f 倍，位於參考區間中上段" % pn
        elif pn <= bands["max"]:
            status, note = "偏貴", "本益比 %.1f 倍，高於參考區間上緣 %.1f 倍" % (pn, bands["p75"])
        else:
            status, note = "昂貴", "本益比 %.1f 倍，高於參考上限 %.1f 倍" % (pn, bands["max"])
        if had_loss and annualized > ttm * 1.5:
            note += "；景氣循環股在獲利高峰時本益比會偏低，「便宜」不代表安全"
        out["status"], out["status_note"] = status, note
        out["fair_range"] = [out["price_bands"]["p25"], out["price_bands"]["p75"]]
    if ttm <= 0:
        out["status"], out["status_note"] = "無法評估", "近四季 EPS 為負，本益比不適用（可參考股價淨值比）"
    if ttm > 0 and annualized > ttm * 1.5:
        out["growth_note"] = ("最新一季 EPS 年化 %.2f 元遠高於近四季合計 %.2f 元，獲利快速成長中，"
                              "以近四季計算的本益比會偏高；景氣循環股需留意高峰時本益比反而偏低的陷阱。" % (annualized, ttm))
    return out
