"""財報公布與除權息事件。"""
from datetime import date

# 台灣上市櫃公司法定財報公布期限（一般產業）
DEADLINES = {1: (5, 15), 2: (8, 14), 3: (11, 14), 4: (3, 31)}


def next_report(last_q_end, today):
    """last_q_end: 已公布的最新一季結束日 'YYYY-MM-DD'。回傳下一季財報的法定截止日。"""
    if last_q_end:
        y, m = int(last_q_end[:4]), int(last_q_end[5:7])
        q = (m - 1) // 3 + 1
        ny, nq = (y + 1, 1) if q == 4 else (y, q + 1)
    else:
        ny, nq = today.year, 1
    mo, d = DEADLINES[nq]
    dy = ny + 1 if nq == 4 else ny
    label = "%d 年第 %d 季財報" % (ny, nq) if nq != 4 else "%d 年年報（含第 4 季）" % ny
    return {"type": "report", "date": date(dy, mo, d).isoformat(), "title": label,
            "detail": "法定公布截止日；多數公司會在截止日前召開董事會 / 法說會公布", "estimated": True}


def dividend_events(code, twse_rows, fm_rows, today):
    out, seen = [], set()
    for r in twse_rows:
        if r["code"] != code or not r["date"]:
            continue
        kind = {"息": "除息", "權": "除權", "權息": "除權息"}.get(r["kind"], r["kind"])
        detail = []
        if r.get("cash"):
            detail.append("現金股利 %.4g 元" % r["cash"])
        if r.get("stock_ratio"):
            detail.append("無償配股率 %.4g" % r["stock_ratio"])
        out.append({"type": "dividend", "date": r["date"], "title": kind + "交易日",
                    "detail": "、".join(detail) or "金額待公告", "estimated": False})
        seen.add(r["date"])
    for r in fm_rows:
        for fld, name in (("CashExDividendTradingDate", "除息"), ("StockExDividendTradingDate", "除權")):
            d = r.get(fld)
            if d and d >= today.isoformat() and d not in seen:
                amt = r.get("CashEarningsDistribution", 0) + r.get("CashStatutorySurplus", 0) if name == "除息" else \
                    r.get("StockEarningsDistribution", 0) + r.get("StockStatutorySurplus", 0)
                out.append({"type": "dividend", "date": d, "title": name + "交易日",
                            "detail": ("%s %.4g 元" % ("現金股利" if name == "除息" else "股票股利", amt)) if amt else "",
                            "estimated": False})
                seen.add(d)
        pay = r.get("CashDividendPaymentDate")
        if pay and pay >= today.isoformat():
            out.append({"type": "dividend_pay", "date": pay, "title": "現金股利發放日", "detail": "", "estimated": False})
    return out


def revenue_event(today):
    y, m = today.year, today.month
    if today.day > 10:
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return {"type": "revenue", "date": date(y, m, 10).isoformat(), "title": "月營收公布截止日",
            "detail": "上月營收需於每月 10 日前公布", "estimated": True}
