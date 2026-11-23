# %% [markdown]
# # 85 · 断线可续（检查点 + 续跑台账）
# 先说清楚：**没有哪段代码能延长官方给的时长**。免费实例的时长是按同时段需求动态给的
# （现在常见 5 小时上下），到点就回收。能优化的是「断了之后恢复要多久」：
#   1) 模型缓存放 Drive → 重连不用重下（00_env 已做）
#   2) 产物实时落 Drive → 断线不丢成片（各 cell 的 OUT 已指向 Drive）
#   3) 这一格维护一份 tasks.jsonl：跑完一条记一条，重连后只补没跑完的。
# 另外：**后台进程写文件不算「有活动」**，别指望它骗过闲置判定；真要长跑就保持标签页在前台。

# %%
import json, os, time
from pathlib import Path

BASE = Path(os.environ.get("CK_BASE", "/content/colabkit"))
TASKS = BASE / "tasks.jsonl"
TASKS.parent.mkdir(parents=True, exist_ok=True)

def done_keys():
    if not TASKS.exists():
        return set()
    keys = set()
    for line in TASKS.read_text(encoding="utf-8").splitlines():
        try:
            r = json.loads(line)
            if r.get("status") == "done":
                keys.add(r["key"])
        except Exception:
            pass
    return keys

def mark(key, status="done", **extra):
    row = {"key": key, "status": status, "at": time.strftime("%Y-%m-%dT%H:%M:%S"), **extra}
    with open(TASKS, "a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")
    print("·", row["key"], row["status"])
    return row

def pending(all_keys):
    d = done_keys()
    return [k for k in all_keys if k not in d]

def resume_plan(all_keys):
    p = pending(all_keys)
    print(f"总共 {len(all_keys)} 条，已完成 {len(all_keys)-len(p)}，待跑 {len(p)}")
    for k in p:
        print("  待跑:", k)
    return p

# %%
# 用法：把你要跑的活写成带唯一 key 的列表，重连后只补剩下的
JOBS = [
    # ("v1", "雨夜便利店 + 橘猫"),
    # ("v2", "太空电梯上升镜头"),
]
if JOBS:
    todo = resume_plan([k for k, _ in JOBS])
    for key, prompt in JOBS:
        if key not in todo:
            continue
        try:
            # row = make_video(prompt, preset="standard", name=key)   # ← 在这里调 10/20/30 里的函数
            mark(key, "done", prompt=prompt)
        except Exception as e:
            mark(key, "failed", prompt=prompt, error=str(e)[:300])
else:
    print("（JOBS 为空：先把要跑的活填进去）")
