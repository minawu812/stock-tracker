"""Web Push 通知（iPhone 主畫面 App、Mac 瀏覽器皆可收到）。"""
import json
import os
import subprocess
import sys


def send_all(subs, messages, vapid_private, subject):
    """subs: [{endpoint, keys:{p256dh, auth}}]；回傳仍有效的訂閱。"""
    if not messages:
        return subs
    if not subs or not vapid_private:
        print("[notify] 無訂閱或未設定 VAPID 金鑰，略過推播 %d 則" % len(messages))
        return subs
    from pywebpush import WebPushException, webpush
    alive = []
    for s in subs:
        ok = True
        for m in messages:
            try:
                webpush(subscription_info={"endpoint": s["endpoint"], "keys": s["keys"]},
                        data=json.dumps(m, ensure_ascii=False), vapid_private_key=vapid_private,
                        vapid_claims={"sub": subject}, ttl=86400)
            except WebPushException as e:
                code = getattr(e.response, "status_code", None)
                print("[notify] 推播失敗 %s %s" % (code, e))
                if code in (404, 410):
                    ok = False
                    break
        if ok:
            alive.append(s)
    print("[notify] 已推播 %d 則到 %d 個裝置" % (len(messages), len(alive)))
    return alive


def mac_local(messages):
    """在本機 Mac 執行時，同時跳出系統通知。"""
    if sys.platform != "darwin" or os.environ.get("CI"):
        return
    for m in messages[:5]:
        script = 'display notification %s with title %s' % (json.dumps(m["body"]), json.dumps(m["title"]))
        subprocess.run(["osascript", "-e", script], check=False)
