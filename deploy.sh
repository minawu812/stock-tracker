#!/bin/bash
# 一鍵上線：建立 GitHub 專案、設定密碼與推播金鑰、開啟網站
set -e
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$PATH"
OWNER=minawu812
REPO="$OWNER/stock-tracker"

gh auth status >/dev/null 2>&1 || { echo "請先執行：gh auth login -s workflow"; exit 1; }

echo "== 設定 App 密碼（輸入時畫面不會顯示，至少 8 碼）"
while true; do
  read -r -s -p "密碼：" PW; echo
  read -r -s -p "再輸入一次：" PW2; echo
  [ "$PW" = "$PW2" ] && [ ${#PW} -ge 8 ] && break
  echo "兩次不一致或少於 8 碼，請重新輸入"
done
read -r -p "通知用 Email（可直接 Enter 略過）：" MAIL
MAIL=${MAIL:-$OWNER@users.noreply.github.com}

echo "== 建立加密持股檔與推播金鑰"
APP_PASSWORD="$PW" GITHUB_REPO="$REPO" python3 backend/setup_local.py
echo "== 第一次分析（約 1 分鐘）"
APP_PASSWORD="$PW" python3 backend/main.py 2>&1 | grep -v -i warning | tail -5

echo "== 上傳到 GitHub"
[ -d .git ] || git init -q -b main
git add -A
git -c user.name="$OWNER" -c user.email="$OWNER@users.noreply.github.com" commit -q -m "持股雷達初版

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" || true
if ! gh repo view "$REPO" >/dev/null 2>&1; then
  gh repo create "$REPO" --public --source . --remote origin --push \
    --description "持股雷達：台股持股分析與警示（資料已加密）"
else
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$REPO.git"
  git push -u origin main
fi

echo "== 設定雲端密碼（GitHub Secrets）"
gh secret set APP_PASSWORD -R "$REPO" --body "$PW"
gh secret set VAPID_PRIVATE_KEY -R "$REPO" --body "$(python3 -c 'import json;print(json.load(open(".secrets/vapid.json"))["private"])')"
gh secret set VAPID_SUBJECT -R "$REPO" --body "mailto:$MAIL"

echo "== 開啟網站（GitHub Pages）"
gh api -X POST "repos/$REPO/pages" -f build_type=workflow >/dev/null 2>&1 || \
  gh api -X PUT "repos/$REPO/pages" -f build_type=workflow >/dev/null
sleep 3
gh workflow run update.yml -R "$REPO"

echo
echo "✅ 完成！約 3 分鐘後可開啟：https://$OWNER.github.io/stock-tracker/"
echo "   進度可看：https://github.com/$REPO/actions"
