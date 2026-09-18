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

> ⚠️ **重要**：`workers.dev` 域名在`虚拟主机网络`无法访问，**必须绑定自定义域名才能正常使用**。

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

## 三、失败处理与状态管理

Worker 对每条 URL 的状态维护如下：

| 状态 | 触发条件 | 表现 | 恢复方式 |
|------|---------|------|---------|
| 正常 | 上次检查成功 | 绿色「正常」徽标 | — |
| 失败 N | 检查失败，未达 5 次 | 红色「失败 N」徽标 | 下次检查成功自动清零 |
| **自动禁用** | 连续失败 5 次 | 橙色「自动禁用」徽标 | **30 分钟后自动重试**，成功即恢复；失败则重置计时 |
| **手动禁用** | 用户主动点「禁用」 | 橙色「手动禁用」徽标 | 需手动点「启用」，**永不自动恢复** |
| 未检查 | 刚添加，从未访问 | 灰色「未检查」徽标 | 首次检查后自动更新 |

**关键行为：**

- **自动禁用**：失败 5 次后进入，等待 30 分钟自动重试一次。成功则恢复正常检查；失败则刷新计时，再等 30 分钟。
- **手动禁用**：状态徽标会注明「手动禁用」，Cron 完全跳过该 URL，不会自动重试。
- **手动检查**：无论 URL 处于何种状态，点「检查」按钮都会立即访问一次。若成功，自动解除禁用（含自动和手动禁用）。

**公开接口调用：**

```bash
curl -X POST "https://keep.yourdomain.com/add-url" \
  -H "Content-Type: application/json" \
  -d '{"url":"http://keep.byethost5.com/manage_action.shtml?act=autostart"}'
```

**受保护接口调用：**

```bash
curl -H "X-Auth-Token: 你的密码" \
  "https://keep.yourdomain.com/api/state"
```

---

## 五、保活原理

```
1. 面板点「安装/更新依赖」→ 下载 main.so
2. 面板点「启动/重启」 → 运行 app.py 进程
3. 面板点「注册保活」 → 向 CF Worker 注册 autostart 端点
4. CF Worker Cron 每分钟访问该端点：
   - 进程在跑   → 返回 "OK 运行中 PID: xxx"
   - 进程挂了   → 自动拉起，返回 "✅ 已自动拉起 PID: xxx"
```

**ByetHost 挑战处理：**

目标返回 `aes.js` 挑战页时，Worker 自动处理：

1. **第一次请求**：获取挑战页，解析出 `a/b/c` 三个参数
2. **解密**：AES-128-CBC，**key = a，iv = b**，无 PKCS#7 padding
3. **第二次请求**：带上 `Cookie: __test=<解密结果>` 访问 `?i=1` 的 URL

> **为什么用 `node:crypto`**：Web Crypto 的 AES-CBC 强制 PKCS#7 padding 校验，ByetHost 的密文最后一字节不合法，会直接报错。Node 的 `createDecipheriv` + `setAutoPadding(false)` 才能正确解密。

---

## 六、常见问题

**Q: URL 被自动禁用了怎么办？**
等 30 分钟，Cron 会自动重试一次。或者手动点「检查」立即重试。成功后自动恢复。

**Q: 手动禁用后会不会被自动恢复？**
不会。手动禁用的 URL 永远不会被 Cron 自动检查，必须手动点「启用」才能恢复。

**Q: 为什么必须绑定自定义域名？**
`workers.dev` 域名在虚拟主机网络、部分企业网络、教育网等环境下无法访问。绑定了自定义域名（走 Cloudflare 边缘节点）才能稳定使用。

**Q: 没有域名怎么办？**
Cloudflare 提供免费域名注册（`.cf` 等后缀），或者用已有的域名把 NS 托管到 Cloudflare。一个域名可以绑定多个 Worker 子域名。

**Q: 挑战解密失败 `Decryption failed`？**
检查 Worker 的 **Compatibility date** 是否设置为 `2024-09-23` 或更晚（新版 Cloudflare 默认已包含 `nodejs_compat`）。

**Q: 怎么改密码？**
- 面板密码：编辑 `manage_action.py` 顶部的 `ACCESS_PASSWORD`
- Worker 密码：Dashboard → Worker → Settings → Variables and Secrets → 修改 `ADMIN_PASSWORD`

**Q: interval 有什么用？**
控制每条 URL 多久检查一次。实际最快频率受 Cron 限制。例如 Cron 每分钟、interval 填 300，则每条 URL 每 5 分钟访问一次。

**Q: Cron 没触发？**
确认 **Triggers** 页面里 Cron 表达式是 `* * * * *`，Worker 已 **Deploy**。可在 **Logs** 标签页查看 `scheduled` 事件。

**Q: `env.DB` 是 undefined？**
检查 D1 绑定的 **Variable name** 是否为 `DB`（大小写敏感）。

**Q: 免费额度够用吗？**
Workers 免费版每天 10 万次请求。Cron 每分钟一次 = 1440 次/天，10 条 URL 以内完全够用。

---

**⚠️ 免责声明**：本脚本仅供学习与自动化运维研究，使用者须遵守
[HyperPHP](https://hyperphp.com/)、[Byet.Host](https://byet.host/)、[InfinityFree](https://www.infinityfree.com/)、[ProFreeHost](https://profreehost.com/) 的服务条款。因使用本脚本导致的账号限制或其他问题，作者不承担任何责任。
