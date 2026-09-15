#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import os, sys, urllib.parse, urllib.error, uuid, subprocess, signal, time, json, urllib.request, hashlib

BASE = os.environ.get("DOCUMENT_ROOT", os.path.dirname(os.path.abspath(__file__)))
LIB  = os.path.join(BASE, "lib")
sys.path.insert(0, LIB)

qs     = os.environ.get("QUERY_STRING", "")
params = dict(urllib.parse.parse_qsl(qs))
act    = params.get("act", "")

PWD_FILE = os.path.join(BASE, ".pwd")
APP_PY   = os.path.join(BASE, "app.py")
CFG_FILE = os.path.join(BASE, "config.yml")
PGREP_KW = APP_PY


def _hash(pwd: str) -> str:
    return hashlib.sha256(pwd.encode()).hexdigest()


def _find_pids():
    r = subprocess.run(["pgrep", "-f", PGREP_KW], capture_output=True, text=True)
    return [p for p in r.stdout.strip().split() if p]


# ── .pwd 文件读写 ───────────────────────────────────────────
# 格式（严格两行）：
#   第 1 行：sha256(密码)
#   第 2 行：随机 token (uuid4 hex)
# 文件权限 600，仅本站可读。

def _read_pwd_file():
    """返回 (pwd_hash, token)；文件不存在或格式不完整返回 (None, None)。
    格式要求严格两行，缺一行视为未设置。"""
    if not os.path.isfile(PWD_FILE):
        return None, None
    try:
        lines = open(PWD_FILE, encoding="utf-8").read().splitlines()
        if len(lines) < 2:
            return None, None
        pwd_hash = lines[0].strip()
        token    = lines[1].strip()
        if not pwd_hash or not token:
            return None, None
        return pwd_hash, token
    except Exception:
        return None, None


def _write_pwd_file(pwd_hash: str, token: str):
    """原子写：先写临时文件再 rename，防止并发写坏。"""
    tmp = PWD_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(f"{pwd_hash}\n{token}\n")
    try:
        os.chmod(tmp, 0o600)
    except Exception:
        pass
    os.replace(tmp, PWD_FILE)


# ── 密码 / Token 相关 ───────────────────────────────────────

def do_haspwd():
    pwd_hash, _ = _read_pwd_file()
    return "1" if pwd_hash else "0"


def do_setpwd():
    pwd = params.get("pwd", "").strip()
    if not pwd:
        return "❌ 密码不能为空"
    if len(pwd) < 6:
        return "❌ 密码至少6位"

    pwd_hash, _ = _read_pwd_file()
    if pwd_hash:
        return "❌ 密码已设置，请使用修改密码功能"

    token = uuid.uuid4().hex
    _write_pwd_file(_hash(pwd), token)
    # 返回格式：✅ <token>
    return f"✅ {token}"


def do_checkpwd():
    """明文密码校验。成功时返回当前 token。"""
    pwd = params.get("pwd", "").strip()
    if not pwd:
        return "❌"
    pwd_hash, token = _read_pwd_file()
    if not pwd_hash:
        return "❌ 未设置密码"
    if pwd_hash != _hash(pwd):
        return "❌"
    return f"✅ {token}"


def do_checktoken():
    """token 校验（刷新时用）。只比对 token，不接触密码。"""
    tok = params.get("token", "").strip()
    if not tok:
        return "❌"
    _, token = _read_pwd_file()
    if not token:
        return "❌ 未设置 token"
    return "✅" if token == tok else "❌"


def do_changepwd():
    old = params.get("old", "").strip()
    new = params.get("new", "").strip()
    if not old or not new:
        return "❌ 参数不完整"
    if len(new) < 6:
        return "❌ 新密码至少6位"

    pwd_hash, _ = _read_pwd_file()
    if not pwd_hash:
        return "❌ 未设置密码"
    if pwd_hash != _hash(old):
        return "❌ 旧密码错误"

    # 换密码 → 同时轮换 token（旧 token 立即失效）
    new_token = uuid.uuid4().hex
    _write_pwd_file(_hash(new), new_token)
    return f"✅ {new_token}"


