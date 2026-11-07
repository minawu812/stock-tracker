# 持股雷達

台股持股追蹤 App（網頁型，可加入 iPhone 主畫面）。全部使用免費服務。

## 功能
| 功能 | 說明 | 更新時間 |
|---|---|---|
| 每日行情 | 開、高、低、收、成交量（FinMind 開放資料＋證交所） | 週一～五 15:30 |
| 技術分析與警示 | 5/10/20/60 日均線、MACD、KD、頭頭高底底高型態；停損（前低或 -8%）、獲利中跌破均線、帶量突破、多頭回測月線 | 盤後 |
| 新聞 | Google 新聞中只保留可信財經媒體，排除聳動和宣傳標題，標記重要性與正負面 | 每 12 小時（08:00、20:00） |
| 競爭力評估 | 綜合月營收年增、毛利率與營益率變化、新聞語氣，給 1～5 分 | 同上 |
| 財報比較 | 最新一季對上一季、對去年同季的漲跌 %（利潤率以百分點表示），判斷進步或退步 | 財報公布後 |
| EPS 本益比 | 近四季 EPS、本益比河流、合理價區間 | 每次更新 |
| 事件提醒 | 財報截止日、除權息日，前 7 天和前 1 天推播 | 每次更新 |

## 架構
- `backend/`：Python 分析程式，由 GitHub Actions 定時執行（`.github/workflows/update.yml`）
- `docs/`：App 前端，透過 GitHub Pages 發布
- `config/*.enc`、`docs/data/report.enc`：用你的 App 密碼加密（AES-256），公開的 repo 也看不到內容

## 本機執行
```bash
pip3 install --user -r requirements.txt
python3 backend/setup_local.py          # 第一次：設定密碼、建立持股檔與推播金鑰
APP_PASSWORD=你的密碼 python3 backend/main.py
cd docs && python3 -m http.server 8765  # 瀏覽器開 http://localhost:8765
```

## GitHub Secrets
| 名稱 | 內容 |
|---|---|
| `APP_PASSWORD` | App 密碼 |
| `VAPID_PRIVATE_KEY` | `.secrets/vapid.json` 裡的 `private` |
| `VAPID_SUBJECT` | `mailto:你的email` |
| `FINMIND_TOKEN` | （選填）FinMind 免費會員 token |

技術與估值分析僅供參考，不構成投資建議。
