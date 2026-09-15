#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import sys, os, json, subprocess, urllib.request, uuid
sys.stdout.reconfigure(line_buffering=True)

BASE   = os.environ.get("DOCUMENT_ROOT") or os.path.dirname(os.path.abspath(__file__))
LIB    = os.path.join(BASE, "lib")
PYTHON = sys.executable
os.makedirs(LIB, exist_ok=True)

print(f"Base:   {BASE}")
print(f"Lib:    {LIB}")
print(f"Python: {sys.version}")
print(f"Exec:   {PYTHON}")

# ── 1. 确保 pip 可用 ────────────────────────────────────────
print("\n--- 检查 pip ---")
pip_bin = os.path.join(BASE, "~/.local/bin/pip3.12")

if not os.path.isfile(pip_bin):
    print("pip 不存在，下载 get-pip.py ...")
    get_pip = os.path.join(BASE, "get-pip.py")
    try:
        urllib.request.urlretrieve("https://bootstrap.pypa.io/get-pip.py", get_pip)
        r = subprocess.run([PYTHON, get_pip, "--user"], capture_output=True, text=True)
        print(r.stdout or "")
        print(r.stderr or "")
        if r.returncode != 0:
            print(f"pip 安装失败 returncode={r.returncode}")
            sys.exit(1)
        print("pip 安装完成")
    except Exception as e:
        print(f"pip 安装异常: {e}")
        sys.exit(1)
else:
    print(f"pip 已存在: {pip_bin}")

# ── 2. 安装依赖到 lib/ ──────────────────────────────────────
print("\n--- 安装依赖 ---")
pkgs = ["grpcio", "grpcio-tools", "protobuf", "pyyaml", "psutil", "aiohttp"]

sys.path.insert(0, LIB)
missing = []
for pkg, imp in [
    ("grpcio","grpc"), ("grpcio-tools","grpc_tools"),
    ("protobuf","google.protobuf"), ("pyyaml","yaml"),
    ("psutil","psutil"), ("aiohttp","aiohttp"),
]:
    try:
        __import__(imp)
    except ImportError:
        missing.append(pkg)

if not missing:
    print("依赖已全部就绪，跳过安装")
else:
    print(f"缺少: {missing}")
    r = subprocess.run(
        [pip_bin, "install", *pkgs, f"--target={LIB}"],
        capture_output=True, text=True
    )
    print(r.stdout[-3000:] if r.stdout else "")
    if r.stderr:
        print("[stderr]", r.stderr[-500:])
    if r.returncode != 0:
        print(f"依赖安装失败 returncode={r.returncode}")
        sys.exit(1)
    print("依赖安装成功")

# ── 3. 验证依赖 ─────────────────────────────────────────────
print("\n--- 验证依赖 ---")
for pkg, imp in [
    ("grpcio","grpc"), ("grpcio-tools","grpc_tools"),
    ("pyyaml","yaml"), ("psutil","psutil"), ("aiohttp","aiohttp"),
]:
    try:
        __import__(imp)
        print(f"  {pkg} OK")
    except ImportError as e:
        print(f"  {pkg} MISSING: {e}")

# ── 4. 获取最新 Release Tag ─────────────────────────────────
print("\n--- 获取最新 Release ---")
try:
    with urllib.request.urlopen(
        "https://api.github.com/repos/oyz8/agent-v1-so/releases/latest",
        timeout=15
    ) as resp:
        tag = json.loads(resp.read())["tag_name"]
    print(f"Tag: {tag}")
except Exception as e:
    print(f"获取 Tag 失败: {e}")
    sys.exit(1)

# ── 5. 下载 main.so ─────────────────────────────────────────
print("\n--- 下载 main.so ---")
arch = "amd64" if os.uname().machine in ("x86_64", "amd64") else "arm64"
py   = f"{sys.version_info.major}.{sys.version_info.minor}"
url  = f"https://github.com/oyz8/agent-v1-so/releases/download/{tag}/main-{py}-{arch}.so"
dest = os.path.join(BASE, "main.so")
print(f"URL:  {url}")

if os.path.isfile(dest) and os.path.getsize(dest) > 100000:
    print(f"main.so 已存在 ({os.path.getsize(dest):,} bytes)，跳过")
else:
    try:
        urllib.request.urlretrieve(url, dest)
        print(f"main.so 下载完成，大小: {os.path.getsize(dest):,} bytes")
    except Exception as e:
        print(f"main.so 下载失败: {e}")
        sys.exit(1)

# ── 6. 生成 app.py ──────────────────────────────────────────
print("\n--- 检查 app.py ---")
app_py = os.path.join(BASE, "app.py")
if not os.path.isfile(app_py):
    with open(app_py, "w") as f:
        f.write('''\
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import sys, os

_base = os.path.dirname(os.path.abspath(__file__))
_lib  = os.path.join(_base, "lib")

for _p in (_lib, _base):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from main import WorkerApp

if __name__ == "__main__":
    import logging
    logging.basicConfig(
        level=logging.DEBUG if os.environ.get("DEBUG","").lower() == "true"
              else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    app = WorkerApp(config_path=os.path.join(_base, "config.yml"))
    sys.exit(app.run())
''')
    print("app.py 已生成")
else:
    print("app.py 已存在")

# ── 7. 生成 config.yml（如不存在）──────────────────────────
print("\n--- 检查 config.yml ---")
cfg = os.path.join(BASE, "config.yml")
if not os.path.isfile(cfg):
    with open(cfg, "w") as f:
        f.write(f'''\
server: ""
client_secret: ""
uuid: "{uuid.uuid4()}"
report_delay: 4
silent: false
keepalive: ""
''')
    print("config.yml 已生成，请在管理面板填写 server / client_secret / keepalive")
else:
    print("config.yml 已存在")

print("\n=== ALL DONE ===")
print("下一步: 在管理面板填写配置，然后点击 [启动/重启]")