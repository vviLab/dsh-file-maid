# dsh-file-maid

DSH（DeepSeek Harness）宿主内插件：**按用途把新文件落进工作区里正确的目录**，并量化有多少文件没走这条通道。

插件名 `dsh-file-maid`，界面显示名「文档妹抖」。

## 它解决什么问题

模型在一个有十来个分区的目录里新建文件，靠文件名和上下文自己猜该放哪——常常猜错，或者干脆放在根目录。装了这个插件之后：

- 目录知识进入系统提示，模型调用 `maid_put` 而不是自己拼路径；
- 落点由可复核的三级规则决定，返回里写明是谁定的；
- 事后能回答「这个窗口里有多少文件没走插件通道，是哪些」。

它不管文件内容，不做归档决策，也不接管别的插件的界面。

## 怎么工作

三层，各自可单独验证。

| 层 | 机制 | 失败时的表现 |
| --- | --- | --- |
| L1 提示词 | 把目录表注入系统提示（上限 1400 字符），要求改用 `maid_put` | 模型仍用 `write` 新建 |
| L2 裁决 | 纯函数三级裁决：`rules[].match` → 调用方传入的 `dir` → `root_default` | 落点进了默认目录，`candidates` 给出更合适的选项 |
| L3 守卫 | 三条文件意图钩子拒绝对 `.maid/` 保护面的写入、编辑与删除 | 返回 `FILE_MAID:MAID_LOCKED:<LEXICAL\|INODE\|UNVERIFIED>` |

**不拦截改道**：宿主给文件意图钩子的决策只有 allow / deny / cancel / ask，没有「改目标」。所以本插件的做法是「提供唯一通道 + 事后对账」，而不是「拦截并重定向」。

## 安装

需要 DSH（`engines.dsh` 为 `>=0.2.2-alpha.2 <0.3.0`）。

```bash
cd packages/maid
npm install --omit=dev          # link: 安装不会代装被链接包的依赖
node scripts/check-manifest.js  # 自检清单与引用白名单
dsh plugin add link:$PWD
```

装完**重启 `dsh web`**。客户端（侧栏卡片）改动刷新页面即可，宿主侧改动必须重启。

卸载：`dsh plugin remove dsh-file-maid`。

## 使用

### 工具

| 工具 | 作用 |
| --- | --- |
| `maid_put` | 新建文件：按 `name`、`intent`（可选 `dir`）裁决并落盘，同名默认不覆盖 |
| `maid_route` | 只算不落盘，返回候选与分数 |
| `maid_scan` | 扫描受管目录，返回四栏对账与漏网文件 |
| `maid_init` | 只做 `defer` / `opt_out`；其余动作在侧栏卡片里完成 |

`maid_put` 的返回值写明落点是怎么定的：

```json
{
  "path": "80-Outputs/报告.md",
  "dir": "80-Outputs",
  "decided_by": "rule",
  "intent_source": "session",
  "overridden": false,
  "candidates": [],
  "violations": [],
  "persisted": true
}
```

### 侧栏卡片

会话区的「文档妹抖」页签，三个子页：

- **目录**：路由目录列表，可新建、编辑、删除；路径可用系统文件夹对话框选择；
- **日志**：最近的落点记录，附带判定来源；
- **扫描**：本次扫描的规模、四栏对账、漏网文件清单，右上角可立即重扫。

### 配置

`<root>/.maid/catalog.yml` 是唯一配置源，也是唯一由人写的文件：

```yaml
version: 1
root_default: 80-Outputs
dirs:
  - path: 00-Specs
    purpose: 工作区通用规范文件
    excludes: 日志
rules:
  - match: [会议纪要, 周报]
    dir: 50-Works
```

`purpose` 与 `excludes` 各写一句话；前者进入提示词表格并参与候选排序，后者只进表格。

## 数据落在哪

插件只在 `<root>/.maid/` 写状态（目录 `0700`，文件 `0600`）：

| 文件 | 作用 | 保留 |
| --- | --- | --- |
| `catalog.yml` | 配置 | 人写 |
| `index.json` | 扫描基线 | 覆盖 |
| `status.json` | 卡片投影（删了只影响卡片） | 覆盖 |
| `rotation.json` | 每个流最近轮转时刻 | 覆盖 |
| `decisions.jsonl` | 每次 `maid_put` 的判定 | 1 MB × 10 份 |
| `writes.jsonl` | 经工具层的写入账本 | 1 MB × 10 份 |
| `guard.jsonl` | 保护面拒绝流水 | 1 MB × 10 份 |
| `audit.jsonl` | 目录变更与报告清理 | 1 MB × 10 份 |
| `reports/` | 扫描报告 | 30 份 / 90 天 |

除此之外只写业务文件本身，以及 `maid_put` 需要时创建的目录。

## 对账口径

下载、导出、`bash` 与外部进程写文件都不经 `ctx.fs`，拦不住，只能事后核对。对账分四栏：

```
增量 = 插件通道 + 工具写入账 + 漏网 + 残差
```

- **增量**：本次文件数 − 基线文件数；
- **插件通道**：窗口内 `decisions.jsonl` 的记录；
- **账本**：窗口内 `writes.jsonl` 的记录（`write` / `edit` / `apply_patch`）；
- **漏网**：扫描候选里两条日志都不认识的路径，按 **ctime** 取（`cp -p`、`rsync -a`、保留时间戳解压都改不了 ctime）。

窗口内发生过日志轮转时，或者账本在窗口中途才建立时，本窗口标为**覆盖缺口**：此时不给漏网清单，残差给 `null` 而不是 0——「算不出来」不应该显示成「一切正常」。

## 已知边界

- 不能把已发出的 `write` 改写成 `maid_put`（宿主决策里没有改目标）；
- 命名校验只有钩子位，当前恒放行；
- 只有 `maid_put` 一条写入通道，模型绕过时靠对账发现，不靠拦截；
- ctime 会把改名、`chmod`、`touch` 当作候选，属可接受的假阳性；
- 两次扫描之间创建又删除的文件不可见。

## 开发

```bash
cd packages/maid
node --test test/*.test.js        # 124 条用例
node scripts/check-manifest.js     # 清单自检
node --check src/client.js         # 客户端是 classic script
node scripts/cli.js scan --root <dir>   # 离线扫描，与插件同口径
```

源码分四层：`src/core/`（纯函数）、`src/runtime/`（扫描、落盘、按根注册）、`src/state/`（`.maid` 读写）、`src/surfaces/`（提示词、工具、钩子、卡片端点），`src/plugin.js` 负责装配。

## 许可

MIT，见 [LICENSE](LICENSE)。
