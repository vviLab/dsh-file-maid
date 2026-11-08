# dsh-file-maid

DSH 宿主内插件，当前 5.0.0。一个写入通道 `maid_put` 把文件落到工作区里正确的目录，`.maid/` 保护面由三条文件意图钩子守住，盲区由对账扫描量化。实施方案属内部文档，随维护者本地保留，不随仓库分发。

## 装配

插件挂在宿主进程内，随 DSH 启动加载，注册五个工具、一段系统提示上下文、四条拦截钩子与两条生命周期钩子。

```bash
cd packages/maid
npm install --omit=dev          # link: 安装不会代装被链接包的依赖
node -e "import('yaml').then(()=>console.log('yaml ok'))"
node scripts/check-manifest.js
dsh plugin add link:~/projects/dsh-file-maid/packages/maid
```

`engines.dsh` 固定为 `>=0.2.2-alpha.2 <0.3.0`（预发布范围必须写全，否则插件管理器拒装）。宿主侧改动需要重启 `dsh web` 才生效；客户端 bundle 改动刷新页面即可。卸载用 `dsh plugin remove dsh-file-maid`。

## 受控根

受控根等于当前会话的 `session.header.cwd`。插件不向父目录搜索，也不用 `workingDirectory` 的部署默认值兜底：会话没有 `cwd` 时工具返回 `E_MAID_NO_ROOT`，写面判定直接放行。判定另取 `workingDirectory.get(session)` 作为相对路径的第二个解析基准。

激活条件是 `.maid/catalog.yml` 存在。五个工具始终注册，调用时判状态：

| 状态 | 表现 |
| --- | --- |
| 未初始化 | 返回 `UNINITIALIZED`，提示词节整节不出现，不写任何文件 |
| 已退出 | 返回 `NOT_MANAGED`，无 error，提示词节消失 |
| 配置损坏 | 返回 `ERROR` 并带行列号，提示词节消失 |

初始化在侧栏卡片完成，`maid_init {mode}` 只接受 `defer` 与 `opt_out`（其余回 `E_MAID_CARD_REQUIRED` 语义）；`defer` 不写盘，`opt_out` 写 `.maid/opt-out`。

**查找未登记的改动时用 `maid_review`，不要用 `maid_scan`**：扫描会覆写 `index.json` 把窗口推走，看一眼就等于放弃追查；复核只测量。确认（「这条我知道」）写在 `.maid/acknowledged.json`，键是 `path@ctime`——同一路径后续再被改写会重新出现。

## 五个工具

| 工具 | 参数 | 写盘 |
| --- | --- | --- |
| `maid_put {name,content,intent?,dir?,overwrite?}` | 三级裁决后原子写入，返回 `decided_by`、`intent_source`、`candidates`、`violations` | 是 |
| `maid_route {name,intent?,dir?}` | 同一条裁决链，只回答落点与候选 | 否 |
| `maid_init {mode}` | 初始化入口，只接受 `defer` 与 `opt_out` | 视 mode |
| `maid_review {}` | 只测量：列出上次扫描以来没记账的改动（带体积与变更时间），不推进基线、不写盘 | 否 |
| `maid_scan {scope?,report?,export?}` | 目录巡检 + 基线对账，可选落 `reports/scan-*.md`，`export:'json'` 再落同茎 `.json` | 报告／清单 |

五个工具共用同一信封 `{schemaVersion, verdict, data, errors, warnings}`，从不抛异常。

## 判定链

两级，首命中生效，结果带 `decided_by`：

1. 调用方传入的 `dir`，须在 catalog 中声明 → `agent`；
2. catalog 的 `root_default` → `default`。

`dir` 不在声明集合内直接拒绝（`E_MAID_DIR`），不静默回退。旧版本还有一级 `rules[].match`（关键词 → 目录），2026-11 已撤掉：路由由模型判断，关键词匹配是第二套更笨的判断链，两者冲突时文件会落到没人要的地方。老配置里保留 `rules:` 仍能加载，插件忽略并给警告（`E_MAID_RULES_RETIRED`）。

用途文本（`intent`）的来源优先级：参数 > 会话尾部 2000 字符（`ctx.sessions.get(id).deriveMessages()`）> 无。来源写进结果与日志，事后可判断「模型真说了用途」还是「工具自己猜的」。

## `.maid/` 状态

| 路径 | 内容 | 权限 |
| --- | --- | --- |
| `catalog.yml` | 唯一路由来源：`version`、`root_default`、`dirs[]` | `0600` |
| `index.json` | 上一次扫描的每目录文件数基线 | `0600` |
| `status.json` | 只读投影，卡片读它，判定从不读回 | `0600` |
| `decisions.jsonl` | 每次落点判定一条：名字、目录、`decided_by`、`intent_source` | `0600` |
| `guard.jsonl` | 每次保护面拒绝一条 | `0600` |
| `writes.jsonl` | 每次经工具层的写入一条：`tool`、`path`、`kind`（首条为 `init` 起点记录） | `0600` |
| `rotation.json` | 每个流最近一次轮转的时刻，用于声明对账窗口是否完整 | `0600` |
| `reports/scan-*.md` | 扫描与对账报告，保留 30 份 | `0600` |
| `opt-out` | 退出标记 | `0600` |

