# selfhost/ 叠加层

本目录保存「自建改造」相对上游开源项目的全部差异，供每日同步任务重放，
使本仓库既能跟随上游更新，又不会被上游覆盖掉本地改造。

## 运行时要求（必读）

**Node.js ≥ 22.19.0**，已写入 `package.json` 的 `engines` 并由守卫断言。

原因是 `undici@8`（`src/lib/bilibili-fetch.js` 的顶层依赖，B 站解析必用）自身的
`engines` 即为 `node >= 22.19.0`：它的 webidl 层会把 `node:worker_threads` 的
`markAsUncloneable` 挂到 `Headers` / `Request` 构造器上，而该 API 在 Node 20 上不存在，
于是被赋值为 `undefined`，构造第一个 `Headers` 时立即抛：

```
TypeError: e.util.markAsUnCloneable is not a function
```

**症状**：B 站解析固定 HTTP 500，而抖音等不经过 undici 的平台完全正常；
`npm run build`、`npm test` 均不报错 —— 只有真实请求才暴露。

**处理**：升级运行时。实测可用的隔离做法（不动系统 Node，可秒级回滚）：

```bash
# 1) 下载官方构建（国内镜像快）
curl -fsSL -O https://mirrors.cloud.tencent.com/nodejs-release/v22.23.2/node-v22.23.2-linux-x64.tar.xz
tar -xJf node-v22.23.2-linux-x64.tar.xz -C /opt && mv /opt/node-v22.23.2-linux-x64 /opt/node22

# 2) 自检该 API 确实存在（应输出 function）
/opt/node22/bin/node -e "console.log(typeof require('node:worker_threads').markAsUncloneable)"

# 3) 把 systemd 的 ExecStart 指过去
#    ExecStart=/opt/node22/bin/node server.js
```

> 降级 `undici` 到 v7 也能绕过，但那会偏离上游依赖、并让 `package-lock.json` 频繁
> 冲突，属于下策；升运行时才是正解。

## 远端配置与同步路径（fork 模式）

本仓库是作者仓库 `wu529778790/parse.shenzjd.com` 的 **fork**
（`Army-Mark/parse.shenzjd.com`）。远端按惯例分成两个角色：

| 远端 | 指向 | 权限 | 用途 |
| --- | --- | --- | --- |
| `origin` | 你的 fork（`Army-Mark/parse.shenzjd.com`） | 可写 | 发布改造结果 |
| `upstream` | 作者仓库（`wu529778790/parse.shenzjd.com`） | 只读 | 上游更新来源 |

```bash
git remote set-url origin https://github.com/Army-Mark/parse.shenzjd.com.git
git remote add upstream https://github.com/wu529778790/parse.shenzjd.com.git
git fetch upstream
```

> 差异基线由 `scripts/lib/selfhost-base.mjs` 统一解析，**优先 `upstream/main`**。
> 若退而使用 `origin/main`（fork 模式下它指向「你自己的改造线」），会把全部改造
> 算成空 —— 脚本会对此告警，且空补丁保护会直接拒绝导出。

### 两条同步路径

| 路径 | 触发方式 | 说明 |
| --- | --- | --- |
| **云端（推荐，全自动）** | 每天 03:00 UTC，或在 Actions 页手动运行 | `selfhost-sync.yml` 在 GitHub Actions 内完成：重置到上游 → 重放叠加层 → 守卫 → 测试 → 构建 → `force-with-lease` 推送 |
| **本地（手动，发布前验证）** | `npm run selfhost:sync` | 同一套机制在本地执行，默认**只提交到本地分支**；加 `--push` 才推送到 `origin` |

```bash
npm run selfhost:sync -- --check-only   # 只看上游有没有更新，不做改动
npm run selfhost:sync                   # 完整执行（重置 + 重放 + 守卫 + 验证 + 提交）
npm run selfhost:sync -- --push         # 通过校验后再推送到 origin
```

## 文件

| 文件 | 作用 |
| --- | --- |
| `patches/0001-selfhost-overlay.patch` | 相对上游的**修改与新增**（不含删除，不含 `package-lock.json`） |
| `delete.txt` | 每次同步时**无条件删除**的路径清单 |

### 为什么不包含 `package-lock.json`

锁文件是**派生**文件，不参与合并：

1. 上游几乎每次依赖升降级都会重写它 → 放进补丁会让 `--3way` 频繁冲突，而冲突意味着整次同步中止；
2. 它体量大 —— 仅「移除一个依赖子树」就产生近 1MB 的 diff，却没有代码语义增量。

