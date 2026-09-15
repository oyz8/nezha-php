# 扎针面板 + URL 保活监控

一套 扎针面板 + URL 保活监控处理方案。部署在免费虚拟主机上的管理面板，配合 Cloudflare Worker 定时检查目标 URL，自动处理 ByetHost 等主机的 `aes.js` 挑战。

# ⭐ **觉得有用？给个 Star 支持一下！**

```
.
├── htdocs/                      # 虚拟主机面板
│   ├── .htaccess                # SSI 配置
│   ├── install_helper.py        # 环境初始化
│   ├── manage.shtml             # 面板 UI
│   ├── manage_action.py         # 后端逻辑
│   └── manage_action.shtml      # SSI 入口
├── Keepalive/                   # Cloudflare Worker
│   ├── _worker.js
│   └── wrangler.toml
└── README.md
```

---

## 一、虚拟主机面板部署（htdocs/）

支持 SSI + Python 的虚拟主机：

- [HyperPHP](https://hyperphp.com/)
- [Byet.Host](https://byet.host/)
- [InfinityFree](https://www.infinityfree.com/)
- [ProFreeHost](https://profreehost.com/)

**步骤：**

1. 把 `htdocs/` 下 5 个文件上传到主机的 `htdocs/` 或 `public_html/`
2. 访问 `https://你的域名/manage.shtml`
3. 首次访问设置管理密码
4. 填写 Nezha 探针配置 → 点「安装/更新依赖」→ 点「▶ 启动/重启」

---

## 二、Cloudflare Worker 部署（保活系统）

### 1. 创建 Worker

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)，左侧导航进入 **Workers & Pages**
2. 点击 **Create application** → **Create Worker** → **Deploy**
3. 起个名字（比如 `cf-keepalive`），点击 **Deploy**
4. 部署完成后，点击 **Edit code** 进入在线编辑器

### 2. 创建 D1 数据库

1. 左侧导航进入 **Workers & Pages** → **D1**
2. 点击 **Create database**
3. 数据库名称填 `cf-keepalive`，点击 **Create**

### 3. 将 D1 绑定到 Worker

1. 回到 Worker 详情页，点击 **Settings** → **Variables and Secrets**
2. 找到 **D1 Database Bindings**，点击 **Add binding**
3. **Variable name** 填 `DB`（必须和代码里的 `env.DB` 一致）
4. **D1 database** 选择刚才创建的 `cf-keepalive`
5. 点击 **Save**

### 4. 设置管理密码

1. 在同一个 **Variables and Secrets** 页面，找到 **Environment Variables**
2. 点击 **Add**，**Type** 选 **Secret**
3. **Variable name** 填 `ADMIN_PASSWORD`
4. **Value** 填你想设置的密码
5. 点击 **Save**

> 选 **Secret** 而不是 **Text**，密码就不会以明文显示在 Dashboard 里。

### 5. 粘贴 Worker 代码

1. 回到 Worker 详情页，点击 **Edit code**（或 **Quick Edit**）
2. 把编辑器里默认的模板代码**全部删除**，粘贴 `Keepalive/_worker.js` 的完整代码
3. 点击右上角 **Save and Deploy**

### 6. 设置 Cron 触发器

1. 在 Worker 详情页，点击 **Settings** → **Triggers**
2. 找到 **Cron Triggers**，点击 **Add Cron Trigger**
3. 填入 `* * * * *`（每分钟触发一次）
4. 点击 **Save**

> Cron 基于 UTC 时间，5 个字段：分钟、小时、日、月、星期。

### 7. 绑定自定义域名（必须）

> ⚠️ **重要**：`workers.dev` 域名在` 虚拟主机网络` 无法访问，**必须绑定自定义域名才能正常使用**。

**前置条件：** 你有一个已托管在 Cloudflare 的域名（免费域名也可以）。

**步骤：**

1. 在 Worker 详情页，点击 **Settings** → **Domains & Routes**
2. 点击 **Add** → **Custom Domain**
3. 填入你想用的子域名，比如 `keep.yourdomain.com`
4. 点击 **Add Domain**
5. Cloudflare 会自动创建 DNS 记录并签发 SSL 证书（等待 1~2 分钟）

绑定完成后，访问 `https://keep.yourdomain.com` 就能打开管理面板。

**验证：**

```bash
curl -X POST "https://keep.yourdomain.com/add-url" \
  -H "Content-Type: application/json" \
  -d '{"url":"http://keep.byethost5.com/manage_action.shtml?act=autostart"}'
```

返回 `{"success": true}` 说明域名绑定成功。

### 8. 验证部署

浏览器打开你绑定的域名（如 `https://keep.yourdomain.com`），输入第 4 步设置的密码登录。看到保活监控面板即为成功。

---

**⚠️ 免责声明**：本脚本仅供学习与自动化运维研究，使用者须遵守
[HyperPHP](https://hyperphp.com/)、[Byet.Host](https://byet.host/)、[InfinityFree](https://www.infinityfree.com/)、[ProFreeHost](https://profreehost.com/) 的服务条款。因使用本脚本导致的账号限制或其他问题，作者不承担任何责任。