`catalog.yml` 是唯一的手工编辑面；`index.json`、`status.json` 与日志只由插件写。

## 提示词层

注入节含一张表（目录 / 收什么 / 排除）与六条行为规则，上限 1400 字符。超预算时先丢「排除」列，再丢整行并留一行「还有 N 个目录」。同一份 catalog 渲染字节一致，未初始化时整节不出现，`order: 300`。

## Web 视图

卡片仍是只读投影：`#dsh-st-shell-panel` 里 prepend `[data-file-maid="cardslot"]`，独立 React root 渲染，会话列表订阅 `ctx.sessions.list`。三个页签为**目录 / 日志 / 扫描**：

| 页签 | 数据源 |
| --- | --- |
| 目录 | `catalog.dirs[]`：路径、用途、排除、文件数（每个会话首次进入时后台数一次；没数过显示 `—`，不是 0） |
| 路由 | `status.routes[]`：最近的落点判定与依据 |
| 扫描 | 本次扫描、新增文件去哪了（净增 / 经 maid_put / 经工具写盘）、根与基线 |

「目录」页签是一个目录管理器：新建、编辑、删除三个动作，编辑时勾「没指定目录时，文件放这里」即可把它设成判断不出来时归入的目录（`makeDefault: true`），字段是路径 / 用途 / 排除（可空）。写入走六个 Host 端点 `fileMaid/draft`（只校验一条待添加路径）、`fileMaid/pick`、`fileMaid/save`（目录增删改）、`fileMaid/scan`、`fileMaid/review`、`fileMaid/ack`：

| 动作 | 行为 |
| --- | --- |
| 新建 | 路径与用途必填（标签带 `*`，就绪前「创建」不可点，灰字列出还缺哪几项），排除可空；路径必须是工作区里**已经存在**的文件夹，插件不会替你创建，也可点「选择目录…」拉起操作系统的文件夹对话框（`fileMaid/pick`：macOS 用 `osascript`；Linux 依次尝试 `zenity` → `kdialog` → `python3` tkinter；Windows 依次尝试 `powershell` → `pwsh`；全部缺失时报 `E_MAID_UNAVAILABLE`）；对话框默认打开在受控根；选中的位置必须位于受控根内部；目录不存在时拒绝，插件不会替你创建；路径重复、含 `..` 或 `.maid` 段时拒绝 |
| 编辑 | 路径不可改，只改用途与「排除」两句说明 |
| 删除 | 默认落点不能删；最后一个目录不能删；文件留在磁盘上，只是不再参与路由 |

端点不信客户端给的 `root`：它按 `sessionId` 向宿主解析这个会话的工作目录，只有两者一致才继续。写盘前跑一遍加载期的同一个 `validateCatalog`，写完立刻重投影 `status.json`。客户端用 `adaptStatus()` 把 v2 投影映射到渲染字段，渲染代码不必认识两套字段名。

## 保护面

只有 `.maid` 被拦截，四条钩子调用同一判定：

| 钩子 | 作用点 |
| --- | --- |
| `tools/pre-execute` | 审批卡之前拒绝 |
| `fs/write-intent` | 工具体内拒绝 |
| `fs/edit-intent` | 工具体内拒绝 |
| `fs/delete-intent` | 工具体内拒绝 |

判定按 `(工具, command)` 展开，相对路径同时按 `workingDirectory` 与 `session.header.cwd` 两个基准解析后逐个数判定，边界只比较 `(dev, ino)` 而不比字符串前缀。命中文案固定为：

```
FILE_MAID:MAID_LOCKED:<LEXICAL|INODE|UNVERIFIED> <说明>
```

未命中时一律 `return next()`，内置 `dsh-fs-observation-policy` 的版本校验因此保持生效。

## 对账

下载、导出、`bash` 写入不经 `ctx.fs`，无法事前拦截，只能事后对账。

扫描范围只有目录表里声明的那些目录：工作区根目录下直接放的文件、没有登记进表的文件夹，都不在统计里，也不会出现在卡片的任何数字中。卡片上不写这句说明，只给数字；需要确认范围时看这里。

扫描按目录并发读取，并发上限按 `readdir` 的实测延迟自适应：本地盘升到 8，网络挂载降回 1–2（每 32 个目录重算一次，连续两批变慢才降档）。需要钉住并发时设环境变量 `FILE_MAID_SCAN_CONCURRENCY=1`（取值 1–8，设定后关闭自适应）。参考工作区 4,162 文件 / 649 目录的实测中位：并发化前 38 ms，之后 17 ms。

卡片上叫「新增文件去哪了」，分四栏：

