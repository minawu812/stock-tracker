"""新聞篩選：只留可信財經媒體，排除聳動 / 宣傳標題，並以關鍵字評估重要性與競爭力。"""
import difflib
import re

# 可信來源（Google 新聞 source 名稱包含以下字樣即可）
TRUSTED = [
    "經濟日報", "工商時報", "中央社", "中央通訊社", "MoneyDJ", "鉅亨", "Anue", "財訊", "商業周刊", "商周",
    "天下雜誌", "今周刊", "遠見", "數位時代", "DIGITIMES", "科技新報", "TechNews", "自由財經", "聯合新聞網",
    "UDN", "時報資訊", "富聯網", "優分析", "UAnalyze", "路透", "Reuters", "Bloomberg", "彭博", "理財周刊",
    "財經新報", "Yahoo股市", "Yahoo奇摩股市", "公開資訊觀測站", "CTEE",
]
# 一律排除的來源
BLOCKED = [
    "東森", "ETtoday", "中天", "三立", "TVBS", "FTNN", "CMoney", "爆料", "LINE TODAY", "台視", "民視", "中視",
    "鏡週刊", "壹蘋", "NOWnews", "噓", "風傳媒", "聚財網", "PTT", "Mobile01", "Dcard", "股市爆料同學會",
    "房地產", "遊戲", "娛樂", "星聞", "運動", "健康", "旅遊",
]
CLICKBAIT = re.compile(
    r"驚爆|嚇|暴動|狂|套牢|套爛|韭菜|存股族|神股|哀號|哀嚎|爆料|傻眼|網友|鄉民|血洗|慘|崩|噴出|狂飆|狂噴|狂砍|狂倒|飆漲|暴漲|暴跌|"
    r"必看|曝光|震撼|嗨翻|樂翻|快跑|逃命|全員|一片綠|一片紅|！！|\?\!|？！|這檔|它被|竟然|怎麼了")
PROMO = re.compile(
    r"榮獲|獲頒|獲.{0,20}(獎|殊榮|認證|肯定|Milestone)|喜迎|盛大|隆重|贊助|捐贈|捐款|公益|慶祝|週年|周年|開幕|"
    r"揭牌|簽約儀式|攜手.{0,10}(推廣|打造|培育)|育才|ESG|永續|淨零|頒獎|嘉年華|論壇|展覽|參展|展出|亮相")

IMPORTANT = {
    "財報/獲利": r"營收|獲利|EPS|每股|毛利率|營益率|財報|稅後|淨利|賺|虧損|轉虧|轉盈",
    "展望/法說": r"法說|展望|財測|指引|看好|看淡|保守|樂觀|景氣|董座|總座|執行長",
    "法人/評等": r"目標價|評等|外資|投信|法人|買超|賣超|升評|降評",
    "接單/產能": r"訂單|接單|大單|擴產|產能|資本支出|新廠|稼動率|減產|量產",
    "產品/技術": r"新品|技術|製程|AI|先進|專利|突破|開發|研發",
    "市場/競爭": r"市占|競爭|對手|價格戰|漲價|報價|降價|庫存|缺貨|供應|客戶|併購|購併|合作",
    "重大訊息": r"重訊|重大訊息|減資|增資|股利|配息|除息|除權|庫藏股|董事會|罰|訴訟|調查|停工|火災",
}
POSITIVE = re.compile(
    r"創新高|創高|新高|成長|年增|月增|上修|調升|升評|看好|樂觀|擴產|大單|接單暢旺|市占.{0,4}(提升|擴大|增)|"
    r"領先|漲價|轉盈|優於預期|買超|旺|強勁|攀升|衝破|突破|翻倍|賺")
NEGATIVE = re.compile(
    r"衰退|年減|月減|下修|調降|降評|砍|看淡|保守|虧損|轉虧|價格戰|競爭加劇|庫存.{0,4}(高|調整|去化)|"
    r"低於預期|跌破|賣超|倒貨|爆雷|憂|風險|難測|退出|放緩|減產|延後|失守|疲弱|下滑|走弱|弱至|撤離|不確定|腰斬|重挫|跌停")


def _norm(t):
    return re.sub(r"[\s\W_]+", "", t)