同步任务改为在应用补丁后执行 `npm install --package-lock-only`，依据 `package.json`
重新生成锁文件，再由随后的 `npm ci` 做同步校验。

## 同步流程（.github/workflows/selfhost-sync.yml）

```
【jobs.sync】拉取上游 → 解析分支 → 暂存本目录 → 工作区重置为上游 → 取回本目录
        → 应用补丁（git apply --3way）→ 执行删除（git rm --ignore-unmatch）
        → 固定 .github/workflows 为上一版本 → 不变量守卫
        → 按 package.json 重新生成锁文件 → npm ci → npm test → npm run build
        → 打包 standalone 产物并上传 artifact
        → 全部通过才提交并 force-with-lease 推送
          （任一步失败即中止，线上保持上一个正常版本）

【jobs.deploy】needs: sync，仅当本次真的推了新提交才执行
        → 下载 artifact → SSH 上传 → 解到暂存目录并校验
        → 备份当前版本 → 原子替换 → chown → systemctl restart
        → 健康检查（20 次 × 3s）→ 通过则清理备份；失败则自动回滚并打印日志
```

## 自动部署（上游更新 → 服务器全自动）

`jobs.deploy` 与 `jobs.sync` 在**同一个工作流**里用 `needs` 串起来，原因是：
用默认 `GITHUB_TOKEN` 提交的推送**不会**触发其他工作流（GitHub 的反递归保护），
靠 `deploy-to-docker.yaml` 监听 `push` 是永远等不到信号的。

### 为什么不是 Docker

本服务器线上是 systemd 直跑 node（`/opt/parse/app` + `server.js`），
与 `deploy-to-docker.yaml` 的 Docker 方案抢同一个 3000 端口，二者只能留一个。
**本仓库保留 systemd**，因此 `deploy-to-docker.yaml` 的三个 job 都已加
`if: vars.ENABLE_DOCKER_DEPLOY == 'true'` 默认关闭（不再消耗 Actions 配额）。

### 需要配置的 Secrets / Variables

Settings → Secrets and variables → Actions。

**Secrets（必填三项）**

| 名称 | 说明 |
| --- | --- |
| `DEPLOY_HOST` | 服务器地址，如 `117.72.221.133` |
| `DEPLOY_USER` | SSH 登录用户；建议专用部署用户 + 免密 sudo，不要用 root 密码 |
| `DEPLOY_SSH_KEY` | 该用户的**私钥全文**（含 `-----BEGIN/END-----` 行） |

**Secrets（可选）**

| 名称 | 说明 |
| --- | --- |
| `DEPLOY_PORT` | SSH 端口，默认 `22` |
| `DEPLOY_KNOWN_HOSTS` | `ssh-keyscan -p <端口> <主机>` 的输出。不配则运行时现场扫描，有中间人风险 |
| `SYNC_TOKEN` | 带 `workflow` 权限的 PAT；配了才能自动推送 `.github/workflows/` 的改动 |
| `NEXT_PUBLIC_*` | 见下方「构建期变量」，也可放这里 |

**Variables（全部可选，留空即用内置默认值）**

| 名称 | 默认值 | 说明 |
| --- | --- | --- |
| `DEPLOY_APP_DIR` | `/opt/parse/app` | 应用目录（`server.js` 所在处） |
| `DEPLOY_SERVICE` | `parse` | systemd 单元名 |
| `DEPLOY_OWNER` | `parse` | 应用目录属主，须与服务 `User=` 一致 |
| `DEPLOY_TMP_DIR` | `/tmp` | 上传中转目录 |
| `DEPLOY_HEALTH_URL` | `http://127.0.0.1:3000/` | 健康检查地址，返回 200 视为成功 |
| `NEXT_PUBLIC_SITE_NAME` | `口袋时光` | 站点名（**构建期注入**） |
| `NEXT_PUBLIC_SITE_DOMAIN` | `113826.xyz` | 站点域名（构建期注入） |
| `NEXT_PUBLIC_SITE_URL` | `https://parse.113826.xyz` | 站点 URL，同时用作结果缓存 key 前缀 |
| `NEXT_PUBLIC_COPYRIGHT_EMAIL` | 空 | 版权邮箱 |
| `NEXT_PUBLIC_CONTACT_EMAIL` | 空 | 联系邮箱 |

> `NEXT_PUBLIC_*` 会被编译进客户端产物，**改完必须重新构建才生效**，
> 只改服务器 `.env` 是没用的（`.env` 只影响运行期读取的变量）。