| 栏（卡片上的名字） | 含义 | 来源 |
| --- | --- | --- |
| 净增文件 | 本次文件数 − 基线文件数 | `index.json` 与本次扫描 |
| 经 `maid_put` | 窗口内 `decisions.jsonl` 点名过的**文件数**（同一文件写多次算一个） | `decisions.jsonl` |
| 经工具写盘 | 窗口内 `writes.jsonl` 点名过的**文件数** | `writes.jsonl` |
| 没被记账的改动 | 扫描候选中两条通道都没点名的路径 | 扫描候选（按 ctime） |
| 只体现在总数里 | 净增中既没被记账、也没被点名的部分 | 计算；有覆盖缺口时为 `null`（无法计算） |

每条漏网都同时给出两个时间：被动过的时间（`ctime`）与内容改于（`mtime`）。改名、`chmod` 只动前者——两个时间差得远，就说明它多半不是新写进来的。插件不替你判断，只把判断要用的信息放在同一行。

覆盖缺口有两种：轮转把窗口切断了，或账本在本窗口内才建立。前者可以切开——轮转**之后**的改动仍能点名，轮转**之前**的只计入 `unknown_files`；后者只能整窗按数量报。

扫描候选按 **ctime** 取：`ctime` 是 inode 变更时间，`cp -p`、`rsync -a`、保留时间戳的解压都无法保留它，因此这类写入仍可被定位。代价是改名、`chmod` 会作为候选出现，属于可接受的假阳性。

覆盖缺口分两种，分别标记，互不顶替：

| 情形 | 标记 | 表现 |
| --- | --- | --- |
| 账本在窗口内才建立 | `ledger_incomplete` | 只报数量，不出清单 |
| 写入账在窗口内轮转过（>1 MB 滚动） | `ledger_incomplete` | 同上 |
| 落点日志在窗口内轮转过 | `recorded_incomplete` | 同上 |

`rotation.json` 记录每个流最近一次轮转的时刻，窗口起点早于该时刻即判定该流不完整。这样既不必读取十个轮转文件，也不会把「日志被搬走」误当成「这些文件没走插件」。

不完整的窗口**不出清单，也不算差额**：`reconcile` 返回空的 `missing` 与 `residual: null`。一半真一半假的名单比没有名单更糟，而一个读作「一切正常」的 0 比空白更糟。

窗口读取不再截断条数（一次窗口最多 1 MB），因此计数不会被 400 条上限悄悄压低。

「扫描」页签是一屏报告，分四层：

| 层 | 内容 | 位置 |
| --- | --- | --- |
| 结论 | 文件 / 目录 / 耗时 | 「本次扫描」组首行，三格等宽 |
| 状态 | 时间 · 是否监听 / 正常或已降级 | 三格下一行，10.5px |
| 动作 | 「重新扫描」（`fileMaid/scan`） | 「本次扫描」组头右端，文本级 |
| 明细 | 新增 / 插件通道 / 账本，漏网计数与清单 | 「对账」组；计数进组头，清单逐条 |
| 落款 | 根路径 | 页脚一行，无组头 |

空态（尚无扫描结果）给一个「立即扫描」按钮，不必回对话里触发。

差额是估算值：删除与移动让计数下降，覆盖写不产生增量，目录间搬迁同时改两个计数。它的用途是看量级与趋势，不是精确核对。实时监听不启用。

## 验证

```bash
node --test test/*.test.js         # 191 条单元、集成与渲染用例
node scripts/check-manifest.js     # manifest、补丁、依赖与分层自检
node scripts/cli.js route --root <dir> --name report.md --intent 报告
node scripts/cli.js migrate --root <dir>   # v3 catalog → v5，原文件留作 catalog.yml.v3.bak
```

`src/core/` 是纯函数，可脱离宿主直接用 `node --test` 验证。

## 已知限制

1. 下载、导出、`bash` 重定向、`mv`/`cp`、外部进程与其他插件的写入不经写入通道，只由对账事后估算。
2. 受控根之外的目录完全不参与判定，包括 `70-Downloads` 这类外链入口。
3. 判定不读文件内容，同名不同义的文件只能靠文件名与用途描述区分。
4. 命名校验只拦「跨平台不安全」的名字（分隔符、Windows 保留字符与设备名、结尾空格或点、超过 255 字节），不按项目自己的命名规范判对错。
5. `fs.watch(recursive)` 在本版不启用；重启评估条件是差额占比连续两周高于 30%。

## 字段：用途与排除

一个目录只有两个描述字段，分工不重叠：

| 字段 | 谁读 | 作用 |
| --- | --- | --- |
| `purpose` | 人、模型 | 一句话说明这个目录收什么；它就是提示词表格里的「收什么」列 |
| `excludes` | 人、模型 | 一句话说明什么不该放这里；表格的「排除」列。可空，空时卡片不显示这一行、表格显示 `—`。旧文件里的词数组仍可加载，会拼成一句话 |

裁决本身不看这两个字段（只看调用方 `dir` → `root_default`），它们影响的是**模型读到的目录表**与 `candidates` 排序：排序把 `purpose` 按标点切短语、再取两字窗口做子串匹配，因此「工作区通用规范文件」也能命中意图里的「规范」。

`includes` 与 `role` 已退役：旧文件里仍可存在，加载时忽略，写回时不再输出。