def classify(item, name=""):
    src, title = item["source"], item["title"]
    bare = title.replace(name, "") if name else title  # 避免公司名（如「旺宏」的旺）影響語氣
    if any(b.lower() in src.lower() for b in BLOCKED):
        return None, "排除來源"
    if not any(t.lower() in src.lower() for t in TRUSTED):
        return None, "非可信來源"
    if CLICKBAIT.search(title):
        return None, "聳動標題"
    if PROMO.search(title):
        return None, "宣傳性新聞"
    cats = [c for c, p in IMPORTANT.items() if re.search(p, title)]
    pos = len(POSITIVE.findall(bare))
    neg = len(NEGATIVE.findall(bare))
    score = len(cats) * 2 + ("重大訊息" in cats) * 3 + ("財報/獲利" in cats) * 2 + min(pos + neg, 3)
    tone = "正面" if pos > neg else "負面" if neg > pos else "中性"
    return {**item, "cats": cats, "tone": tone, "score": score, "important": score >= 5}, None


def filter_news(items, name, code):
    kept, dropped = [], {}
    seen = []
    for it in sorted(items, key=lambda x: -x["ts"]):
        if name not in it["title"] and code not in it["title"]:
            dropped["與個股無關"] = dropped.get("與個股無關", 0) + 1
            continue
        r, why = classify(it, name)
        if not r:
            dropped[why] = dropped.get(why, 0) + 1
            continue
        n = _norm(r["title"])
        if any(difflib.SequenceMatcher(None, n, s).ratio() > 0.6 for s in seen):
            dropped["重複報導"] = dropped.get("重複報導", 0) + 1
            continue
        seen.append(n)
        if r["score"] < 2:
            dropped["內容價值低"] = dropped.get("內容價值低", 0) + 1
            continue
        kept.append(r)
    kept.sort(key=lambda x: (-x["important"], -x["ts"]))
    return kept[:20], dropped


def competitiveness(news, fin, rev):
    """綜合月營收、財報與新聞語氣，給出 1～5 分的競爭力評估與條列理由。"""
    pts, reasons = 0.0, []
    if rev and rev.get("latest"):
        y = rev["latest"].get("yoy")
        recent = [m["yoy"] for m in rev["months"][-3:] if m.get("yoy") is not None]
        if recent:
            avg = sum(recent) / len(recent)
            if avg > 20:
                pts += 1; reasons.append(("+", "近 3 個月營收平均年增 %.1f%%，需求強勁" % avg))
            elif avg > 0:
                pts += 0.5; reasons.append(("+", "近 3 個月營收平均年增 %.1f%%，穩定成長" % avg))
            elif avg < -10:
                pts -= 1; reasons.append(("-", "近 3 個月營收平均年減 %.1f%%，需求轉弱" % -avg))
            else:
                pts -= 0.5; reasons.append(("-", "近 3 個月營收小幅年減 %.1f%%" % -avg))
        if y is not None and rev.get("cum_yoy") is not None:
            reasons.append(("·", "今年累計營收年增 %.1f%%" % rev["cum_yoy"]))
    if fin:
        rows = {r["key"]: r for r in fin["rows"]}
        gm = rows.get("gross_margin")
        if gm and gm["yoy"] is not None:
            if gm["yoy"] > 1:
                pts += 1; reasons.append(("+", "毛利率 %.1f%%，較去年同期提升 %.1f 個百分點，定價力 / 產品組合改善" % (gm["cur"], gm["yoy"])))
            elif gm["yoy"] < -1:
                pts -= 1; reasons.append(("-", "毛利率 %.1f%%，較去年同期下降 %.1f 個百分點，留意競爭或成本壓力" % (gm["cur"], -gm["yoy"])))
            else:
                reasons.append(("·", "毛利率 %.1f%%，與去年同期相近" % gm["cur"]))
        om = rows.get("op_margin")
        if om and om["qoq"] is not None:
            if om["qoq"] > 1:
                pts += 0.5; reasons.append(("+", "營益率季增 %.1f 個百分點，本業獲利能力提升" % om["qoq"]))
            elif om["qoq"] < -1:
                pts -= 0.5; reasons.append(("-", "營益率季減 %.1f 個百分點" % -om["qoq"]))
    posn = sum(1 for n in news if n["tone"] == "正面")
    negn = sum(1 for n in news if n["tone"] == "負面")
    if posn + negn:
        bal = (posn - negn) / (posn + negn)
        pts += bal
        reasons.append(("+" if bal > 0.2 else "-" if bal < -0.2 else "·",
                        "可信新聞語氣：正面 %d 則、負面 %d 則" % (posn, negn)))
    cat_cnt = {}
    for n in news:
        for c in n["cats"]:
            cat_cnt[c] = cat_cnt.get(c, 0) + 1
    score = max(1, min(5, round(3 + pts)))
    label = {5: "很強", 4: "偏強", 3: "中性", 2: "偏弱", 1: "很弱"}[score]
    return {"score": score, "label": label, "reasons": reasons,
            "topics": sorted(cat_cnt.items(), key=lambda x: -x[1])[:5],
            "highlights": [n["title"] for n in news if n["important"]][:5]}