# ── 配置相关 ────────────────────────────────────────────────

def do_saveconfig():
    server    = params.get("server", "").strip()
    secret    = params.get("secret", "").strip()
    uid       = params.get("uuid",   "").strip() or str(uuid.uuid4())
    delay     = params.get("report_delay", "4").strip() or "4"
    silent    = params.get("silent", "false").strip().lower()
    keepalive = params.get("keepalive", "").strip().rstrip("/")

    if silent not in ("true", "false"):
        silent = "false"
    if not server:
        return "❌ Server 不能为空"
    if not secret:
        return "❌ Client Secret 不能为空"

    content = (
        f'server: "{server}"\n'
        f'client_secret: "{secret}"\n'
        f'uuid: "{uid}"\n'
        f'report_delay: {delay}\n'
        f'silent: {silent}\n'
    )
    if keepalive:
        content += f'keepalive: "{keepalive}"\n'

    with open(CFG_FILE, "w") as f:
        f.write(content)
    return "✅ config.yml 已保存\n\n" + content


def do_install():
    r = subprocess.run(
        [sys.executable, os.path.join(BASE, "install_helper.py")],
        capture_output=True, text=True,
        env={**os.environ, "DOCUMENT_ROOT": BASE},
        cwd=BASE,
    )
    return (r.stdout or "") + (r.stderr or "")


def do_restart():
    out = []
    log_path = os.path.join(BASE, "app_run.log")

    for pid in _find_pids():
        try:
            os.kill(int(pid), signal.SIGTERM)
            out.append(f"已停止 PID: {pid}")
        except Exception as e:
            out.append(f"停止失败: {e}")
    time.sleep(1)
    for pid in _find_pids():
        try:
            os.kill(int(pid), signal.SIGKILL)
            out.append(f"强制终止 PID: {pid}")
        except Exception:
            pass
    time.sleep(1)

    open(log_path, "w").close()
    log = open(log_path, "w")
    p = subprocess.Popen(
        [sys.executable, APP_PY],
        stdout=log, stderr=log,
        stdin=subprocess.DEVNULL,
        cwd=BASE,
        start_new_session=True,
        close_fds=True,
    )
    time.sleep(5)
    log.flush()
    log.close()
    ret = p.poll()
    out.append(f"PID: {p.pid}")
    out.append("状态: 运行中 ✓" if ret is None else f"已退出: {ret}")
    out.append("--- LOG ---")
    try:
        out.append(open(log_path).read())
    except Exception:
        pass
    return "\n".join(out)


def do_stop():
    pids = _find_pids()
    if not pids:
        return "没有运行中的进程"
    out = []
    for pid in pids:
        try:
            os.kill(int(pid), signal.SIGTERM)
            out.append(f"✅ 已停止 PID: {pid}")
        except Exception as e:
            out.append(f"❌ 停止失败 {pid}: {e}")
    time.sleep(1)
    for pid in _find_pids():
        try:
            os.kill(int(pid), signal.SIGKILL)
            out.append(f"🔴 强制终止 PID: {pid}")
        except Exception:
            pass
    out.append("✅ 进程已完全停止")
    return "\n".join(out)


def do_update():
    out  = []
    dest = os.path.join(BASE, "main.so")
    try:
        os.remove(dest)
        out.append("🗑 旧 main.so 已删除")
    except Exception as e:
        out.append(f"删除: {e}")
    try:
        with urllib.request.urlopen(
            "https://api.github.com/repos/oyz8/agent-v1-so/releases/latest",
            timeout=15
        ) as resp:
            tag = json.loads(resp.read())["tag_name"]
        out.append(f"Tag: {tag}")
    except Exception as e:
        return f"❌ 获取 Tag 失败: {e}"
    arch = "amd64" if os.uname().machine in ("x86_64", "amd64") else "arm64"
    py   = f"{sys.version_info.major}.{sys.version_info.minor}"
    url  = (f"https://github.com/oyz8/agent-v1-so/releases/download"
            f"/{tag}/main-{py}-{arch}.so")
    out.append(f"下载: {url}")
    try:
        urllib.request.urlretrieve(url, dest)
        out.append(f"✅ 完成，大小: {os.path.getsize(dest):,} bytes")
        out.append("请点击 [▶ 启动/重启]")
    except Exception as e:
        out.append(f"❌ 下载失败: {e}")
    return "\n".join(out)