### 一次性配置

```bash
# 1) 服务器上生成专用部署密钥（或用你已有密钥）
ssh-keygen -t ed25519 -f ~/.ssh/parse_deploy -N ""

# 2) 公钥装到服务器的部署用户
ssh-copy-id -i ~/.ssh/parse_deploy.pub deploy@<服务器>

# 3) 私钥全文贴进 GitHub Secret：DEPLOY_SSH_KEY
cat ~/.ssh/parse_deploy

# 4) （推荐）给部署用户免密 sudo 的最小权限，仅允许这两条
#    /etc/sudoers.d/parse-deploy
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart parse, \
                            /usr/bin/chown -R parse\:parse /opt/parse/app
```

部署用户需要对 `dirname($DEPLOY_APP_DIR)`（即 `/opt/parse`）有写权限，
才能创建暂存目录与备份目录。若不方便免密 sudo，也可直接把
`DEPLOY_USER` 设为 `root`（不推荐，密钥一旦泄露即等于整机失守）。

### 手动触发与强制重部署

`workflow_dispatch` 有一个 `force_deploy` 开关：勾选后即使上游无变化也会
重新构建并部署（例如只在服务器上改了 `.env`、或想把上次失败的部署重跑一遍）。

### 部署失败时线上会怎样

- **健康检查不通过** → 自动把上一版本挪回来并重启，线上不会停在坏版本；
  任务以非 0 退出，日志里会打印 `journalctl -u parse -n 40`。
- **同步阶段失败**（补丁冲突 / 守卫 / 测试 / 构建）→ 根本不会进 deploy，
  线上保持原样。

## 为什么把「删除」单独拆出来

删除用 `git rm -f --ignore-unmatch` 执行，对上游的任何改动都免疫。
若把删除写进补丁文件，上游只要动过这些文件（CI 工作流几乎天天改），
`git apply --3way` 就会冲突，导致整个同步任务失败。

## 何时需要重新导出

**任何一次本地改动之后都要重新导出并提交**，否则同步任务用的还是旧补丁，
你的新改动会在下一次同步时被上游重置掉。

```bash
npm run selfhost:export     # 重新生成 patches/ 与 delete.txt
npm run selfhost:guard      # 本地先跑一遍不变量检查
git add -A && git commit -m "chore(selfhost): update overlay"
git push
```

> 若只改动了被 `KEEP_ORIGINAL` 排除的文件（README、SEO 文案、品牌 SVG），
> 同样需要导出——补丁是「全量差异」，不是增量记录。

## 同步任务失败了怎么办

失败即中止，**不会推送**，线上仍是上一个正常版本。按错误类型处理：

| 报错 | 原因 | 处理 |
| --- | --- | --- |
| `补丁应用失败` + 冲突文件列表 | 上游改了补丁涉及的代码 | 本地合并上游 → 解决冲突 → `npm run selfhost:export` → 提交推送 |
| `guard` 输出 `✗` 违规项 | 上游在别处重新引入了被剥离的依赖 | 按守卫提示定位并清理，再导出补丁 |
| `npm test` / `npm run build` 失败 | 上游改动与改造不兼容 | 本地复现并修复，再导出补丁 |
| 推送被拒（workflow 权限） | 你改动了 `.github/workflows/` 文件 | 本地用自己带 workflow 权限的凭据推送一次；或配置 `SYNC_TOKEN` |
| `缺少部署配置: DEPLOY_HOST …` | Secrets 没配 | 按「自动部署」一节的表补齐 |
| `健康检查失败，回滚到上一版本` | 新版本起不来（缺环境变量 / 端口被占 / Node 版本过低） | 看日志里打印的 `journalctl -u parse -n 40`；线上已自动回滚，不会停在坏版本 |
| `Deploy to server (systemd)` 被跳过 | 上游无变化（`changed=false`） | 属正常行为；需要强制重部署时用 `workflow_dispatch` 的 `force_deploy` |

## 一次性前置（本仓库已完成）

首次提交本目录与自建同步工作流，需要一个能写入 `.github/workflows/` 的凭据。
本仓库已完成该次推送（`origin` = 你的 fork，所用凭据含 `workflow` 权限），
此后每日同步即可全自动运行。

> 若把仓库换到新账号，需再用手持 `workflow` 权限的凭据推送一次；或在
> Settings → Actions → General → Workflow permissions 勾选
> 「Read and write permissions」。