# ── 保活注册（自建端点，从 config.yml 读取）────────────────
KEEPALIVE_FILE = os.path.join(BASE, ".keepalive")

# 用真实浏览器 UA，绕过 Cloudflare / 免费空间 WAF 对 Python-urllib 的拦截
_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
       "AppleWebKit/537.36 (KHTML, like Gecko) "
       "Chrome/120.0.0.0 Safari/537.36")


def _get_keepalive_endpoint():
    """从 config.yml 的 keepalive: 一行读取自建保活地址。
    自动补 /add-url 后缀；未配置返回空字符串。"""
    if not os.path.isfile(CFG_FILE):
        return ""
    try:
        for line in open(CFG_FILE, encoding="utf-8"):
            s = line.strip()
            if s.startswith("keepalive:"):
                v = s.split(":", 1)[1].strip().strip('"').strip("'").rstrip("/")
                if not v:
                    return ""
                return v if v.endswith("/add-url") else v + "/add-url"
    except Exception:
        pass
    return ""


def _site_url():
    host = (os.environ.get("HTTP_HOST")
            or os.environ.get("SERVER_NAME")
            or "").strip()
    host = host.split(",")[0].strip()

    if host:
        fwd = (os.environ.get("HTTP_X_FORWARDED_PROTO") or "").split(",")[0].strip().lower()
        if fwd in ("http", "https"):
            proto = fwd
        elif os.environ.get("HTTPS", "").lower() in ("on", "1", "yes"):
            proto = "https"
        else:
            proto = "http"
        return f"{proto}://{host}"

    url = (params.get("url") or "").strip().rstrip("/")
    if url.startswith(("http://", "https://")):
        return url
    return None


def _keepalive_http(endpoint, url):
    """返回 (ok:bool, info:str)。优先 urllib，失败回退 curl。"""
    payload = json.dumps({"url": url}).encode("utf-8")
    origin  = endpoint.rsplit("/add-url", 1)[0]

    headers = {
        "Content-Type":    "application/json",
        "Accept":          "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
        "User-Agent":      _UA,
        "Origin":          origin,
        "Referer":         origin + "/",
        "Cache-Control":   "no-cache",
        "Pragma":          "no-cache",
    }

    errs = []

    # ── 方案 A：urllib ──
    try:
        req = urllib.request.Request(endpoint, data=payload,
                                     headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=15) as r:
            code = r.status
            body = r.read(500).decode("utf-8", "replace")
        return True, f"HTTP {code} {body.strip()[:200]}"
    except urllib.error.HTTPError as e:
        errs.append(f"urllib HTTP {e.code}: {e.reason}")
    except Exception as e:
        errs.append(f"urllib {type(e).__name__}: {e}")
        if isinstance(e, urllib.error.URLError) and \
           ("Name or service not known" in str(e) or
            "Temporary failure in name resolution" in str(e) or
            "Connection refused" in str(e)):
            return False, " | ".join(errs)

    # ── 方案 B：curl 兜底（部分免费空间对 urllib 有限制，curl 反而通）──
    try:
        r = subprocess.run(
            ["curl", "-sS", "--max-time", "15",
             "-X", "POST", endpoint,
             "-H", "Content-Type: application/json",
             "-H", f"User-Agent: {_UA}",
             "-H", f"Origin: {origin}",
             "-H", f"Referer: {origin}/",
             "-d", json.dumps({"url": url})],
            capture_output=True, text=True, timeout=20,
        )
        body = (r.stdout or "").strip()
        if r.returncode == 0 and body:
            return True, f"curl rc=0 {body[:200]}"
        errs.append(f"curl rc={r.returncode} out={body[:120]} err={(r.stderr or '')[:120]}")
    except Exception as e:
        errs.append(f"curl {type(e).__name__}: {e}")

    return False, " | ".join(errs)


def do_visit():
    base = _site_url()
    if not base:
        return "⚠ 无法获取域名，跳过保活注册"

    endpoint = _get_keepalive_endpoint()
    if not endpoint:
        return ("❌ 未配置保活地址，请在配置中填写 keepalive\n"
                "   例如: https://你的域名.workers.dev")

    url = base.rstrip("/") + "/manage_action.shtml?act=autostart"

    ok, info = _keepalive_http(endpoint, url)

    if ok:
        try:
            with open(KEEPALIVE_FILE, "w") as f:
                f.write(f"{int(time.time())}\t{url}\t{endpoint}\t{info}\n")
        except Exception:
            pass
        return (f"✅ 保活注册成功: {info}\n"
                f"端点: {endpoint}\n"
                f"注册地址: {url}")

    # 失败时给出可诊断的信息
    return (f"❌ 保活注册失败\n"
            f"端点: {endpoint}\n"
            f"错误: {info}")


def do_autostart():
    pids = _find_pids()
    if pids:
        return f"OK 运行中 PID: {','.join(pids)}"

    if not os.path.isfile(APP_PY):
        return "❌ app.py 不存在，无法拉起"
    if not os.path.isfile(CFG_FILE):
        return "❌ config.yml 不存在，无法拉起"

    log_path = os.path.join(BASE, "app_run.log")
    try:
        log = open(log_path, "a")
        p = subprocess.Popen(
            [sys.executable, APP_PY],
            stdout=log, stderr=log,
            stdin=subprocess.DEVNULL,
            cwd=BASE,
            start_new_session=True,
            close_fds=True,
        )
        time.sleep(3)
        log.flush()
        log.close()
        ret = p.poll()
        if ret is None:
            return f"✅ 已自动拉起 PID: {p.pid}"
        return f"❌ 拉起后立即退出，返回码: {ret}"
    except Exception as e:
        return f"❌ 拉起异常: {e}"


def do_status():
    out = []
    out.append("=== 进程 ===")
    pids = _find_pids()
    if pids:
        r = subprocess.run(
            ["ps", "-p", ",".join(pids), "-o", "pid,etime,cmd"],
            capture_output=True, text=True
        )
        out.append(r.stdout)
    else:
        out.append("未运行")
    out.append("=== 文件 ===")
    for fn in ["main.so", "app.py", "config.yml"]:
        fp = os.path.join(BASE, fn)
        if os.path.isfile(fp):
            out.append(f"  {fn}: {os.path.getsize(fp):,} bytes")
        else:
            out.append(f"  {fn}: 不存在")
    out.append("\n=== config.yml ===")
    try:
        out.append(open(CFG_FILE).read())
    except Exception:
        out.append("不存在")
    out.append("=== 保活端点 ===")
    ep = _get_keepalive_endpoint()
    out.append(ep if ep else "未配置 (config.yml 缺少 keepalive)")
    out.append("=== 保活记录 ===")
    try:
        out.append(open(KEEPALIVE_FILE).read().strip() or "无")
    except Exception:
        out.append("无")
    out.append("=== 最新日志 ===")
    try:
        lines = open(os.path.join(BASE, "app_run.log")).readlines()
        out.append("".join(lines[-60:]))
    except Exception:
        out.append("无日志")
    return "\n".join(out)


# ── 路由 ────────────────────────────────────────────────────
ACTIONS = {
    "haspwd":     do_haspwd,
    "setpwd":     do_setpwd,
    "checkpwd":   do_checkpwd,
    "checktoken": do_checktoken,
    "changepwd":  do_changepwd,
    "saveconfig": do_saveconfig,
    "install":    do_install,
    "restart":    do_restart,
    "stop":       do_stop,
    "update":     do_update,
    "status":     do_status,
    "visit":      do_visit,
    "autostart":  do_autostart,
}

if act in ACTIONS:
    try:
        print(ACTIONS[act](), end="")
    except Exception as e:
        print(f"❌ 异常: {e}", end="")
else:
    print("", end="")