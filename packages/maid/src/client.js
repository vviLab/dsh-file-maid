/**
 * file-maid read-only status panel for the Web UI.
 *
 * Two seats: one icon in `sidebar.panellist` (the sidebar's global panel row) and
 * the page body it opens in `main`; the shell couples them by the shared panel id.
 * The page is a projection:
 * for one Session of each workspace root it reads `<root>/.maid/status.json`
 * through the `workspaceFiles` Remote. It never writes, never asks the Host to
 * decide anything, and never reinterprets `catalog.yml` — the catalog in the
 * snapshot is the same validated one the model-facing tools use.
 *
 * The panel is root-scoped while the Catalog is per Session root, so the page
 * lists every distinct root it can see and shows the selected one.
 */
window.__ModuleLoader__.load({
  id: 'dsh-file-maid',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /**
     * Shared UI primitives, so a segmented switch looks like the shipped ones.
     * The loader may not expose the package in every deployment, so a missing
     * module degrades to the hand-rolled switch below instead of a blank panel.
     */
    let primitives = null;
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    } catch {
      primitives = null;
    }
    const SegmentedTabs = primitives?.SegmentedTabs;

    /**
     * The card mounts in its own React root, so it needs the renderer directly. A host
     * without it falls back to the panel icon row.
     */
    let reactDom = null;
    try {
      reactDom = require('react-dom/client');
    } catch {
      reactDom = null;
    }

    /**
     * `createPortal` lives in the renderer itself, not in `react-dom/client`. The state
     * tooltip is drawn this way so the card's clipping containers cannot cut it off.
     */
    let reactDomRenderer = null;
    try {
      reactDomRenderer = require('react-dom');
    } catch {
      reactDomRenderer = null;
    }

    /**
     * The plugin context, kept for the helpers that run outside `apply`'s closure (the
     * card mounts in its own React root and reads the session list itself).
     */
    let services = null;

    /** Client locale namespace. */
    const NS = 'dsh-file-maid';
    /** Panel identity: one sidebar icon and one `main` body share it. */
    const PANEL_ID = 'file-maid';
    /** Status snapshot path, relative to the Session workspace root. */
    const STATUS_PATH = '.maid/status.json';
    /** Lines requested per page; the snapshot is far smaller in practice. */
    const PAGE_LINES = 400;
    /** Hard cap on pages, so a runaway file cannot stall the page. */
    const MAX_PAGES = 6;
    /** Remembered collapsed state of the sidebar card. */
    const OPEN_KEY = 'dsh-file-maid.card.open';
    /** Last state the panel read, shown on the collapsed card header. */
    const cardState = { value: undefined, listeners: new Set() };

    /**
     * Publish the state for the card header and wake its subscribers.
     * @param {{ tone: string, label: string } | undefined} next - badge to show.
     * @returns {void}
     */
    const publishCardState = (next) => {
      cardState.value = next;
      for (const listener of cardState.listeners) {
        try {
          listener();
        } catch {
          /* one broken subscriber must not stop the rest */
        }
      }
    };

    /**
     * Descriptors of the retired setup endpoints, kept only so the literals below
     * remain readable; nothing mounts or calls them in v5.
     *
     * Literal copies of `remoteDescriptors()` in `src/surfaces/manage.js` — this half is a
     * classic script and cannot import from the Host tree. A drifted descriptor fails at
     * call time, not at load, so the copy names only what the card actually calls.
     */
    const descriptorOf = (method, names) => ({
      id: `fileMaid/${method}`,
      service: 'fileMaid',
      namespace: 'fileMaid',
      method,
      invocation: { kind: 'direct' },
      parameters: names.map((name) => ({
        name,
        wire: name,
        source: 'json',
        codec: {
          mode: 'strict',
          typeSymbol: 'string',
          create: () => ({
            parse: (value) => {
              if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
              return value;
            },
          }),
        },
      })),
      result: { mode: 'src-json' },
    });
    const MANAGE_DESCRIPTORS = [
      descriptorOf('draft', ['root', 'sessionId', 'path']),
      descriptorOf('pick', ['root', 'sessionId']),
      descriptorOf('save', ['root', 'sessionId', 'payload']),
      descriptorOf('scan', ['root', 'sessionId', 'payload']),
      descriptorOf('review', ['root', 'sessionId']),
      descriptorOf('ack', ['root', 'sessionId', 'payload']),
    ];

    /** Machine states the snapshot may report. */
    const CATALOG_STATES = ['MANAGED', 'UNINITIALIZED', 'NOT_MANAGED', 'ERROR'];

    /**
     * Bilingual strings. Keys stay flat so one dictionary serves every locale.
     */
    const DICT = {
      zh: {
        title: '文档妹抖',
        'state.MANAGED': '已启用',
        'state.UNINITIALIZED': '未启用',
        'state.NOT_MANAGED': '已关闭',
        'state.ERROR': '配置有问题',
        'state.absent': '暂无数据',
        'state.loading': '读取中',
        'state.denied': '无法读取',
        'state.noRoot': '无会话',
        'state.readError': '读不到数据',
        'summary.dirs': '{n} 个目录',
        'summary.files': '{n} 个文件',
        'label.root': '工作区根',
        'label.workspace': '工作区',
        'role.managed': '受管目录',
        'role.autonomous': '自管目录',
        'label.uninitialized': '还没启用。点下面的「启用这个根」建好目录表。',
        'label.default': '没命中时放这里',
        'label.scan': '最近扫描',
        'label.threshold': '阈值',
        'label.baseline': '基线快照',
        'col.dir': '目录',
        'col.files': '文件',
        'col.about': '用途',
        'view.label': '视图',
        'view.dirs': '目录',
        'view.misplaced': '日志',
        'view.scan': '扫描',
        'k.scannedAt': '时间',
        'k.durationMs': '耗时',
        'k.files': '文件',
        'k.dirs': '目录',
        'k.baseline': '基线',
        'k.newFiles': '净增文件',
        'k.recorded': '经 maid_put',
        'k.threshold': '阈值',
        'k.weights': '权重',
        'k.hash': '指纹',
        'k.root': '路径',
        'section.catalog': '目录表',
        'section.misplaced': '最近落点',
        'section.scan': '本次扫描',
        'section.params': '判定参数',
        'section.rules': '规则',
        'rule.add': '＋ 添加规则',
        'rule.empty': '还没有规则。命中匹配词的文件会直接放进指定目录，不用每次都靠用途猜。',
        'rule.match': '匹配词',
        'rule.matchHint': '例如：合同',
        'rule.target': '放进',
        'rule.save': '保存',
        'rule.cancel': '取消',
        'rule.delete': '删除',
        'rule.failed': '规则没有保存，稍后再试。',
        'section.reconcile': '新增文件去哪了',
        'section.missing': '漏网文件',
        'scan.rerun': '重新扫描',
        'scan.rerunArm': '再点一次·会重算基线',
        'scan.rerunWarn': '重新扫描会从此刻重新算起，下面 {n} 条没被记账的改动会并入基线、不再列出。',
        'scan.running': '扫描中…',
        'scan.failed': '扫描没有完成，稍后再试。',
        'scan.more': '还有 {n} 个',
        'scan.ledgerIncomplete': '账本未覆盖',
        'scan.ack': '这条我认了',
        'scan.ackUndo': '撤销',
        'scan.ackDone': '已确认「{name}」',
        'scan.ackCount': '已确认 {n} 条',
        'scan.ackFailed': '确认没有保存，稍后再试。',
        'scan.ackReadonly': '只读会话：漏网条目不能确认。',
        'scan.reviewLoading': '正在读取体积与变更时间…',
        'scan.reviewFailed': '详情没有读到，只显示路径，暂时不能确认。',
        'scan.showAll': '展开 {n} 条',
        'scan.truncatedNote': '清单到 {n} 条上限，只保留最新的。',
        'scan.export': '扫描时同时导出清单',
        'scan.exportReadonly': '只读会话不能写导出文件。',
        'k.pathFull': '完整路径',
        'k.ctime': '被动过',
        'k.mtime': '内容改于',
        'k.owner': '归属目录',
        'kind.file': '文件',
        'kind.dir': '文件夹',
        'kind.link': '符号链接',
        'kind.other': '其他',
        'scan.scanNow': '立即扫描',
        'scan.freshBaseline': '这是第一次扫描，已记下基线；下次扫描才能看出新增与漏网。',
        'scan.noLeak': '没有未记账的改动',
        'scan.leakCount': '{n} 个改动没被记账',
        'scan.residual': '另有 {n} 个文件只体现在总数变化里，点不出名字',
        'scan.ledgerNote': '账本未覆盖本次窗口，只报数量',
        'scan.recordedIncomplete': '落点日志未覆盖',
        'scan.recordedNote': '本窗口内日志轮转过，清单不可靠，只报数量',
        'scan.unknownFiles': '另有 {n} 条无法判断：它们写在日志轮转之前，那一段记账已经滚走了。',
        'scan.countMismatch': '这期间也有文件被删：净增按目录总数相减是 {net}，没记账的改动按文件算有 {n} 条，两个口径不同。',
        'scan.residualUnknown': '本窗口的日志没覆盖全，算不出这部分数量',
        'scan.factScope': '统计范围',
        'k.ledger': '经工具写盘',
        'k.missing': '漏网',
        'section.baseline': '根与基线',
        'weight.keyword': '关键词',
        'weight.desc': '用途',
        'weight.prior': '先验',
        'scan.baselineSet': '有快照',
        'scan.baselineNone': '无快照',
        'scan.degraded': '扫描较慢',
        'scan.degradedNone': '正常',
        'scan.empty': '没有扫描记录',
        'scan.emptyHint': '会话进入工作区时会在后台统计一次，几秒后这里出现结果；也可以让我重新扫描。',
        'detail.keywords': '关键词',
        'detail.noKeywords': '无',
        'detail.excludes': '排除：',
        'detail.excludesLabel': '排除',
        'detail.noExcludes': '—',
        'detail.misplaced': '路由指向本目录',
        'detail.misplacedShort': '落点',
        'detail.excludesShort': '排除 {terms}',
        'detail.landed': '落点 {n}',
        'detail.purposeMore': '展开',
        'detail.purposeLess': '收起',
        'dir.row': '{path}，{files} 个文件',
        'dir.purposeLabel': '用途',
        'detail.landedLabel': '近期落点',
        'detail.landedCount': '{n} / {total} 条',
        'manage.fallback': '没命中规则时，文件放这里',
        'manage.fallbackHint': '勾上后，判断不出来的文件都会进这个目录',
        'manage.fallbackCurrent': '现在就是这样',
        'manage.editOf': '编辑 {path}',
        'manage.deleteOf': '删除 {path}',
        'detail.default': '没命中时放这里',
        'misplaced.empty': '没有记录',
        'misplaced.emptyHint': '最近的落点判定与依据会记在这里。',
        'misplaced.into': '落点',
        'misplaced.pathLabel': '路径',
        'misplaced.folderLabel': '目录',
        'misplaced.byLabel': '依据',
        'detail.byRule': '规则命中',
        'detail.byAgent': '调用时指定',
        'detail.byDefault': '没命中时的目录',
        'misplaced.timeLabel': '时间',
        'hint.notManaged': '已退出管理：不再自动归类，也不再给模型目录表。`.maid` 的保护仍然生效；删除 `.maid/opt-out` 后刷新可恢复。',
        'hint.absent': '整理一次文件后会显示。',
        'hint.error': '读不到数据',
        'hint.emptyCatalog': '还没有可以归类的文件夹。',
        'hint.noTable': '还没有可用的目录表。',
        'hint.failed': '可以点「刷新」再试一次。',
        'hint.denied': '换一个能读文件的会话。',
        'hint.noRoots': '打开一个会话后显示。',
        'hint.degraded': '这次扫描超过了 300 毫秒。数字照样准，只是慢——文件越多越明显。',
        'hint.degradedTitle': '扫描 {files} 个文件用了 {ms} 毫秒',
        'action.dismiss': '关闭提示',
        'init.action': '初始化这个工作区',
        'init.busy': '正在初始化…',
        'init.failed': '初始化没有成功。',
        'init.loading': '正在读取这个工作区…',
        'init.noRoot': '这个工作区没有正在运行的会话；打开一个会话后再试。',
        'init.noSession': '选中的会话已经关闭；刷新后重试。',
        'init.unavailable': '当前宿主没有提供这个操作。刷新页面；仍不行就重启 dsh web。',
        'init.title': '初始化这个根',
        'init.template': '模板',
        'init.dirCount': '{n} 个目录',
        'init.create': '在磁盘创建目录',
        'init.candidates': '现有目录',
        'init.skip': '不登记',
        'init.registerAutonomous': '登记为自管',
        'init.registerManaged': '登记为受管',
        'init.output': '没命中时放这里',
        'init.more': '更多选项',
        'init.less': '收起选项',
        'init.customPlaceholder': '每行一条：路径:角色:用途:关键词1,关键词2',
        'init.previewAction': '预览改动',
        'init.preview': '确认改动',
        'init.previewSummary': '新增 {added} 条，移除 {removed} 条，将创建 {created} 个目录',
        'init.confirm': '写入',
        'init.back': '返回修改',
        'init.done': '已写入',
        'init.editDirs': '编辑目录表',
        'init.hideEdit': '收起编辑',
        'init.role': '角色',
        'init.switchRole': '切换角色',
        'init.remove': '移除',
        'init.undo': '撤销',
        'init.add': '添加',
        'init.path': '路径',
        'init.purpose': '用途',
        'init.stop': '停止管理这个根',
        'init.stopHint': '停止管理不会移动任何文件。',
        'init.start': '开始设置',
        'init.edit': '编辑',
        'manage.add': '＋ 新建',
        'manage.edit': '编辑',
        'manage.delete': '删除',
        'manage.save': '保存',
        'manage.create': '创建',
        'manage.cancel': '取消',
        'manage.path': '路径',
        'manage.pick': '选择目录…',
        'manage.purpose': '用途',
        'manage.purposeHint': '一句话说明这个目录收什么',
        'manage.excludes': '排除',
        'manage.termsHint': '一句话说明什么不该放这里（可空）',
        'manage.failed': '保存失败',
        'manage.required': '还需要填写：{fields}',
        'manage.pathInvalid': '路径只能写一个文件夹名：不能包含 / 或 \\，也不能以 . 开头。',
        'manage.confirmRemove': '删除 {path}？文件不会被删除，只是不再参与路由。',
        'init.noChanges': '无改动',
        'init.noChangesHint': '还没有改动',
        'init.previewCount': '预览改动（{n}）',
        'init.pendingRemove': '待移除',
        'init.pendingAdd': '待写入',
        'init.leave': '← 返回',
        'init.discard': '放弃 {n} 项修改',
        'stat.dirs': '个目录',
        'more.show': '还有 {n} 个目录',
        'setup.entry': '启用这个根',
        'setup.lead': '这个根还没有目录表。',
        'setup.detail': '添加目录后，文件会按用途自动归类。',
        'setup.listTitle': '已添加的目录',
        'setup.emptyTitle': '还没有目录',
        'setup.emptyHint': '先添加一个目录，文件才会被归类。',
        'setup.addTitle': '添加目录',
        'setup.add': '添加目录',
        'setup.ok': '添加',
        'setup.cancel': '取消',
        'setup.remove': '移除',
        'setup.removeOf': '从列表移除 {path}，不会删除文件',
        'setup.defaultOf': '把 {path} 设成没命中时放的位置',
        'setup.defaultHint': '没命中规则、也没指定目录时，文件放这里。',
        'setup.needDefault': '还没选没命中时放哪里',
        'setup.needFields': '还需要填写：{fields}',
        'setup.path': '路径',
        'setup.purpose': '用途',
        'setup.excludes': '排除',
        'setup.pathPh': '例如 80-Outputs',
        'setup.pathHint': '相对工作区根，最多 3 段。',
        'setup.purposePh': '一句话说明这个目录收什么',
        'setup.excludesPh': '一句话说明什么不该放这里（可空）',
        'setup.tooMany': '已经有 {n} 个目录。目录表太长时，提示词里只列出前面一部分；没列出的仍能按目录名和规则命中。',
        'setup.dup': '这个目录已经加过了',
        'setup.checkFailed': '没能检查这个路径，稍后再试。',
        'setup.count': '{n} 个目录',
        'setup.next': '下一步 · {n}',
        'setup.confirmTitle': '确认启用',
        'setup.confirmDefault': '没命中时放这里：{path}',
        'setup.confirmPromise': '不会移动或删除任何文件。',
        'setup.write': '写入并启用',
        'setup.back': '返回修改',
        'setup.leave': '← 返回',
        'setup.writing': '正在写入…',
        'setup.scanning': '已写入，正在清点文件…',
        'setup.done': '已启用 · {dirs} 个目录',
        'setup.doneMeta': '{files} 个文件',
        'setup.scanPending': '已启用，但还没清点文件；到扫描页重试。',
        'setup.doneNote': '目录、日志、扫描已经可用。',
        'setup.doneAction': '查看目录',
        'setup.failed': '启用没有完成。',
        'setup.retry': '重试',
        'setup.errorKept': '已添加的 {n} 个目录还在，可以直接重试。',
        'more.hide': '收起',
        'refresh': '刷新',
        'age.now': '刚刚',
        'age.seconds': '{n} 秒前',
        'age.minutes': '{n} 分钟前',
        'age.hours': '{n} 小时前',
        'age.days': '{n} 天前',
      },
      en: {
        title: 'File Maid',
        'state.MANAGED': 'on',
        'state.UNINITIALIZED': 'not set up',
        'state.NOT_MANAGED': 'off',
        'state.ERROR': 'setup problem',
        'state.absent': 'no data yet',
        'state.loading': 'loading',
        'state.denied': 'no access',
        'state.noRoot': 'no session',
        'state.readError': 'read failed',
        'summary.dirs': '{n} dirs',
        'summary.files': '{n} files',
        'label.root': 'root',
        'label.workspace': 'workspace',
        'role.managed': 'managed dir',
        'role.autonomous': 'autonomous dir',
        'label.uninitialized': 'Not enabled yet. Set it up from the card below.',
        'label.default': 'default',
        'label.scan': 'last scan',
        'label.threshold': 'threshold',
        'label.baseline': 'baseline',
        'col.dir': 'dir',
        'col.files': 'files',
        'col.about': 'purpose',
        'view.label': 'view',
        'view.dirs': 'Directories',
        'view.misplaced': 'Log',
        'view.scan': 'Scan',
        'k.scannedAt': 'time',
        'k.durationMs': 'duration',
        'k.files': 'files',
        'k.dirs': 'dirs',
        'k.baseline': 'baseline',
        'k.threshold': 'threshold',
        'k.weights': 'weights',
        'k.hash': 'hash',
        'k.root': 'path',
        'section.catalog': 'Catalog',
        'section.misplaced': 'Recent decisions',
        'section.scan': 'This scan',
        'section.params': 'Decision rules',
        'section.rules': 'Rules',
        'rule.add': '+ Add rule',
        'rule.empty': 'No rules yet. A file whose name or purpose matches a keyword goes straight to the folder you pick.',
        'rule.match': 'keyword',
        'rule.matchHint': 'for example: contract',
        'rule.target': 'into',
        'rule.save': 'Save',
        'rule.cancel': 'Cancel',
        'rule.delete': 'Delete',
        'rule.failed': 'The rule was not saved; try again.',
        'section.reconcile': 'Where new files went',
        'section.missing': 'Unaccounted files',
        'scan.rerun': 'Scan now',
        'scan.rerunArm': 'Click again: this rebaselines',
        'scan.rerunWarn': 'Scanning restarts the window; the {n} unrecorded changes below become part of the baseline and stop being listed.',
        'scan.running': 'Scanning…',
        'scan.failed': 'The scan did not finish; try again shortly.',
        'scan.more': '{n} more',
        'scan.ledgerIncomplete': 'ledger does not cover this window',
        'scan.ack': "I'll accept this one",
        'scan.ackUndo': 'Undo',
        'scan.ackDone': 'Accepted "{name}"',
        'scan.ackCount': '{n} accepted',
        'scan.ackFailed': 'The acceptance was not saved; try again.',
        'scan.ackReadonly': 'Read-only session: leaks cannot be accepted.',
        'scan.reviewLoading': 'Reading size and change time…',
        'scan.reviewFailed': 'Details did not load; paths only, so accepting is unavailable.',
        'scan.showAll': 'Show {n} more',
        'scan.truncatedNote': 'The list stops at {n}; the newest are kept.',
        'scan.export': 'Also export the list when scanning',
        'scan.exportReadonly': 'Read-only session: nothing can be exported.',
        'k.pathFull': 'full path',
        'k.ctime': 'touched',
        'k.mtime': 'content changed',
        'k.owner': 'filed under',
        'kind.file': 'file',
        'kind.dir': 'folder',
        'kind.link': 'symlink',
        'kind.other': 'other',
        'scan.scanNow': 'Scan now',
        'scan.freshBaseline': 'First scan: the baseline is recorded now, so the next scan can show what is new.',
        'scan.noLeak': 'no unrecorded changes',
        'scan.leakCount': '{n} changes without a record',
        'scan.unknownFiles': 'Another {n} cannot be judged: they predate a log rotation, and that slice of the record is gone.',
        'scan.countMismatch': 'Files were also deleted in this window: the net change is {net} while {n} changes have no record — the two count different things.',
        'scan.residual': '{n} more only show up in the total; they cannot be named',
        'scan.ledgerNote': 'the ledger does not cover this window; counts only',
        'scan.recordedIncomplete': 'decision log rotated',
        'scan.recordedNote': 'the log rotated inside this window, so the list is unreliable; counts only',
        'scan.residualUnknown': 'this window has a coverage gap, so the remainder cannot be computed',
        'scan.factScope': 'Counted',
        'k.newFiles': 'new files',
        'k.recorded': 'via plugin',
        'k.ledger': 'Ledger',
        'k.missing': 'Unaccounted',
        'section.baseline': 'Root & baseline',
        'weight.keyword': 'keyword',
        'weight.desc': 'purpose',
        'weight.prior': 'prior',
        'scan.baselineSet': 'snapshot set',
        'scan.baselineNone': 'no snapshot',
        'scan.degraded': 'slow scan',
        'scan.degradedNone': 'normal',
        'scan.empty': 'no scan yet',
        'scan.emptyHint': 'A session counts this workspace in the background as it starts, so numbers appear within seconds.',
        'detail.keywords': 'keywords',
        'detail.noKeywords': 'none',
        'detail.excludes': 'Excludes:',
        'detail.excludesLabel': 'Excludes',
        'detail.noExcludes': '—',
        'detail.misplaced': 'misplaced into this dir',
        'detail.misplacedShort': 'into',
        'detail.excludesShort': 'excludes {terms}',
        'detail.landed': 'landed {n}',
        'detail.purposeMore': 'more',
        'detail.purposeLess': 'less',
        'dir.row': '{path}, {files} files',
        'dir.purposeLabel': 'Purpose',
        'detail.landedLabel': 'Recent',
        'detail.landedCount': '{n} of {total}',
        'manage.fallback': 'When no rule matches, files go here',
        'manage.fallbackHint': 'Everything that cannot be placed lands in this folder',
        'manage.fallbackCurrent': 'That is how it works now',
        'manage.editOf': 'Edit {path}',
        'manage.deleteOf': 'Delete {path}',
        'detail.default': 'fallback folder',
        'misplaced.empty': 'none recorded',
        'misplaced.emptyHint': 'Recent placement decisions and their reasons are listed here.',
        'misplaced.into': 'into',
        'misplaced.pathLabel': 'path',
        'misplaced.folderLabel': 'folder',
        'misplaced.byLabel': 'matched by',
        'detail.byRule': 'a rule',
        'detail.byAgent': 'named by the caller',
        'detail.byDefault': 'the fallback folder',
        'misplaced.timeLabel': 'time',
        'hint.notManaged': 'Opted out: no sorting and no catalog in the prompt. The `.maid` guard still applies; delete `.maid/opt-out` and refresh to resume.',
        'hint.absent': 'It appears after one tidy-up.',
        'hint.error': 'Could not read data',
        'hint.emptyCatalog': 'No folders to organise yet.',
        'hint.noTable': 'No folder table yet.',
        'hint.failed': 'Try refresh again in a moment.',
        'hint.denied': 'Switch to a session that can read files.',
        'hint.noRoots': 'Open a session to see its folder.',
        'hint.degraded': 'This scan took longer than 300 ms. The numbers still hold; it just gets slower as the tree grows.',
        'hint.degradedTitle': '{files} files scanned in {ms} ms',
        'action.dismiss': 'Dismiss',
        'init.action': 'Set up this root',
        'init.busy': 'Setting up…',
        'init.failed': 'Setup did not complete.',
        'init.loading': 'reading this workspace…',
        'init.noRoot': 'no session is running in this workspace; open one and try again.',
        'init.noSession': 'the chosen session is gone; refresh and try again.',
        'init.unavailable': 'This host does not expose that operation. Refresh the page; restart dsh web if it stays missing.',
        'init.title': 'Set up this root',
        'init.template': 'template',
        'init.dirCount': '{n} dirs',
        'init.create': 'create the dirs on disk',
        'init.candidates': 'existing dirs',
        'init.skip': 'skip',
        'init.registerAutonomous': 'register self-managed',
        'init.registerManaged': 'register managed',
        'init.output': 'fallback folder',
        'init.more': 'more options',
        'init.less': 'fewer options',
        'init.customPlaceholder': 'one per line: path:role:purpose:kw1,kw2',
        'init.previewAction': 'Preview change',
        'init.preview': 'Confirm change',
        'init.previewSummary': '{added} added, {removed} removed, {created} dirs will be created',
        'init.confirm': 'Write',
        'init.back': 'Back',
        'init.done': 'Written',
        'init.editDirs': 'Edit catalog',
        'init.hideEdit': 'Hide editor',
        'init.role': 'role',
        'init.switchRole': 'switch role',
        'init.remove': 'remove',
        'init.undo': 'undo',
        'init.add': 'add',
        'init.path': 'path',
        'init.purpose': 'purpose',
        'init.stop': 'Stop managing this root',
        'init.stopHint': 'Stopping never moves files.',
        'init.start': 'Start setup',
        'init.edit': 'Edit',
        'manage.add': '+ New',
        'manage.edit': 'Edit',
        'manage.delete': 'Delete',
        'manage.save': 'Save',
        'manage.create': 'Create',
        'manage.cancel': 'Cancel',
        'manage.path': 'path',
        'manage.pick': 'Choose…',
        'manage.purpose': 'purpose',
        'manage.purposeHint': 'one line: what this folder receives',
        'manage.excludes': 'Excludes',
        'manage.termsHint': 'one line: what does not belong here (optional)',
        'manage.failed': 'save failed',
        'manage.required': 'Still missing: {fields}',
        'manage.pathInvalid': 'A folder name only: no / or \\, and it cannot start with a dot.',
        'manage.confirmRemove': 'Delete {path}? Files stay; the folder simply stops routing.',
        'init.noChanges': 'No changes',
        'init.noChangesHint': 'No changes yet',
        'init.previewCount': 'Preview ({n})',
        'init.pendingRemove': 'to remove',
        'init.pendingAdd': 'to write',
        'init.leave': '← back',
        'init.discard': 'Discard {n} changes',
        'stat.dirs': 'dirs',
        'more.show': '{n} more',
        'setup.entry': 'Set up this root',
        'setup.lead': 'This root has no folder table yet.',
        'setup.detail': 'Add folders; files then route by purpose.',
        'setup.listTitle': 'Folders added',
        'setup.emptyTitle': 'No folders yet',
        'setup.emptyHint': 'Add one folder and files start routing.',
        'setup.addTitle': 'Add a folder',
        'setup.add': 'Add folder',
        'setup.ok': 'Add',
        'setup.cancel': 'Cancel',
        'setup.remove': 'Remove',
        'setup.removeOf': 'Remove {path} from the list; files stay',
        'setup.defaultOf': 'Make {path} the fallback folder',
        'setup.defaultHint': 'Files with no matching rule and no named folder land here.',
        'setup.needDefault': 'No fallback folder chosen',
        'setup.needFields': 'Still missing: {fields}',
        'setup.path': 'path',
        'setup.purpose': 'purpose',
        'setup.excludes': 'excludes',
        'setup.pathPh': 'e.g. 80-Outputs',
        'setup.pathHint': 'Relative to the root, up to 3 segments.',
        'setup.purposePh': 'one line: what belongs here',
        'setup.excludesPh': 'one line on what does not belong; optional',
        'setup.tooMany': 'That is {n} folders. A long table is cut short in the prompt; the rest still match by name and rule.',
        'setup.dup': 'Already added',
        'setup.checkFailed': 'Could not check the path; try again.',
        'setup.count': '{n} folders',
        'setup.next': 'Next · {n}',
        'setup.confirmTitle': 'Confirm',
        'setup.confirmDefault': 'fallback: {path}',
        'setup.confirmPromise': 'Nothing is moved or deleted.',
        'setup.write': 'Write and enable',
        'setup.back': 'Back',
        'setup.leave': '← Back',
        'setup.writing': 'Writing…',
        'setup.scanning': 'Written; counting files…',
        'setup.done': 'On · {dirs} folders',
        'setup.doneMeta': '{files} files',
        'setup.scanPending': 'Enabled, but files are not counted yet; retry on the Scan tab.',
        'setup.doneNote': 'Directories, Log, and Scan are now available.',
        'setup.doneAction': 'View folders',
        'setup.failed': 'Setup did not finish.',
        'setup.retry': 'Retry',
        'setup.errorKept': 'The {n} folders are still here; retry.',
        'more.hide': 'Collapse',
        'refresh': 'refresh',
        'age.now': 'just now',
        'age.seconds': '{n}s ago',
        'age.minutes': '{n}m ago',
        'age.hours': '{n}h ago',
        'age.days': '{n}d ago',
      },
    };

    /**
     * Fill `{name}` placeholders in one translated string.
     * @param {string} template - translated text.
     * @param {Record<string, string|number>} params - substitutions.
     * @returns {string} the filled text.
     */
    function fill(template, params) {
      return String(template).replace(/\{(\w+)\}/gu, (whole, key) => (Object.hasOwn(params, key) ? String(params[key]) : whole));
    }

    /**
     * Turn one failed Remote result into an Error carrying its wire code.
     * @param {object|undefined} result - the `{ ok: false, error }` envelope.
     * @returns {Error} the failure as an exception.
     */
    function failureOf(result) {
      const error = result?.error ?? {};
      const code = typeof error.code === 'string' ? error.code : 'remote/failed';
      const message = typeof error.message === 'string' && error.message.length > 0 ? error.message : code;
      const failure = new Error(`${code}: ${message}`);
      failure.remoteCode = code;
      return failure;
    }

    /**
     * Load and parse the status snapshot of one Session's root.
     *
     * Every generated Remote method resolves a `RemoteResult`; a missing file is a
     * failure branch, never an empty page. `stat` answers presence first so a fresh
     * root reads as "no snapshot yet" rather than as an error.
     * @param {object} remote - the Client Remote face.
     * @param {string} sessionId - Session whose workspace root is the base.
     * @param {AbortSignal} signal - caller cancellation.
     * @returns {Promise<object>} the parsed document.
     * @throws {Error} with `absent: true` when the snapshot does not exist yet.
     */
    /**
     * Map the v2 status projection onto the fields this card renders.
     *
     * The projection carries `purpose`/`includes` and a `routes` ledger; the card
     * renders `about`/`keywords` and a `misplaced` list. Keeping the mapping in
     * one function means the render code never learns two names for one fact.
     * @param {object | undefined} document - parsed status.json.
     * @returns {object | undefined} the document in the shape the card reads.
     */
    /**
     * Show a directory's file count, or a dash when this root has not been
     * counted yet: an unscanned directory is unknown, not empty.
     * @param {unknown} files - the projected count.
     * @returns {string} the cell text.
     */
    function fileCount(files) {
      return typeof files === 'number' && Number.isFinite(files) ? String(files) : '—';
    }

    function adaptStatus(document) {
      if (document?.schemaVersion !== '2') return document;
      const dirs = Array.isArray(document.catalog?.dirs) ? document.catalog.dirs : [];
      const routes = Array.isArray(document.routes) ? document.routes : [];
      return {
        ...document,
        catalog: {
          ...document.catalog,
          dirs: dirs.map((dir) => ({
            ...dir,
            about: dir.purpose ?? '',
            keywords: Array.isArray(dir.includes) ? dir.includes : [],
          })),
        },
        misplaced: routes.map((route) => ({
          at: route.at ?? null,
          path: `${route.dir ?? ''}/${route.name ?? ''}`,
          suggested: route.dir ?? null,
          score: null,
          decided_by: route.decided_by ?? null,
          intent_source: route.intent_source ?? null,
        })),
      };
    }

    async function loadStatus(remote, sessionId, signal) {
      const head = await remote.workspaceFiles.stat(sessionId, STATUS_PATH, signal);
      if (head?.ok !== true) {
        // Only a missing file means "no snapshot yet"; a denied or broken read is an
        // error the user must see, not an uninitialised root in disguise.
        if (head?.error?.code === 'workspace-file/not-found') {
          const absent = new Error('status snapshot is absent');
          absent.absent = true;
          throw absent;
        }
        throw failureOf(head);
      }
      // `WorkspaceFileRange.offset` is a 1-based line number, not a byte offset.
      // Pages are joined by a newline: `text` carries no terminator after the last line,
      // so concatenating pages verbatim would glue two lines into one.
      let offset = 1;
      let text = '';
      let last;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await remote.workspaceFiles.read(sessionId, STATUS_PATH, { offset, limit: PAGE_LINES }, signal);
        if (result?.ok !== true) throw failureOf(result);
        const part = result.value;
        if (typeof part?.text !== 'string') throw new Error('workspaceFiles.read returned no text');
        text += (page === 0 ? '' : '\n') + part.text;
        last = part;
        if (part.eof === true) break;
        const next = part.offset + part.lines;
        if (!(next > offset)) break;
        offset = next;
      }
      if (last !== undefined && last.eof !== true) {
        throw new Error(`status snapshot exceeds ${MAX_PAGES} pages of ${PAGE_LINES} lines`);
      }
      if (text.trim() === '') {
        const absent = new Error('status snapshot is empty');
        absent.absent = true;
        throw absent;
      }
      return adaptStatus(JSON.parse(text));
    }

    /**
     * Collect the distinct workspace roots the panel can read, newest first.
     *
     * The Catalog lives in `<root>/.maid`, and a root is only addressable through a
     * Session that ran in it, so each root keeps its most recently updated Session
     * id as the reader.
     * @param {object|undefined} list - `SessionListState` snapshot.
     * @returns {{ cwd: string, sessionId: string, updatedAt: number }[]} the roots.
     */
    function rootsOf(list) {
      const byCwd = new Map();
      const ids = Array.isArray(list?.ids) ? list.ids : [];
      for (const id of ids) {
        const summary = list?.byId?.[id];
        const cwd = typeof summary?.cwd === 'string' ? summary.cwd : '';
        if (cwd.length === 0) continue;
        const updatedAt = Number.isFinite(summary?.updatedAt) ? summary.updatedAt : 0;
        const seen = byCwd.get(cwd);
        if (seen === undefined || updatedAt > seen.updatedAt) byCwd.set(cwd, { cwd, sessionId: String(id), updatedAt });
      }
      return [...byCwd.values()].sort((left, right) => right.updatedAt - left.updatedAt);
    }

    /** Roots whose degraded notice was dismissed for good; storage may be unavailable. */
    const DISMISS_KEY = 'dsh-file-maid.degraded.dismissed';
    function readDismissedRoots() {
      try {
        if (typeof localStorage === 'undefined') return [];
        const raw = localStorage.getItem(DISMISS_KEY);
        if (raw === null || raw === '') return [];
        // Earlier builds stored one bare root; migrate it instead of showing the notice again.
        if (raw.trim().startsWith('[') !== true) return [raw];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string' && item.length > 0) : [];
      } catch {
        return [];
      }
    }
    function writeDismissedRoots(roots) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(DISMISS_KEY, JSON.stringify(roots));
      } catch {
        /* private mode or a full quota: the notice simply returns next time */
      }
    }

    /**
     * The sessions list store, or undefined when the service is unavailable.
     * @returns {object | undefined} a snapshot store.
     */
    function sessionListStore() {
      try {
        return services?.sessions?.list;
      } catch {
        return undefined;
      }
    }

    /**
     * Subscribe to the sessions list. The card is not rendered by a slot, so it cannot
     * use the `useSessions` standard prop and watches the service instead.
     * @returns {object | undefined} the current list snapshot.
     */
    function useSessionServiceList() {
      const [value, setValue] = React.useState(() => {
        const store = sessionListStore();
        try {
          return store?.getSnapshot?.();
        } catch {
          return undefined;
        }
      });
      React.useEffect(() => {
        const store = sessionListStore();
        if (store === undefined || typeof store.subscribe !== 'function') return undefined;
        return store.subscribe(() => {
          try {
            setValue(store.getSnapshot());
          } catch {
            /* a disposed store keeps the last snapshot */
          }
        });
      }, []);
      return value;
    }

    /**
     * The workspace root the main view is showing right now. The sessions service keeps
     * no "current" flag, so this reads the retain counts the sidebar itself uses: a row
     * held by `mainView` is drawn in the centre column, and the most recently updated of
     * those is the one on screen.
     * @param {object} list - `useSessions` snapshot (`ids` + `byId`).
     * @returns {string} absolute cwd, or '' when nothing is open.
     */
    function activeCwdOf(list) {
      const ids = Array.isArray(list?.ids) ? list.ids : [];
      let best;
      for (const id of ids) {
        const summary = list?.byId?.[id];
        if (Number(summary?.retainedBy?.mainView ?? 0) <= 0) continue;
        const cwd = typeof summary?.cwd === 'string' ? summary.cwd : '';
        if (cwd.length === 0) continue;
        const updatedAt = Number.isFinite(summary?.updatedAt) ? summary.updatedAt : 0;
        if (best === undefined || updatedAt > best.updatedAt) best = { cwd, updatedAt };
      }
      return best === undefined ? '' : best.cwd;
    }

    /**
     * Shorten an absolute path for a picker or a table cell.
     * @param {string} path - absolute path.
     * @returns {string} the trailing segments.
     */
    function shortPath(path) {
      const parts = String(path).split('/').filter((part) => part.length > 0);
      if (parts.length <= 2) return String(path);
      return `…/${parts.slice(-2).join('/')}`;
    }

    /**
     * The last path segment, which is the only part a person reads at a glance.
     * @param {string} path - absolute directory path.
     * @returns {string} the folder name, or the whole path when it ends in a separator.
     */
    function folderName(path) {
      const parts = String(path).split('/').filter((part) => part.length > 0);
      return parts.length === 0 ? String(path) : parts[parts.length - 1];
    }

    /**
     * Render one relative age for an ISO timestamp.
     * @param {string|undefined} iso - when the event happened.
     * @param {Function} t - bound translate function.
     * @param {number} nowMs - current time.
     * @returns {string} the localized age.
     */
    function formatAge(iso, t, nowMs) {
      const at = typeof iso === 'string' ? Date.parse(iso) : Number.NaN;
      if (!Number.isFinite(at)) return '';
      const seconds = Math.max(0, Math.round((nowMs - at) / 1000));
      if (seconds < 5) return t('age.now');
      if (seconds < 60) return fill(t('age.seconds'), { n: seconds });
      const minutes = Math.round(seconds / 60);
      if (minutes < 60) return fill(t('age.minutes'), { n: minutes });
      const hours = Math.round(minutes / 60);
      if (hours < 24) return fill(t('age.hours'), { n: hours });
      return fill(t('age.days'), { n: Math.round(hours / 24) });
    }

    /**
     * Render a byte count the way a reader scans it: one decimal above a kilobyte.
     * @param {number} bytes - size in bytes.
     * @returns {string} `842 B`, `14.2 KB`, `1.2 MB`.
     */
    function formatSize(bytes) {
      const value = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
      if (value < 1024) return `${Math.round(value)} B`;
      const units = ['KB', 'MB', 'GB', 'TB'];
      let scaled = value / 1024;
      let unit = 0;
      while (scaled >= 1024 && unit < units.length - 1) {
        scaled /= 1024;
        unit += 1;
      }
      return `${scaled >= 10 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[unit]}`;
    }

    /**
     * Render one short clock time for an ISO timestamp.
     * @param {string|undefined} iso - the record time.
     * @returns {string} `HH:MM`, or an empty string.
     */
    function formatClock(iso, nowMs) {
      const at = typeof iso === 'string' ? Date.parse(iso) : Number.NaN;
      if (!Number.isFinite(at)) return '';
      const date = new Date(at);
      const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
      const today = new Date(nowMs ?? Date.now());
      const sameDay =
        date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
      // A record from another day keeps its date, otherwise two entries a day apart
      // both read as "09:12" and the ordering looks wrong.
      return sameDay ? clock : `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${clock}`;
    }


    /**
     * Turn one wire failure into a line a person can act on.
     *
     * The Host writes plain sentences for everything the user can fix, so the
     * code is only a fallback: it names the failure when the Host had nothing to
     * say, which is the case for transport errors.
     * @param {object} result - `{ errors }` from a call.
     * @param {string} fallback - what to say when there is no message.
     * @returns {string} the line to show.
     */
    function describeError(result, fallback) {
      const first = Array.isArray(result?.errors) && result.errors.length > 0 ? result.errors[0] : undefined;
      if (first === undefined) return fallback;
      const message = typeof first.message === 'string' ? first.message.trim() : '';
      if (message.length > 0) return message;
      return typeof first.code === 'string' && first.code.length > 0 ? `${fallback}（${first.code}）` : fallback;
    }


    return {
      inject: ['slots', 'remote', 'remote.workspaceFiles', 'locale', 'sessions'],
      apply(ctx) {
        services = ctx;
        const t = ctx.locale.bind(NS);
        ctx.effect(() => ctx.locale.register(NS, 'zh', DICT.zh));
        ctx.effect(() => ctx.locale.register(NS, 'en', DICT.en));
        /**
         * Mount the initialization endpoint.
         *
         * Optional by construction: a Client whose gateway has no `$mount`, or a Host
         * that never registered the descriptor, simply leaves the card read-only.
         */
        ctx.effect(() => {
          let unmount;
          let cancelled = false;
          const mount = async () => {
            const remote = typeof ctx.get === 'function' ? ctx.get('remote') : undefined;
            if (remote === undefined || typeof remote.$mount !== 'function') return;
            try {
              const dispose = await remote.$mount({ package: 'dsh-file-maid', descriptors: MANAGE_DESCRIPTORS });
              if (cancelled) await dispose();
              else unmount = dispose;
            } catch (error) {
              // A Host without the endpoint is the expected case for an older build:
              // the button stays hidden rather than throwing into the page console.
              if (typeof console !== 'undefined' && typeof console.debug === 'function') console.debug('file-maid: init endpoint unavailable', error);
            }
          };
          void mount();
          return () => {
            cancelled = true;
            if (unmount !== undefined) void unmount();
          };
        });

        /** Component-local stylesheet: one ledger page, tokens only. */
        const styles = h(
          'style',
          { 'data-file-maid': 'page-style' },
          [
            '[data-file-maid="page"]{display:flex;flex-direction:column;gap:8px;max-width:1080px;margin:0 auto;padding:16px 20px 20px;font-size:var(--maid-fs-title);line-height:1.45;color:var(--dsw-alias-label-primary);height:100%;overflow:auto;box-sizing:border-box;}',
            '[data-file-maid="header"]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
            '[data-file-maid="title"]{font-size:14px;font-weight:600;}',
            '[data-file-maid="spacer"]{flex:1 1 auto;}',
            '[data-file-maid="muted"]{color:var(--dsw-alias-label-secondary);}',
            '[data-file-maid="statetip"]{display:inline-flex;align-items:center;flex:0 1 auto;min-width:0;max-width:50%;}',
            '[data-file-maid="badge"]{display:inline-flex;align-items:center;flex:0 1 auto;gap:4px;min-width:0;max-width:100%;padding:0;border:0;background:none;font-size:var(--maid-fs-body);font-weight:500;letter-spacing:.2px;white-space:nowrap;color:color-mix(in srgb,var(--maid-tone,currentColor) 58%,var(--dsw-alias-label-primary));cursor:inherit;}',
            '[data-file-maid="badgelabel"]{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
            '[data-file-maid="badgedot"]{flex:0 0 auto;width:6px;height:6px;border-radius:50%;background:var(--maid-tone,currentColor);box-shadow:0 0 0 2px color-mix(in srgb,var(--maid-tone,currentColor) 18%,transparent);}',
            '[data-file-maid="mono"]{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}',
            '[data-file-maid="select"]{min-width:0;max-width:100%;min-height:28px;padding:0 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:5px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;font-size:var(--maid-fs-body);}',
            '[data-file-maid="select"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
            '[data-file-maid="meta"]{display:flex;flex-wrap:wrap;gap:4px 14px;align-items:center;color:var(--dsw-alias-label-secondary);}',
            '[data-file-maid="banner"]{display:flex;align-items:flex-start;gap:8px;padding:6px 10px;border-left:2px solid var(--dsw-alias-state-warn-primary);border-radius:4px;background:var(--dsw-alias-bg-layer-2);}',
            '[data-file-maid="bannermeta"]{flex:0 0 auto;color:var(--dsw-alias-label-secondary);font-size:var(--maid-fs-meta);white-space:nowrap;}',
            '[data-file-maid="bannertext"]{flex:1 1 auto;min-width:0;}',
            '[data-file-maid="bannerclose"]{flex:0 0 auto;margin:-1px -2px 0 0;padding:0 2px;border:0;background:none;color:var(--dsw-alias-label-secondary);font-size:var(--maid-fs-num);line-height:1.3;cursor:pointer;border-radius:3px;}',
            '[data-file-maid="bannerclose"]:hover{color:var(--dsw-alias-label-primary);}',
            '[data-file-maid="bannerclose"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
            '[data-file-maid="banner"][data-tone="error"]{border-left-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);}',
            '[data-file-maid="banner"][data-tone="warn"]{border-left-color:var(--dsw-alias-state-warn-primary);}',
            '[data-file-maid="table"]{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;}',
            '[data-file-maid="th"]{padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:var(--maid-fs-body);font-weight:500;text-align:left;white-space:nowrap;}',
            '[data-file-maid="th"][data-align="num"]{text-align:right;}',
            '[data-file-maid="td"]{padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:baseline;}',
            '[data-file-maid="tr"]:hover{background:var(--dsw-alias-bg-layer-1);}',
            '[data-file-maid="td"][data-align="num"]{text-align:right;white-space:nowrap;}',
            '[data-file-maid="cell"]{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:38ch;}',
            '[data-file-maid="row-toggle"]{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:0;border:0;background:none;color:inherit;font:inherit;cursor:pointer;text-align:left;}',
            '[data-file-maid="row-toggle"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:4px;}',
            '[data-file-maid="detail"]{padding:4px 8px 10px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);}',
            '[data-file-maid="button"]{padding:2px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;white-space:nowrap;cursor:pointer;}',
            '[data-file-maid="cardhead"] [data-file-maid="button"]{flex:0 0 auto;}',
            '[data-file-maid="button"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
            /* A misplaced record is a two-line ledger row: name and target share the
               first line, the folder it actually sits in and its age the second. Both
               right-hand cells are flush right, so ten records read as two columns
               instead of ten ragged sentences in a 252px body. */
            '[data-file-maid="list"]{margin:0;padding:0;list-style:none;}',
            '[data-file-maid="item"]{display:flex;flex-direction:column;gap:0;min-width:0;padding:1px 0;border-top:1px solid var(--dsw-alias-border-l1);}',
            '[data-file-maid="itemtoggle"]{display:flex;flex-direction:column;gap:0;width:100%;min-width:0;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer;border-radius:5px;}',
            '[data-file-maid="itemtoggle"]:hover{background:var(--dsw-alias-interactive-bg-hover);}',
            '[data-file-maid="itemtoggle"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
            '[data-file-maid="item"] [data-file-maid="chevron"]{flex:0 0 auto;width:10px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:var(--maid-fs-meta);}',
            '[data-file-maid="itemdetail"]{display:flex;flex-direction:column;gap:1px;padding:2px 0 4px 18px;}',
            '[data-file-maid="itemfact"]{display:flex;align-items:baseline;gap:8px;min-width:0;}',
            '[data-file-maid="itemfactlabel"]{flex:0 0 44px;white-space:nowrap;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:var(--maid-fs-meta);line-height:1.45;}',
            '[data-file-maid="itemstamp"]{flex:1 1 auto;min-width:0;font-size:var(--maid-fs-meta);line-height:1.45;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}',
            '[data-file-maid="item"]:first-child{border-top:0;}',
            '[data-file-maid="itemhead"]{display:flex;align-items:baseline;gap:8px;min-width:0;overflow:hidden;min-height:20px;}',
            '[data-file-maid="itemname"]{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:var(--maid-fs-row);}',
            '[data-file-maid="itemtarget"]{flex:0 0 auto;min-width:0;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-brand-primary);font-size:var(--maid-fs-meta);line-height:1.4;}',
            
            '[data-file-maid="itemage"]{flex:0 0 auto;margin-left:auto;font-variant-numeric:tabular-nums;white-space:nowrap;}',
            /* The empty state is the same two lines on all three pages: what this list
               is, then one sentence about why it is empty and what fills it. Two tiers of
               type on the shared scale, no box, no icon — the shape a reader meets when
               the list is there is the shape they meet when it is not. */
            '[data-file-maid="emptystate"]{display:flex;flex-direction:column;gap:2px;padding:6px 0 8px;color:var(--dsw-alias-label-secondary);font-size:var(--maid-fs-row);line-height:1.45;}',
            '[data-file-maid="emptyhint"]{color:var(--dsw-alias-label-tertiary);font-size:var(--maid-fs-meta);line-height:1.45;}',
            '[data-file-maid="emptystate"]>[data-file-maid="ghostbutton"]{align-self:flex-start;margin-top:4px;}',
            /* Screen-reader-only label: the arrow is decoration, the words behind it are not. */
            '[data-file-maid="sronly"]{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;}',
            /* The wide page has room for 1080px, which would stretch one record into a
               line the eye cannot follow back to its start; keep the measure readable. */
            '[data-file-maid="page"] [data-file-maid="list"]{max-width:640px;}',
            '[data-file-maid="views"]{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:2px;height:32px;padding:2px;border-radius:var(--dsw-radius-sm,8px);box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);}',
            '[data-file-maid="sectionhead"]>span:first-child{line-height:24px;}',
            '[data-file-maid="sectionhead"]{display:flex;align-items:center;gap:6px;min-width:0;min-height:24px;margin:0;padding:0;color:var(--dsw-alias-label-secondary);font-size:var(--maid-fs-meta);font-weight:600;line-height:1.4;letter-spacing:.3px;}',
            /* One section head for all three pages: a quiet overline that names the
               list, an optional count right after it, and at most one action pushed to
               the right edge. Quiet on purpose — the rows are the answer, the head only
               says which answer. The scan page's three group heads carry the same
               measure, so a reader learns the pattern once. */
            '[data-file-maid="sectionhead"] [data-file-maid="linkbutton"]{font-size:var(--maid-fs-meta);line-height:1.4;padding:0 4px;}',
            '[data-file-maid="managebox"]{display:flex;flex-direction:column;gap:6px;margin:0 0 10px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);}',
            '[data-file-maid="managerow"]{display:flex;align-items:center;gap:8px;min-width:0;}',
            '[data-file-maid="input"]{flex:1 1 80px;min-width:0;min-height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:5px;background:transparent;color:inherit;font:inherit;font-size:var(--maid-fs-body);}',
            '[data-file-maid="manageactions"]{display:flex;align-items:center;gap:8px;margin-top:4px;}',
            '[data-file-maid="required"]{color:var(--dsw-alias-brand-primary);}',
            '[data-file-maid="input"][data-invalid="true"]{border-color:var(--dsw-alias-border-l2,currentColor);}',
            '[data-file-maid="managehint"]{color:var(--dsw-alias-label-tertiary);font-size:var(--maid-fs-meta);}',
            '[data-file-maid="manageerror"]{color:var(--dsw-alias-label-primary);font-size:var(--maid-fs-meta);border-left:2px solid var(--dsw-alias-state-error-primary);padding-left:6px;}',
            '[data-file-maid="star"]{flex:0 0 auto;color:var(--dsw-alias-brand-primary);font-size:var(--maid-fs-meta);line-height:1.4;cursor:help;}',
            '[data-file-maid="linkbutton"]{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;padding:0 6px;border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--maid-fs-body);line-height:1.4;min-height:24px;white-space:nowrap;cursor:pointer;border-radius:5px;}',
            '[data-file-maid="linkbutton"]:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);}',
            '[data-file-maid="linkbutton"]:disabled{opacity:.5;cursor:default;}',
            '[data-file-maid="linkbutton"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
            '[data-file-maid="linkbutton"][data-tone="danger"]:hover:not(:disabled){color:var(--dsw-alias-state-error-primary,#e5484d);}',
            '[data-file-maid="viewslot"][data-disabled="true"]{opacity:.55;}',
            '[data-file-maid="viewslot"][data-disabled="true"] [role="tab"],[data-file-maid="viewslot"][data-disabled="true"] button{pointer-events:none;cursor:default;}',
            /* Same geometry as the sidebar row: icon + label, one compact track. */
            /* The sidebar card: one header row, then the panel body when open. */
            '[data-file-maid="card"]{--maid-row:32px;display:flex;flex-direction:column;width:100%;box-sizing:border-box;min-width:0;flex:0 0 auto;margin:0 0 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1);overflow:hidden;}',
            '[data-file-maid="card"][data-open="false"]{height:var(--maid-row);box-sizing:border-box;}',
            '[data-file-maid="cardhead"]{display:flex;align-items:center;gap:6px;width:100%;min-height:32px;padding:0 6px;color:var(--dsw-alias-label-secondary);font-size:var(--maid-fs-title);line-height:1.4;}',
            '[data-file-maid="cardhead"]:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
            '[data-file-maid="card"][data-open="true"] [data-file-maid="cardhead"]{color:var(--dsw-alias-label-primary);font-weight:600;}',
            '[data-file-maid="cardtoggle"]{display:flex;align-items:center;gap:4px;min-width:0;flex:1 1 auto;height:100%;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer;overflow:hidden;}',
            '[data-file-maid="cardtoggle"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;border-radius:4px;}',
            '[data-file-maid="chevron"]{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;}',
            '[data-file-maid="cardtitle"]{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
            '[data-file-maid="cardsuffix"]{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-weight:500;}',
            '[data-file-maid="cardhead"] [data-file-maid="badge"]{flex:0 1 auto;min-width:0;margin-left:5px;padding:0 5px;font-size:var(--maid-fs-meta);line-height:1.4;min-height:15px;}',
            '[data-file-maid="card"]>[data-file-maid="tabpage"],[data-file-maid="cardbody"]{padding:0 6px 6px;}',
            /* `scroll-padding-top` is the pinned strip's height: when the browser scrolls a
               focused row into view (shift-tab up a long list) it stops short of the strip
               instead of parking the row underneath it. Layout is unaffected. */
            '[data-file-maid="cardbody"]{max-height:min(46vh,320px);overflow-y:auto;overscroll-behavior:contain;scroll-padding-top:42px;}',
            /* The section switch is the card's control, not part of its content: it keeps
               its place at the top of the scrolling body while the rows pass underneath.
               Sticky rather than a second wrapper, so the body stays the only scroll port
               (no nested scrollbars, no double wheel handoff) and the row rhythm does not
               move by a pixel. The opaque card colour is what hides the rows behind it.
               Scoped to the card on purpose: the wide page scrolls as a whole document,
               where a sticky row would stick to the viewport instead of the panel. */
            '[data-file-maid="card"] [data-file-maid="viewslot"]{position:sticky;top:0;z-index:2;padding:2px 0 4px;background:var(--dsw-alias-bg-layer-1);}',
            /* Layout is declared in CSS as well as inline: a stale or stripped inline style
               must never leave the card and the region sharing one row. */
            /* The card sits in a host of its own, prepended to the browsing region; the
               region is switched to a column so the two stack instead of sharing a row. */
            /* The host keeps the region's inline inset on the right so the card lines up
               with the segmented row above it instead of running to the column edge.
               The layout itself is applied from JS (`applyPanelLayout`), because a sheet
               rule would need `!important` to beat the region's inline flex values. */
            '[data-file-maid-panel]>[data-file-maid="cardslot"]{min-width:0;box-sizing:border-box;padding:0 var(--dsh-sidebar-inline-padding,12px) 6px 0;}',
            // Border-box for every element this plugin owns inside the card: a 100%-wide
            // row with horizontal padding would otherwise overflow into the card's
            // `overflow:hidden` and lose its right padding (the refresh button ended up
            // flush against the card edge).
            '[data-file-maid="card"],[data-file-maid="card"] [data-file-maid]{box-sizing:border-box;}',
                        /* Compact scale inside the card: the sidebar column is 264px wide and the
               region above and below it is dense, so every row is tightened here. */
            '[data-file-maid="card"] [data-file-maid="tabpage"]{gap:8px;padding:0 0 2px;font-size:var(--maid-fs-row);line-height:1.45;}',
            '[data-file-maid="card"] [data-file-maid="banner"]{padding:4px 8px;font-size:var(--maid-fs-body);line-height:1.4;}',
            '[data-file-maid="card"] [data-file-maid="muted"]{font-size:var(--maid-fs-body);}',
            '[data-file-maid="card"] [data-file-maid="badge"]{font-size:var(--maid-fs-meta);line-height:1.4;min-height:20px;}',
            /* State badges carry colour: a reader should see "not initialised" without
               reading the words, and hover tells why. */
            /* The badge inherits the header's own cursor; a help cursor promised a native
               tooltip that this host never draws. */
            '[data-file-maid="statetip"]{display:inline-flex;align-items:center;flex:0 0 auto;min-width:0;outline:none;border-radius:4px;}',
            '[data-file-maid="statetip"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
            '[data-file-maid="statetipbox"]{z-index:9999;box-sizing:border-box;padding:5px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-3));box-shadow:var(--dsw-elevation-prominent,0 8px 20px rgba(0,0,0,.34));color:var(--dsw-alias-label-primary);font-size:var(--maid-fs-body);line-height:1.45;white-space:normal;pointer-events:none;}',
            '[data-file-maid="badge"][data-tone="ok"]{--maid-tone:var(--dsw-alias-state-success-primary,#22c55e);}',
            '[data-file-maid="badge"][data-tone="warn"]{--maid-tone:var(--dsw-alias-state-warn-primary,#f59e0b);}',
            '[data-file-maid="badge"][data-tone="error"]{--maid-tone:var(--dsw-alias-state-error-primary,#ef4444);}',
            '[data-file-maid="badge"][data-tone="muted"]{--maid-tone:var(--dsw-alias-label-secondary);}',
            '[data-file-maid="card"] [data-file-maid="button"]{display:inline-flex;align-items:center;padding:0 9px;font-size:var(--maid-fs-body);line-height:1.4;min-height:24px;}',
            '[data-file-maid="rootline"]{display:flex;align-items:baseline;gap:6px;min-width:0;max-width:100%;}',
            '[data-file-maid="rootlabel"]{flex:0 0 auto;color:var(--dsw-alias-label-secondary);font-size:var(--maid-fs-meta);letter-spacing:.2px;}',
            '[data-file-maid="rootvalue"]{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--maid-fs-row);font-weight:500;color:var(--dsw-alias-label-primary);opacity:.86;}',
            '[data-file-maid="card"] [data-file-maid="tabdetail"]{padding:0 2px 5px 18px;}',
'[data-file-maid="card"] .file-maid-views{max-width:none;--segmented-tabs-inset:2px;}',
            /* Mid-scale: the shipped control draws 34px tabs at 14px text, which reads
               oversized in a 264px card; 22px/11px was cramped. Scale the tab, the text and
               the glyph together so the slider and the label keep one metric. */
            '[data-file-maid="card"] .file-maid-views [role="tab"]{flex:1 1 0;min-width:0;height:28px;font-size:var(--maid-fs-title);line-height:1;padding:0 2px;}',
            '[data-file-maid="views"]>[data-file-maid="view"]{min-width:0;padding:0 8px;border-radius:calc(var(--dsw-radius-sm,8px) - 2px);background:transparent;gap:6px;}',
            '[data-file-maid="views"]>[data-file-maid="view"][aria-selected="true"]{color:var(--dsw-alias-label-primary);font-weight:600;background:var(--dsw-alias-bg-layer-2);box-shadow:0 1px 2px rgba(0,0,0,.12);}',
            /* The label carries a 22px line box from the tab pill; CJK glyphs sit low in it,
               so the icon and the word disagree by a pixel. Collapse the line box and let
               flex centring align the two boxes instead. */
            '[data-file-maid="viewlabel"]{display:inline-flex;align-items:center;gap:6px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1;}',
            '[data-file-maid="viewlabel"]>span{display:inline-flex;align-items:center;line-height:1;}',
            '[data-file-maid="viewlabel"]>svg{display:block;flex:0 0 auto;}',
            '.file-maid-views{max-width:360px;}',
            '[data-file-maid="view"]{display:inline-flex;align-items:center;justify-content:center;gap:4px;min-height:28px;padding:0 10px;border:0;border-radius:6px;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--maid-fs-body);line-height:1;cursor:pointer;white-space:nowrap;}',
            '[data-file-maid="view"]:hover{color:var(--dsw-alias-label-primary);}',
            '[data-file-maid="view"][aria-selected="true"]{color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);}',
            '[data-file-maid="view"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
            /* The scan tab: three groups instead of twelve flat rows.
               Group heads are quiet overlines in the secondary colour — the figures and
               the state words below them are the answer, not the labels. Three figures
               share one row (count, count, duration) because they are read together;
               every remaining value is flush right, so the right edge becomes the axis
               the eye can follow down the group instead of twelve ragged pairs. */
            '[data-file-maid="scanlayout"]{display:flex;flex-direction:column;gap:var(--maid-gap-section);min-width:0;}',
            '[data-file-maid="scangroup"]{display:flex;flex-direction:column;gap:var(--maid-gap-head);min-width:0;}',
            '[data-file-maid="scangroup"]>[data-file-maid="sectionhead"]{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0;color:var(--dsw-alias-label-secondary);font-size:var(--maid-fs-meta);font-weight:600;line-height:1.4;letter-spacing:.3px;}',
            '[data-file-maid="scanstat"]{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0 8px;}',
            '[data-file-maid="scancell"]{display:flex;flex-direction:column;min-width:0;}',
            '[data-file-maid="scancell"]>[data-file-maid="scanval"]{flex:0 0 auto;margin-left:0;text-align:left;font-size:var(--maid-fs-num);font-weight:600;line-height:1.3;}',
            '[data-file-maid="scanlabel"]{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:var(--maid-fs-meta);line-height:1.4;}',
            '[data-file-maid="scanact"]{justify-content:center;gap:4px;}',
            '[data-file-maid="scanact"]:hover{border-color:var(--dsw-alias-brand-primary,currentColor);background:var(--dsw-alias-interactive-bg-hover,transparent);}',
            '[data-file-maid="scanact"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,currentColor);outline-offset:1px;}',
            '[data-file-maid="scanact"][aria-busy="true"]{opacity:.55;cursor:progress;}',
            '[data-file-maid="morebar"]{min-height:24px;}',
            '[data-file-maid="emptystate"] [data-file-maid="scanact"]{min-height:28px;padding:0 12px;}',
            '[data-file-maid="scanstatus"]{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-top:4px;font-size:var(--maid-fs-meta);color:var(--dsw-alias-label-secondary);}',
            '[data-file-maid="scanverdict"][data-tone="warn"]{padding-left:6px;border-left:2px solid var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-label-primary);}',
            '[data-file-maid="scanaside"][data-tone="warn"]{color:var(--dsw-alias-state-warn-primary);}',
            '[data-file-maid="scannote"]{margin-top:4px;font-size:var(--maid-fs-meta);line-height:1.4;min-height:15px;color:var(--dsw-alias-label-secondary);}',
            '[data-file-maid="scanrows"]{display:flex;flex-direction:column;margin-top:0;min-width:0;}',
            '[data-file-maid="rulegroup"]{margin-top:10px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px;}',
            '[data-file-maid="rulecount"]{font-size:var(--maid-fs-meta);color:var(--dsw-alias-label-secondary);}',
            '[data-file-maid="rulelist"]{display:flex;flex-direction:column;gap:2px;}',
            '[data-file-maid="rulerow"]{display:flex;align-items:center;gap:6px;min-height:24px;font-size:var(--maid-fs-meta);}',
            '[data-file-maid="rulematch"]{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
            '[data-file-maid="ruletarget"]{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);}',
            '[data-file-maid="ruleform"]{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:6px;}',
            '[data-file-maid="ruleinput"]{flex:1 1 96px;min-width:0;height:26px;padding:0 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:none;color:inherit;font:inherit;}',
            '[data-file-maid="ruledir"]{height:26px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:none;color:inherit;font:inherit;}',
            '[data-file-maid="rulesave"]{min-height:26px;padding:0 8px;border:1px solid var(--dsw-alias-brand-primary);border-radius:6px;background:none;color:var(--dsw-alias-brand-primary);font-size:var(--maid-fs-meta);cursor:pointer;}',
            '[data-file-maid="rulesave"]:disabled{opacity:.5;cursor:not-allowed;}',
            '[data-file-maid="missrow"]{min-width:0;padding:3px 0;border-top:1px solid var(--dsw-alias-border-l1);}',
            '[data-file-maid="missrow"]:first-child{border-top:0;}',
            '[data-file-maid="misstoggle"]{display:flex;align-items:baseline;gap:6px;width:100%;min-height:20px;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer;}',
            '[data-file-maid="missname"]{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--maid-fs-body);}',
            '[data-file-maid="missage"]{flex:0 0 auto;font-size:var(--maid-fs-meta);color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}',
            '[data-file-maid="misssub"]{display:flex;gap:6px;justify-content:space-between;min-width:0;padding-left:2px;}',
            '[data-file-maid="missdim"]{font-size:var(--maid-fs-meta);color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums;}',
            '[data-file-maid="missdetail"]{display:flex;flex-direction:column;gap:2px;padding:4px 0 2px;}',
            '[data-file-maid="missfact"]{display:flex;gap:6px;min-width:0;font-size:var(--maid-fs-meta);}',
            '[data-file-maid="missfactlabel"]{flex:0 0 44px;color:var(--dsw-alias-label-secondary);}',
            '[data-file-maid="missfactvalue"]{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
            '[data-file-maid="missact"]{align-self:flex-end;min-height:24px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:none;color:var(--dsw-alias-brand-primary);font-size:var(--maid-fs-meta);cursor:pointer;}',
            '[data-file-maid="missact"]:disabled{color:var(--dsw-alias-label-secondary);cursor:not-allowed;}',
            '[data-file-maid="ackbar"]{display:flex;align-items:center;gap:8px;justify-content:space-between;min-height:24px;margin-top:4px;padding:0 6px;border-radius:6px;background:var(--dsw-alias-bg-l2,transparent);font-size:var(--maid-fs-meta);}',
            '[data-file-maid="acktext"]{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
            '[data-file-maid="ackblock"]{margin-top:4px;}',
            '[data-file-maid="acktoggle"]{display:flex;align-items:center;min-height:24px;padding:0;border:0;background:none;color:var(--dsw-alias-label-secondary);font-size:var(--maid-fs-meta);cursor:pointer;}',
            '[data-file-maid="ackrow"]{display:flex;align-items:center;gap:6px;min-height:24px;font-size:var(--maid-fs-meta);}',
            '[data-file-maid="exportrow"]{display:flex;align-items:center;gap:6px;min-height:24px;font-size:var(--maid-fs-meta);color:var(--dsw-alias-label-secondary);cursor:pointer;}',
            '[data-file-maid="exportrow"] input{accent-color:var(--dsw-alias-brand-primary);}',

            '[data-file-maid="scanrow"]{display:flex;align-items:baseline;gap:var(--maid-gap-kv);min-width:0;padding:var(--maid-row-pad) 0;border-top:1px solid var(--dsw-alias-border-l1);}',
            '[data-file-maid="scanrows"]>[data-file-maid="scanrow"]:first-child{border-top:0;padding-top:0;}',
            '[data-file-maid="scankey"]{flex:0 0 auto;color:var(--dsw-alias-label-secondary);font-size:var(--maid-fs-meta);line-height:1.45;white-space:nowrap;}',
            '[data-file-maid="scanval"]{flex:1 1 auto;min-width:0;margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;font-size:var(--maid-fs-row);line-height:1.45;font-variant-numeric:tabular-nums;}',
            '[data-file-maid="scanval"][data-tone="warn"]{color:var(--dsw-alias-state-warn-primary);}',
            /* The wide page has 1080px; three figures would stretch into a billboard. */
            '[data-file-maid="page"] [data-file-maid="scanlayout"]{max-width:340px;}',
            '[data-file-maid="tabpage"]{display:flex;flex-direction:column;gap:8px;padding:2px 2px 10px;font-size:var(--maid-fs-title);line-height:1.45;color:var(--dsw-alias-label-primary);box-sizing:border-box;}',
            /* The three pages are one list language, so its measures are stated once and
               read by every page: a row's breathing room and rule, the two text tiers a
               record is allowed to use, the gap between a section head and its rows, and
               the gap between two key/value halves of one row. Both roots declare them,
               so the card and the wide page cannot drift apart one rule at a time. */
            '[data-file-maid="tabpage"],[data-file-maid="page"]{--maid-fs-title:12px;--maid-fs-row:11.5px;--maid-fs-body:11px;--maid-fs-meta:10.5px;--maid-fs-num:13px;--maid-row-pad:3px;--maid-gap-kv:8px;--maid-gap-section:7px;--maid-gap-head:8px;}',
            '[data-file-maid="viewbody"]{display:flex;flex-direction:column;gap:var(--maid-gap-section);min-width:0;}',
            '[data-file-maid="tablist"]{display:flex;flex-direction:column;}',
            '[data-file-maid="setuplayer"]{display:flex;flex-direction:column;gap:8px;padding:2px 0 2px;}',
            '[data-file-maid="setuphead"]{display:flex;align-items:center;gap:6px;min-width:0;}',
            '[data-file-maid="setupback"]{flex:none;padding:2px 4px;border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--maid-fs-row);line-height:1.4;cursor:pointer;border-radius:4px;}',
            '[data-file-maid="input"]:focus-visible,[data-file-maid="select"]:focus-visible,[data-file-maid="setupinput"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
            '[data-file-maid="setupback"]:focus-visible,[data-file-maid="setupsecondary"]:focus-visible,[data-file-maid="setupremove"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
            '[data-file-maid="setuprowmain"]:focus-within{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
            '[data-file-maid="setuprow"]:hover{background:var(--dsw-alias-interactive-bg-hover);}',
            '[data-file-maid="setupback"]:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);}',
            '[data-file-maid="setuptitle"]{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-primary);font-size:var(--maid-fs-row);font-weight:600;line-height:1.4;}',
            '[data-file-maid="setupcount"]{flex:none;color:var(--dsw-alias-label-secondary);font-size:var(--maid-fs-meta);font-variant-numeric:tabular-nums;}',
            '[data-file-maid="setuplead"]{color:var(--dsw-alias-label-primary);font-size:var(--maid-fs-row);line-height:1.45;}',
            '[data-file-maid="setupnote"]{color:var(--dsw-alias-label-secondary);font-size:var(--maid-fs-meta);line-height:1.45;}',
            '[data-file-maid="setupcta"]{flex:1 1 auto;min-height:32px;padding:0 12px;border:0;border-radius:6px;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-1);font:inherit;font-size:var(--maid-fs-row);line-height:1.3;cursor:pointer;}',
            '[data-file-maid="setupcta"]:disabled{opacity:.5;cursor:default;}',
            '[data-file-maid="setupcta"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
            '[data-file-maid="setupsecondary"]{flex:none;min-height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--maid-fs-body);cursor:pointer;}',
            '[data-file-maid="setupsecondary"]:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);}',
            '[data-file-maid="setupsecondary"]:disabled{opacity:.5;cursor:default;}',
            '[data-file-maid="setupactions"]{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:4px;}',
            '[data-file-maid="setuplist"]{display:flex;flex-direction:column;min-width:0;}',
            '[data-file-maid="setuprow"]{min-height:38px;display:flex;align-items:center;gap:6px;min-height:34px;border-top:1px solid var(--dsw-alias-border-l1);}',
            '[data-file-maid="setuprow"]:first-child{border-top:0;}',
            '[data-file-maid="setuprowmain"]{display:flex;flex-wrap:wrap;align-items:center;gap:6px;flex:1 1 auto;min-width:0;padding:4px 0;cursor:pointer;}',
            '[data-file-maid="setupradio"]{flex:none;width:14px;height:14px;margin:0;accent-color:var(--dsw-alias-brand-primary);}',
            '[data-file-maid="setuppath"]{flex:1 1 100%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:var(--maid-fs-row);line-height:1.45;}',
            '[data-file-maid="setuppurpose"]{flex:1 1 100%;min-width:0;padding-left:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:var(--maid-fs-meta);line-height:1.4;}',
            '[data-file-maid="setupremove"]{flex:none;min-width:24px;min-height:24px;padding:0 2px;border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--maid-fs-meta);cursor:pointer;border-radius:4px;}',
            '[data-file-maid="setupremove"]:hover{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover);}',
            '[data-file-maid="setupdefaulthint"]{color:var(--dsw-alias-label-secondary);font-size:var(--maid-fs-meta);line-height:1.4;}',
            '[data-file-maid="setupfield"]{display:flex;flex-direction:column;gap:4px;min-width:0;}',
            '[data-file-maid="setuplabel"]{color:var(--dsw-alias-label-secondary);font-size:var(--maid-fs-meta);line-height:1.4;}',
            '[data-file-maid="setuprowof"]{display:flex;align-items:center;gap:6px;min-width:0;}',
            '[data-file-maid="setuprowof"] [data-file-maid="setupinput"]{flex:1 1 auto;min-width:0;}',
            '[data-file-maid="setuprowof"] [data-file-maid="setupsecondary"]{flex:0 0 auto;}',
            '[data-file-maid="setupinput"]{min-height:28px;padding:0 8px;border:1px solid var(--dsw-alias-label-tertiary);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:var(--maid-fs-row);}',
            '[data-file-maid="setupinput"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
            '[data-file-maid="setuphint"]{color:var(--dsw-alias-label-secondary);font-size:var(--maid-fs-meta);line-height:1.4;}',
            '[data-file-maid="setupproblem"]{color:var(--dsw-alias-label-primary);font-size:var(--maid-fs-meta);line-height:1.4;border-left:2px solid var(--dsw-alias-state-error-primary);padding-left:6px;}',
            '[data-file-maid="setuperror"]{color:var(--dsw-alias-label-primary);font-size:var(--maid-fs-meta);line-height:1.45;border-left:2px solid var(--dsw-alias-state-error-primary);padding-left:6px;}',
            '[data-file-maid="setupconfirmlist"]{display:flex;flex-direction:column;min-width:0;}',
            '[data-file-maid="setupconfirmrow"]{display:flex;align-items:center;gap:6px;min-width:0;padding:2px 0;}',
            '[data-file-maid="setupdot"]{flex:none;color:var(--dsw-alias-brand-primary);font-size:var(--maid-fs-meta);line-height:1;}',
            '[data-file-maid="setuppromise"]{color:var(--dsw-alias-label-secondary);font-size:var(--maid-fs-meta);line-height:1.45;}',
            '[data-file-maid="setupdonemeta"]{color:var(--dsw-alias-label-secondary);font-size:var(--maid-fs-meta);line-height:1.45;}',
            '[data-file-maid="setupstatus"]{color:var(--dsw-alias-label-secondary);font-size:var(--maid-fs-meta);line-height:1.4;}',
            '[data-file-maid="tabrow"]{display:flex;flex-direction:column;min-width:0;border-top:1px solid var(--dsw-alias-border-l1);}',
            '[data-file-maid="tabrow"]:first-child{border-top:0;}',
            '[data-file-maid="rowhead"]{display:flex;align-items:center;gap:6px;min-width:0;}',
            '[data-file-maid="tabtoggle"]{display:flex;align-items:center;gap:6px;flex:1 1 auto;min-width:0;padding:var(--maid-row-pad) 0;border:0;background:none;color:inherit;font:inherit;font-size:var(--maid-fs-row);cursor:pointer;text-align:left;}',
            '[data-file-maid="rowpath"]{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
            '[data-file-maid="tabrow"][data-open="true"] [data-file-maid="rowpath"]{white-space:normal;overflow-wrap:anywhere;}',
            '[data-file-maid="purposecell"]{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px;}',
            '[data-file-maid="factvalue"]{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;}',
            '[data-file-maid="rowacts"]{display:flex;align-items:center;gap:6px;flex:0 0 auto;}',
            '[data-file-maid="rowact"]{position:relative;flex:0 0 auto;padding:0 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--maid-fs-body);line-height:1.4;min-height:20px;cursor:pointer;white-space:nowrap;}',
            '[data-file-maid="rowact"]::after{content:"";position:absolute;inset:-2px 0;}',
            '[data-file-maid="rowact"]:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);}',
            '[data-file-maid="rowact"][data-tone="danger"]:hover,[data-file-maid="rowact"][data-tone="danger"]:focus-visible{color:var(--dsw-alias-state-error-primary,#e5484d);}',
            '[data-file-maid="rowact"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
            '[data-file-maid="pathline"]{flex:1 1 auto;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:var(--maid-fs-meta);line-height:1.45;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;}',
            '[data-file-maid="purposetext"]{font-size:var(--maid-fs-row);line-height:1.45;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;}',
            '[data-file-maid="purposetext"][data-clipped="true"]{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;}',
            '[data-file-maid="purposemore"]{align-self:flex-start;display:inline-flex;align-items:center;min-height:24px;padding:0 4px;border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--maid-fs-meta);line-height:1.4;cursor:pointer;border-radius:4px;}',
            '[data-file-maid="purposemore"]:hover{color:var(--dsw-alias-label-primary);}',
            '[data-file-maid="purposemore"]:hover{background:var(--dsw-alias-interactive-bg-hover);}',
            '[data-file-maid="purposemore"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
            '[data-file-maid="sectionlabel"]{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
            '[data-file-maid="scanage"]{color:var(--dsw-alias-label-secondary);font-size:var(--maid-fs-meta);white-space:nowrap;}',
            '[data-file-maid="viewglyph"]{flex:0 0 auto;opacity:.8;font-size:var(--maid-fs-body);}',
            '[data-file-maid="morebarlabel"]{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
            '[data-file-maid="morebarglyph"]{flex:0 0 auto;opacity:.7;}',
            '[data-file-maid="rowflag"]{flex:0 0 auto;padding-left:6px;border-left:2px solid var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-label-primary);}',
            '[data-file-maid="check"]{flex:0 0 auto;width:14px;height:14px;margin:0 4px 0 0;accent-color:var(--dsw-alias-brand-primary);}',
            '[data-file-maid="rowerror"]{margin:2px 0 0;color:var(--dsw-alias-state-error-primary,#e5484d);font-size:var(--maid-fs-meta);line-height:1.4;}',
            // One colour language: primary actions carry the brand colour, secondary
            // controls stay neutral and only darken on hover.
            '[data-file-maid="ghostbutton"],[data-file-maid="button"][data-tone="primary"],[data-file-maid="scanact"]{display:inline-flex;align-items:center;flex:0 0 auto;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;color:var(--dsw-alias-brand-primary,inherit);font:inherit;font-size:var(--maid-fs-body);line-height:1.4;min-height:24px;cursor:pointer;white-space:nowrap;}',
            '[data-file-maid="ghostbutton"]:hover,[data-file-maid="button"][data-tone="primary"]:hover{border-color:var(--dsw-alias-brand-primary,currentColor);background:var(--dsw-alias-interactive-bg-hover);}',
            '[data-file-maid="ghostbutton"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
            '[data-file-maid="morebar"]{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;margin-top:4px;padding:4px 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--maid-fs-meta);cursor:pointer;}',
            '[data-file-maid="morebar"]:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);}',
            '[data-file-maid="morebar"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
            '[data-file-maid="tabtoggle"]:hover{background:var(--dsw-alias-bg-layer-1);}',
            '[data-file-maid="tabcount"]{margin-left:auto;flex:none;color:var(--dsw-alias-label-primary);font-size:var(--maid-fs-row);font-variant-numeric:tabular-nums;white-space:nowrap;}',
            '[data-file-maid="tabdetail"]{display:flex;flex-direction:column;gap:4px;padding:0 2px 6px 14px;color:var(--dsw-alias-label-secondary);font-size:var(--maid-fs-meta);line-height:1.45;}',
            '@media (max-width:720px){[data-file-maid="table"] thead{display:none;}[data-file-maid="table"] tr{display:grid;grid-template-columns:1fr auto;gap:2px 10px;padding:6px 0;border-bottom:1px solid var(--dsw-alias-border-l1);}[data-file-maid="td"]{border:0;padding:0;}[data-file-maid="td"][data-field="about"]{grid-column:1/-1;}[data-file-maid="cell"]{max-width:none;}}',
            '@media (prefers-reduced-motion:reduce){[data-file-maid="chevron"]{transition:none;}}',
          ].join(''),
        );

        /**
         * The folder mark: the sidebar panel row draws this at 16 px.
         * @param {object} props - `SidebarPanelIconOwnerProps`: `size` and `active`.
         * @returns {object} the icon element.
         */
        function SidebarIcon(props) {
          const size = Number.isFinite(props?.size) ? props.size : 16;
          const stroke = props?.active === true ? 'var(--dsw-alias-brand-primary)' : 'currentColor';
          return h(
            'svg',
            { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
            h('path', {
              d: 'M1.9 5.2c0-.72.58-1.3 1.3-1.3h2.5c.35 0 .68.14.92.38l.98.98h5.2c.72 0 1.3.58 1.3 1.3v5.1c0 .72-.58 1.3-1.3 1.3H3.2c-.72 0-1.3-.58-1.3-1.3V5.2Z',
              stroke,
              strokeWidth: 1.3,
              strokeLinejoin: 'round',
            }),
            h('path', { d: 'M6.2 3.9v3.1', stroke, strokeWidth: 1.3, strokeLinecap: 'round' }),
          );
        }

        /**
         * The `main` body: one ledger per workspace root, selected from the header.
         * @param {object} props - root-scoped standard props (`useSessions`, `useRemoteAccess`).
         * @returns {object} the rendered element tree.
         */
        function FileMaidPanel(props) {
          const serviceSessions = useSessionServiceList();
          const sessions = typeof props.useSessions === 'function' ? props.useSessions((state) => state) : serviceSessions;
          const canRead = typeof props.useRemoteAccess === 'function' ? props.useRemoteAccess('workspaceFiles/read') : true;
          const roots = rootsOf(sessions);
          const [picked, setPicked] = React.useState('');
          const [revision, setRevision] = React.useState(0);
          const [scanBusy, setScanBusy] = React.useState(false);
          /** Armed rescan: a second click inside the window really does it. */
          const [scanArmed, setScanArmed] = React.useState(false);
          const [scanNotice, setScanNotice] = React.useState('');
          /** Lazy review of the leak list: `phase` mirrors the request, `data` is the reply. */
          const [review, setReview] = React.useState({ key: '', phase: 'idle', data: null, message: '' });
          /** Keys accepted in this page session, held until the projection catches up. */
          const [ackedLocal, setAckedLocal] = React.useState([]);
          const [ackNotice, setAckNotice] = React.useState('');
          const [openLeak, setOpenLeak] = React.useState('');
          const [openAcked, setOpenAcked] = React.useState(false);
          const [exportWanted, setExportWanted] = React.useState(false);
          /** The rule form: `undefined` when closed, otherwise the row being written. */
          const [ruleForm, setRuleForm] = React.useState(undefined);
          const [ruleBusy, setRuleBusy] = React.useState(false);
          const [ruleNotice, setRuleNotice] = React.useState('');
          const [state, setState] = React.useState({ phase: 'loading', status: undefined, message: '', forReader: '' });
          const [openDir, setOpenDir] = React.useState('');
          /** The directory form: `undefined` when closed, otherwise the row being edited. */
          const [manage, setManage] = React.useState(undefined);
          const [manageBusy, setManageBusy] = React.useState(false);
          const [manageError, setManageError] = React.useState('');
          /** A failure from an action that has no form to show it in. */
          const [dirError, setDirError] = React.useState('');
          /** Locale revisions: the card renders outside any slot outlet, so it subscribes itself. */
          const [localeRev, setLocaleRev] = React.useState(0);
          /** Wall clock for every relative age; a frozen `Date.now()` never leaves "4 分钟前". */
          const [now, setNow] = React.useState(() => Date.now());
          /** The sidebar tab renders the same data in a list instead of the ledger table. */
          const compact = props?.compact === true;
          /** The card body: no page header, no wide ledger, no footer. */
          const embedded = props?.embedded === true;
          /** Active section of the segmented switch. */
          const [view, setView] = React.useState('dirs');

          const known = roots.some((item) => item.cwd === picked);
          /** The root of the session the centre column shows; switching workspace changes it. */
          const activeCwd = activeCwdOf(sessions);
          const followed = roots.some((item) => item.cwd === activeCwd) ? activeCwd : '';
          const root = known ? picked : (followed !== '' ? followed : (roots[0]?.cwd ?? ''));
          // A manual pick lasts only until the operator switches workspace again.
          React.useEffect(() => {
            setPicked('');
          }, [activeCwd]);
          const reader = roots.find((item) => item.cwd === root);
          const readerId = reader === undefined ? '' : reader.sessionId;

          React.useEffect(() => {
            const subscribe = ctx.locale?.subscribe;
            if (typeof subscribe !== 'function') return undefined;
            try {
              return subscribe(() => setLocaleRev((value) => value + 1));
            } catch {
              return undefined;
            }
          }, []);

          React.useEffect(() => {
            if (readerId === '') {
              // The session list arrives after the first paint; until it lands the honest
              // label is "loading", not "no roots".
              const waiting = sessions === undefined;
              setState({ phase: waiting ? 'loading' : canRead ? 'noRoot' : 'denied', status: undefined, message: '', forReader: '' });
              return undefined;
            }
            if (!canRead) {
              setState({ phase: 'denied', status: undefined, message: '', forReader: readerId });
              return undefined;
            }
            const controller = new AbortController();
            let live = true;
            // A snapshot belongs to the Session that produced it: switching roots must drop
            // the old numbers instead of labelling the new root with them.
            setState((current) =>
              current.forReader === readerId
                ? { ...current, phase: current.status === undefined ? 'loading' : current.phase }
                : { phase: 'loading', status: undefined, message: '', forReader: readerId },
            );
            loadStatus(ctx.remote, readerId, controller.signal).then(
              (status) => {
                if (live) setState({ phase: 'ok', status, message: '', forReader: readerId });
              },
              (error) => {
                if (!live) return;
                if (error?.absent === true) setState({ phase: 'absent', status: undefined, message: '', forReader: readerId });
                else setState({ phase: 'failed', status: undefined, message: String(error?.message ?? error), forReader: readerId });
              },
            );
            return () => {
              live = false;
              controller.abort();
            };
          }, [canRead, readerId, revision]);

          React.useEffect(() => {
            const timer = setInterval(() => {
              if (typeof document !== 'undefined' && document.hidden === true) return;
              setNow(Date.now());
            }, 30000);
            return () => clearInterval(timer);
          }, []);

          const status = state.forReader === readerId ? state.status : undefined;
          const catalog = status?.catalog;
          const catalogState = catalog?.state;
          const dirs = Array.isArray(catalog?.dirs) ? catalog.dirs : [];
          const misplaced = Array.isArray(status?.misplaced) ? status.misplaced : [];
          /** The scan ran past its budget: the Host now tracks only the managed folders. */
          const degraded = status?.scan?.degraded === true && catalogState === 'MANAGED';
          const [dismissedRoots, setDismissedRoots] = React.useState(readDismissedRoots);
          // A dismissal is permanent per root: the notice is closed once and stays closed,
          // even if the scan recovers and degrades again later.
          const showDegraded = degraded && !dismissedRoots.includes(root);
          const degradedTitle = fill(t('hint.degradedTitle'), {
            files: status?.scan?.files ?? 0,
            ms: status?.scan?.durationMs ?? 0,
          });
          const dismissDegraded = () => {
            if (dismissedRoots.includes(root)) return;
            const next = [...dismissedRoots, root];
            setDismissedRoots(next);
            writeDismissedRoots(next);
          };

          const stateLabel =
            state.phase === 'denied'
              ? t('state.denied')
              : state.phase === 'noRoot'
                ? t('state.noRoot')
                : state.phase === 'absent'
                  ? t('state.absent')
                  : state.phase === 'failed'
                    ? t('state.readError')
                    : CATALOG_STATES.includes(catalogState)
                      ? t(`state.${catalogState}`)
                      : t('state.loading');
          // A slow scan is a performance note, and it already has its own line on the
          // 扫描 page. The badge speaks only about whether the root can route files.
          const tone =
            catalogState === 'MANAGED'
              ? 'ok'
              : catalogState === 'ERROR' || state.phase === 'failed'
                ? 'error'
                : catalogState === 'UNINITIALIZED' || state.phase === 'absent'
                  ? 'warn'
                  : 'muted';
          /**
           * The one-line explanation behind the state. The card header shows it on hover and
           * the card body repeats it as a plain line, so a touch or keyboard user reads the
           * same sentence the pointer user gets.
           */
          const stateDetail =
            state.phase === 'failed'
              ? `${t('hint.error')}: ${state.message}`
              : catalogState === 'ERROR'
                ? `${t('hint.error')}: ${catalog?.errors?.[0]?.message ?? '—'}`
                : state.phase === 'noRoot'
                  ? t('hint.noRoots')
                  : catalogState === 'UNINITIALIZED'
                    ? t('label.uninitialized')
                    : catalogState === 'NOT_MANAGED'
                      ? t('hint.notManaged')
                      : state.phase === 'absent'
                        ? t('hint.absent')
                        : '';
          /** The card header owns the age and the refresh action, so the panel publishes both. */
          const ageText = typeof status?.generatedAt === 'string' ? formatAge(status.generatedAt, t, now) : '';
          /**
           * The one sentence that explains the current phase. The card body renders it too:
           * a touch user never sees the hover bubble, and every non-managed state needs an
           * explanation next to its badge.
           */
          // The badge already names the state. This line carries only what the badge cannot:
          // the next step, the consequence, or the parser's own message. Repeating "还没启用"
          // under a badge that says 未启用 is noise, so those states render nothing.
          const hintText =
            state.phase === 'loading'
              ? ''
              : state.phase === 'failed'
                ? t('hint.failed')
                : state.phase === 'denied'
                  ? t('hint.denied')
                  : state.phase === 'noRoot'
                    ? t('hint.noRoots')
                    : state.phase === 'absent'
                      ? t('hint.absent')
                      : catalogState === 'ERROR'
                        ? String(catalog?.errors?.[0]?.message ?? '')
                        : catalogState === 'UNINITIALIZED'
                          ? ''
                          : catalogState === 'NOT_MANAGED'
                            ? t('hint.notManaged')
                            : dirs.length > 0
                              ? ''
                              : catalogState === 'MANAGED'
                                ? t('hint.emptyCatalog')
                                : t('hint.noTable');
          React.useEffect(() => {
            // Only the card publishes: the wide page shares the module-level channel and
            // would otherwise write another root's numbers into the header.
            if (!embedded) return;
            publishCardState({
              tone,
              label: stateLabel,
              detail: stateDetail,
              workspace: typeof root === 'string' && root.length > 0 ? folderName(root) : '',
              workspacePath: typeof root === 'string' ? root : '',
              refresh: () => setRevision((value) => value + 1),
            });
          }, [embedded, localeRev, tone, stateLabel, stateDetail, root]);

          /** Which directory shows its purpose in full, and which one is clamped. */
          const [purposeOpen, setPurposeOpen] = React.useState('');
          /** Which log row is expanded to show its full path. */
          const [openLog, setOpenLog] = React.useState('');
          const [clippedDir, setClippedDir] = React.useState('');

          /** The setup layer: undefined while browsing, an object while setting up. */
          const [setup, setSetup] = React.useState(undefined);
          React.useEffect(() => {
            // `status.json` can change while this card is in the background: another
            // window, a CLI scan, or a hand-edited catalog. Re-reading on focus means
            // the reader never has to remember a manual refresh.
            if (typeof window === 'undefined' || typeof document === 'undefined') return undefined;
            const reread = () => {
              if (document.visibilityState === 'hidden') return;
              setRevision((value) => value + 1);
            };
            window.addEventListener('focus', reread);
            document.addEventListener('visibilitychange', reread);
            // Focus alone misses a change made while the card is visible (a CLI scan,
            // another session writing). A slow read of one small file covers that.
            const timer = setInterval(reread, 15000);
            return () => {
              window.removeEventListener('focus', reread);
              document.removeEventListener('visibilitychange', reread);
              clearInterval(timer);
            };
          }, []);

          React.useEffect(() => {
            // A clamped purpose only earns a "展开" control when it really overflows:
            // the card width is variable, so the answer has to come from the DOM.
            if (openDir === '') {
              setClippedDir('');
              return;
            }
            if (purposeOpen === openDir) {
              setClippedDir('');
              return;
            }
            const node = typeof document === 'undefined' ? null : document.querySelector('[data-file-maid="purposetext"]');
            if (node === null) {
              setClippedDir('');
              return;
            }
            const measure = () => setClippedDir(node.scrollHeight - node.clientHeight > 1 ? openDir : '');
            measure();
            if (typeof ResizeObserver === 'undefined') return;
            const observer = new ResizeObserver(measure);
            observer.observe(node);
            return () => observer.disconnect();
          }, [openDir, purposeOpen, revision, localeRev]);

          const totalFiles = dirs.reduce((sum, dir) => sum + (Number.isFinite(dir.files) ? dir.files : 0), 0);
          const metaParts = [];
          if (typeof catalog?.rootDefault === 'string') metaParts.push({ text: `${t('label.default')} ${catalog.rootDefault}` });
          if (Number.isFinite(catalog?.threshold)) metaParts.push({ text: `${t('label.threshold')} ${catalog.threshold}` });
          if (dirs.length > 0) metaParts.push({ text: fill(t('summary.dirs'), { n: dirs.length }) });
          if (totalFiles > 0) metaParts.push({ text: fill(t('summary.files'), { n: totalFiles }) });
          if (typeof status?.scan?.scannedAt === 'string') {
            metaParts.push({ text: `${t('label.scan')} ${formatAge(status.scan.scannedAt, t, now)} · ${status.scan.durationMs ?? 0} ms` });
          }
          if (status?.scan?.baseline === true) metaParts.push({ text: t('label.baseline') });
          if (typeof catalog?.hash === 'string') {
            metaParts.push({ mono: true, text: catalog.hash.slice('sha256:'.length, 'sha256:'.length + 8) });
          }

          /**
           * Only the wide page offers a choice of root. The card sits inside one Session's
           * sidebar, so a picker there would let its body describe a different workspace than
           * the Session it is docked to; the card names the root it follows instead.
           */
          const showPicker = !compact && roots.length > 1;
          const pickerNode = showPicker
            ? h(
                'label',
                { 'data-file-maid': 'muted', style: { display: 'inline-flex', gap: '6px', alignItems: 'center', whiteSpace: 'nowrap', minWidth: 0, flex: '1 1 auto' } },
                t('label.root'),
                h(
                  'select',
                  {
                    'data-file-maid': 'select',
                    value: root,
                    'aria-label': t('label.root'),
                    style: { minWidth: 0, flex: '1 1 auto' },
                    onChange: (event) => {
                      setPicked(event.target.value);
                      setOpenDir('');
                    },
                  },
                  roots.map((item) => h('option', { key: item.cwd, value: item.cwd }, shortPath(item.cwd))),
                ),
              )
            : !compact && typeof root === 'string' && root.length > 0
              ? // The wide header has room for it; the card carries the name on its tabs.
                h(
                  'span',
                  { 'data-file-maid': 'rootline', title: root },
                  h('span', { 'data-file-maid': 'rootlabel' }, t('label.workspace')),
                  h('span', { 'data-file-maid': 'rootvalue' }, folderName(root)),
                )
              : null;

          const refreshNode = h(
            'button',
            { type: 'button', 'data-file-maid': 'button', disabled: reader === undefined, onClick: () => setRevision((value) => value + 1) },
            t('refresh'),
          );

          const header = embedded
            ? null
            : h(
                'div',
                { 'data-file-maid': 'header' },
                h('span', { 'data-file-maid': 'title' }, t('title')),
                h(
                  'span',
                  { 'data-file-maid': 'badge', 'data-tone': tone, role: 'status' },
                  h('span', { 'data-file-maid': 'badgedot', 'aria-hidden': 'true' }),
                  h('span', { 'data-file-maid': 'badgelabel' }, stateLabel),
                ),
                ageText === '' ? null : h('span', { 'data-file-maid': 'muted' }, ageText),
                h('span', { 'data-file-maid': 'spacer' }),
                compact ? null : pickerNode,
                refreshNode,
              );

          const meta = h(
            'div',
            { 'data-file-maid': 'meta' },
            roots.length > 1 && typeof root === 'string' && root.length > 0 ? h('span', { 'data-file-maid': 'mono', title: root }, root) : null,
            metaParts.map((part, index) =>
              h(
                'span',
                { key: `meta-${index}`, 'data-file-maid': part.mono === true ? 'mono' : undefined, title: part.mono === true ? part.text : undefined },
                part.text,
              ),
            ),
          );

          const banners = [];
          // The card body states the reason inline (`hintLine`), so only the wide page —
          // and the degraded banner that carries numbers — renders a banner.
          if (!embedded && state.phase === 'failed') {
            banners.push(h('div', { key: 'failed', 'data-file-maid': 'banner', 'data-tone': 'error' }, `${t('hint.error')}: ${state.message}`));
          }
          if (!embedded && catalogState === 'ERROR') {
            banners.push(h('div', { key: 'catalog-error', 'data-file-maid': 'banner', 'data-tone': 'error' }, `${t('hint.error')}: ${catalog?.errors?.[0]?.message ?? '—'}`));
          }
          if (showDegraded) {
            banners.push(
              h(
                'div',
                { key: 'degraded', 'data-file-maid': 'banner', 'data-tone': 'warn' },
                h('span', { 'data-file-maid': 'bannertext' }, t('hint.degraded')),
                // The numbers used to live in a native tooltip; on a 240px card that is
                // the one place a pointer-only affordance cannot be reached.
                h('span', { 'data-file-maid': 'bannermeta' }, degradedTitle),
                h(
                  'button',
                  {
                    type: 'button',
                    'data-file-maid': 'bannerclose',
                    'aria-label': t('action.dismiss'),
                    onClick: dismissDegraded,
                  },
                  '×',
                ),
              ),
            );
          }
          /**
           * The one empty state all three pages render: the heading names the list that
           * would be here, the second line says why it is empty and what fills it. Two
           * tiers of type and no box, so an empty page and a full one read as the same
           * layout rather than as a layout and an apology.
           * @param {string} title - what the missing list is.
           * @param {string} hint - why it is empty and what fills it.
           * @returns {object} the block.
           */
          /**
           * One shell for "there is nothing here yet".
           * @param {string} title - what is missing.
           * @param {string} hint - what brings it back.
           * @param {object} [action] - optional control, so the empty state can act.
           * @returns {object} the element.
           */
          const emptyState = (title, hint, action) =>
            h(
              'div',
              { 'data-file-maid': 'emptystate' },
              h('div', null, title),
              h('div', { 'data-file-maid': 'emptyhint' }, hint),
              action ?? null,
            );
          /** Nothing to look at before the root is set up: the switch stays, dimmed. */
          const viewsEnabled = state.phase === 'ok' && catalogState === 'MANAGED';
          /**
           * A root whose switch is inert has no panel to put an empty state in, so the
           * reason it is empty stands on its own line above the dimmed tabs. A root with
           * a live switch renders it inside the 目录 page instead, where the other two
           * pages keep theirs.
           */
          const hintLine = embedded && hintText !== '' && dirs.length === 0 && !viewsEnabled ? emptyState(t('section.catalog'), hintText) : null;
          /** One statement of the reason: the inline line, the banner, or the empty slot. */
          const emptyText = hintLine !== null || banners.length > 0 ? '' : hintText;

          const head = h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', { 'data-file-maid': 'th', scope: 'col' }, t('col.dir')),
              h('th', { 'data-file-maid': 'th', scope: 'col', 'data-align': 'num' }, t('col.files')),
              h('th', { 'data-file-maid': 'th', scope: 'col' }, t('col.about')),
            ),
          );

          /** A stable, HTML-id-safe token for a directory path. */
          const dirSlug = (path) => String(path).replace(/[^\w-]+/gu, '-');
          const rows = [];
          for (const dir of dirs) {
            const isOpen = openDir === dir.path;
            const into = misplaced.filter((item) => item.suggested === dir.path);
            const excludes = typeof dir.excludes === 'string' ? dir.excludes : '';
            rows.push(
              h(
                'tr',
                { key: `dir-${dir.path}`, 'data-file-maid': 'tr' },
                h(
                  'td',
                  { 'data-file-maid': 'td' },
                  h(
                    'button',
                    {
                      type: 'button',
                      'data-file-maid': 'row-toggle',
                      'aria-expanded': isOpen ? 'true' : 'false',
                      'aria-controls': `file-maid-detail-${dirSlug(dir.path)}`,
                      onClick: () => setOpenDir(isOpen ? '' : dir.path),
                    },
                    h('span', { 'aria-hidden': 'true' }, isOpen ? '▾' : '▸'),
                    h('span', { 'data-file-maid': 'cell', title: dir.path }, dir.path),
                    dir.path === catalog?.rootDefault
                      ? h(StateTip, { tip: t('detail.default') }, h('span', { 'data-file-maid': 'star', 'aria-hidden': 'true' }, '★'))
                      : null,
                  ),
                ),
                h('td', { 'data-file-maid': 'td', 'data-align': 'num' }, fileCount(dir.files)),
                h(
                  'td',
                  { 'data-file-maid': 'td', 'data-field': 'about' },
                  h('span', { 'data-file-maid': 'cell', title: dir.about ?? '' }, dir.about ?? '—'),
                ),
              ),
            );
            if (isOpen) {
              rows.push(
                h(
                  'tr',
                  { key: `detail-${dir.path}`, 'data-file-maid': 'tr', id: `file-maid-detail-${dirSlug(dir.path)}` },
                  h(
                    'td',
                    { 'data-file-maid': 'detail', colSpan: 3 },
                    h(
                      'div',
                      null,
                      excludes.length === 0 ? null : h('span', { 'data-file-maid': 'muted' }, `${t('detail.excludes')} ${excludes}`),
                    ),
                    h('div', null, `${t('detail.misplaced')} ${into.length}`),
                    h(
                      'div',
                      { 'data-file-maid': 'manageactions' },
                      h(
                        'button',
                        { type: 'button', 'data-file-maid': 'rowact', onClick: () => openManage('edit', dir) },
                        t('manage.edit'),
                      ),
                      h(
                        'button',
                        { type: 'button', 'data-file-maid': 'rowact', 'data-tone': 'danger', onClick: () => openManage('remove', dir) },
                        t('manage.delete'),
                      ),
                    ),
                  ),
                ),
              );
            }
          }

          const purposeOf = (dir) => (typeof dir.purpose === 'string' && dir.purpose !== '' ? dir.purpose : '');
          const compactRows = dirs.map((dir) => {
            const isOpen = openDir === dir.path;
            const excludes = typeof dir.excludes === 'string' ? dir.excludes : '';
            const into = misplaced.filter((item) => item.suggested === dir.path);
            const purpose = purposeOf(dir);
            const expanded = purposeOpen === dir.path;
            /* One row of facts: path axis on the left, count axis on the right, and
               the two row actions living inside the head line instead of under it. */
            return h(
              'div',
              {
                key: `tab-${dir.path}`,
                'data-file-maid': 'tabrow',
                'data-open': isOpen ? 'true' : 'false',
                'data-default': dir.path === catalog?.rootDefault ? 'true' : 'false',
              },
              h(
                'div',
                { 'data-file-maid': 'rowhead' },
                h(
                  'button',
                  {
                    type: 'button',
                    'data-file-maid': 'tabtoggle',
                    'aria-expanded': isOpen ? 'true' : 'false',
                    'aria-controls': `file-maid-dir-${dirSlug(dir.path)}`,
                    'aria-label': `${fill(t('dir.row'), { path: dir.path, files: fileCount(dir.files) })}${
                      dir.path === catalog?.rootDefault ? `，${t('detail.default')}` : ''
                    }`,
                    onClick: () => setOpenDir(isOpen ? '' : dir.path),
                  },
                  h('span', { 'aria-hidden': 'true' }, isOpen ? '▾' : '▸'),
                  h('span', { 'data-file-maid': 'rowpath' }, dir.path),
                  dir.path === catalog?.rootDefault
                    ? h(
                        StateTip,
                        { tip: t('detail.default') },
                        h('span', { 'data-file-maid': 'star', 'aria-hidden': 'true' }, '★'),
                      )
                    : null,
                ),
                isOpen
                  ? h(
                      'div',
                      { 'data-file-maid': 'rowacts' },
                      h(
                        'button',
                        {
                          type: 'button',
                          'data-file-maid': 'rowact',
                          'aria-label': fill(t('manage.editOf'), { path: dir.path }),
                          onClick: () => openManage('edit', dir),
                        },
                        t('manage.edit'),
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          'data-file-maid': 'rowact',
                          'data-tone': 'danger',
                          'aria-label': fill(t('manage.deleteOf'), { path: dir.path }),
                          onClick: () => openManage('remove', dir),
                        },
                        t('manage.delete'),
                      ),
                    )
                  : null,
                h('span', { 'data-file-maid': 'tabcount', 'aria-hidden': 'true' }, fileCount(dir.files)),
              ),
              isOpen
                ? h(
                    'div',
                    { 'data-file-maid': 'tabdetail', id: `file-maid-dir-${dirSlug(dir.path)}` },
                    h(
                      'div',
                      { 'data-file-maid': 'itemfact' },
                      h('span', { 'data-file-maid': 'itemfactlabel' }, t('dir.purposeLabel')),
                      h(
                        'div',
                        { 'data-file-maid': 'purposecell' },
                        h(
                          'div',
                          {
                            'data-file-maid': 'purposetext',
                            id: `file-maid-purpose-${dirSlug(dir.path)}`,
                            'data-clipped': expanded ? 'false' : 'true',
                          },
                          purpose === '' ? '—' : purpose,
                        ),
                        clippedDir === dir.path && !expanded
                          ? h(
                              'button',
                              {
                                type: 'button',
                                'data-file-maid': 'purposemore',
                                'aria-expanded': 'false',
                                'aria-controls': `file-maid-purpose-${dirSlug(dir.path)}`,
                                onClick: () => setPurposeOpen(dir.path),
                              },
                              t('detail.purposeMore'),
                            )
                          : null,
                        expanded
                          ? h(
                              'button',
                              {
                                type: 'button',
                                'data-file-maid': 'purposemore',
                                'aria-expanded': 'true',
                                'aria-controls': `file-maid-purpose-${dirSlug(dir.path)}`,
                                onClick: () => setPurposeOpen(''),
                              },
                              t('detail.purposeLess'),
                            )
                          : null,
                      ),
                    ),
                    excludes === ''
                      ? null
                      : h(
                          'div',
                          { 'data-file-maid': 'itemfact' },
                          h('span', { 'data-file-maid': 'itemfactlabel' }, t('detail.excludesLabel')),
                          h('span', { 'data-file-maid': 'factvalue' }, excludes),
                        ),
                    into.length === 0
                      ? null
                      : h(
                          'div',
                          { 'data-file-maid': 'itemfact' },
                          h('span', { 'data-file-maid': 'itemfactlabel' }, t('detail.landedLabel')),
                          h(
                            'span',
                            { 'data-file-maid': 'rowflag', 'data-tone': 'warn' },
                            fill(t('detail.landedCount'), { n: into.length, total: misplaced.length }),
                          ),
                        ),
                  )
                : null,
            );
          });

          const table =
            dirs.length === 0
              ? emptyText === ''
                ? null
                : emptyState(t('section.catalog'), emptyText)
              : h('table', { 'data-file-maid': 'table' }, head, h('tbody', null, rows));

          /**
           * One misplaced record as a two-line row.
           *
           * A single line cannot hold time, path, "into" and the target in a 252px
           * body: the path was clipped to a few characters and the target wrapped at
           * its hyphen. The name and the target now share the first line, the folder
           * the file actually sits in and its age the second; the two right-hand
           * cells line up, so the list scans as columns.
           * @param {object} item - `{ at, path, suggested }` from the projection.
           * @param {number} index - position in the rendered list.
           * @returns {object} the list item.
           */
          /** Why this file landed where it did, in the reader's words. */
          const decidedText = (by) =>
            by === 'rule'
              ? t('detail.byRule')
              : by === 'agent'
                ? t('detail.byAgent')
                : by === 'default'
                  ? t('detail.byDefault')
                  : '—';

          const misplacedRow = (item, index) => {
            const path = typeof item.path === 'string' ? item.path : '';
            const cut = path.lastIndexOf('/');
            const name = cut >= 0 ? path.slice(cut + 1) : path;
            const folder = cut >= 0 ? path.slice(0, cut) : '';
            const age = formatAge(item.at, t, now);
            const id = `file-maid-log-${index}`;
            const open = openLog === id;
            const at = typeof item.at === 'string' ? new Date(item.at) : undefined;
            // A fixed local stamp beats a locale-formatted one: the panel is Chinese,
            // the host locale is not, and "9:23:11 PM" next to "3 小时前" reads like a bug.
            const stamp =
              at instanceof Date && !Number.isNaN(at.getTime())
                ? `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
                : '';
            return h(
              'li',
              { key: `m-${index}-${path}`, 'data-file-maid': 'item', 'data-open': open ? 'true' : 'false' },
              h(
                'button',
                {
                  type: 'button',
                  'data-file-maid': 'itemtoggle',
                  'aria-expanded': open ? 'true' : 'false',
                  'aria-controls': id,
                  onClick: () => setOpenLog(open ? '' : id),
                },
                h(
                  'span',
                  { 'data-file-maid': 'itemhead' },
                  h('span', { 'data-file-maid': 'chevron', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
                  h('span', { 'data-file-maid': 'itemname' }, name === '' ? '—' : name),
                  h(
                    'span',
                    { 'data-file-maid': 'itemtarget' },
                    h('span', { 'data-file-maid': 'sronly' }, `${t('misplaced.into')} `),
                    h('span', { 'aria-hidden': 'true' }, '→ '),
                    item.suggested ?? '—',
                  ),
                  age === '' ? null : h('span', { 'data-file-maid': 'itemage' }, age),
                ),
              ),
              open
                ? h(
                    'div',
                    { 'data-file-maid': 'itemdetail', id },
                    h(
                      'div',
                      { 'data-file-maid': 'itemfact' },
                      h('span', { 'data-file-maid': 'itemfactlabel' }, t('misplaced.pathLabel')),
                      h('span', { 'data-file-maid': 'pathline' }, path === '' ? '—' : path),
                    ),
                    stamp === ''
                      ? null
                      : h(
                          'div',
                          { 'data-file-maid': 'itemfact' },
                          h('span', { 'data-file-maid': 'itemfactlabel' }, t('misplaced.timeLabel')),
                          h('span', { 'data-file-maid': 'itemstamp' }, stamp),
                        ),
                    h(
                      'div',
                      { 'data-file-maid': 'itemfact' },
                      h('span', { 'data-file-maid': 'itemfactlabel' }, t('misplaced.byLabel')),
                      h('span', { 'data-file-maid': 'itemstamp' }, decidedText(item.decided_by)),
                    ),
                  )
                : null,
            );
          };

          const misplacedList =
            misplaced.length === 0
              ? emptyState(t('misplaced.empty'), t('misplaced.emptyHint'))
              : h(
                  'ul',
                  { 'data-file-maid': 'list' },
                  misplaced
                    .slice(-10)
                    .reverse()
                    .map(misplacedRow),
                );

          /**
           * The scan tab: three groups instead of twelve flat key/value rows.
           *
           * Flat rows cost one line each and put the answer (is the scan fresh, did it
           * degrade) below the settings that produced it. The groups answer in reading
           * order — what this scan saw, the rules it applied, then the root and the
           * catalog baseline it is pinned to — and every value after a label is flush
           * right, so the numbers form one vertical axis instead of twelve ragged pairs.
           */
          const scan = status?.scan;
          const reconcile = status?.reconcile;
          const scanCount = (value) => (Number.isFinite(value) ? value.toLocaleString('en-US') : '—');
          /** One right-hand cell. `tone: 'warn'` marks the one state worth looking at. */
          const scanText = (text, tone) =>
            h('span', { 'data-file-maid': 'scanval', 'data-tone': tone }, text);
          const scanRow = (key, label, value) =>
            h(
              'div',
              { key, 'data-file-maid': 'scanrow' },
              h('span', { 'data-file-maid': 'scankey' }, label),
              value,
            );
          /** One figure with the word under it: the three counts read as one sentence. */
          const scanStat = (key, value, label) =>
            h(
              'div',
              { key, 'data-file-maid': 'scancell' },
              h('span', { 'data-file-maid': 'scanval' }, value),
              h('span', { 'data-file-maid': 'scanlabel' }, label),
            );
          const scanGroup = (key, title, block, aside) =>
            h(
              'div',
              { key, 'data-file-maid': 'scangroup' },
              h(
                'div',
                { 'data-file-maid': 'sectionhead' },
                h('span', { 'data-file-maid': 'sectionlabel' }, title),
                aside ?? null,
              ),
              block,
            );

          const scannedAt = typeof scan?.scannedAt === 'string' ? scan.scannedAt : '';
          const reported = Number.isFinite(reconcile?.missing?.length) ? reconcile.missing.length : 0;
          const ledgerGap = reconcile?.ledger_incomplete === true;
          const decisionsGap = reconcile?.recorded_incomplete === true;
          const coverageLost = ledgerGap || decisionsGap;

          /**
           * The verdict on the right of the "本次扫描" head. Reading the scan and
           * re-running it belong together, so the action sits on the same line as the
           * numbers it produces instead of owning a row above them.
           */
          React.useEffect(() => {
            if (!scanArmed) return undefined;
            const timer = setTimeout(() => setScanArmed(false), 4000);
            return () => clearTimeout(timer);
          }, [scanArmed]);

          const scanAction = h(
            'button',
            {
              type: 'button',
              'data-file-maid': 'scanact',
              'data-tone': 'brand',
              'aria-busy': scanBusy ? 'true' : 'false',
              onClick: () => {
                if (scanBusy) return;
                // Rescanning moves the window to now, which swallows every leak found so
                // far. Ask for the second click while there is something to lose.
                if (reportCount > 0 && !scanArmed) {
                  setScanArmed(true);
                  return;
                }
                setScanArmed(false);
                void runScan();
              },
            },
            scanBusy ? t('scan.running') : scanArmed ? t('scan.rerunArm') : t('scan.rerun'),
          );

          /** Time, age and the one state word, on one line: they answer the same question. */
          const scanStatus = h(
            'div',
            { 'data-file-maid': 'scanstatus', 'aria-live': 'polite' },
            h(
              'span',
              { 'data-file-maid': 'scanage' },
              `${scannedAt === '' ? '—' : `${formatClock(scannedAt, now)} · ${formatAge(scannedAt, t, now)}`}`,
            ),
            h(
              'span',
              { 'data-file-maid': 'scanverdict', 'data-tone': scan?.degraded === true ? 'warn' : undefined },
              scan?.degraded === true ? t('scan.degraded') : t('scan.degradedNone'),
            ),
          );

          /** A grey line under the figures: explains a gap the numbers alone cannot. */
          const scanNote = (key, text) => h('div', { key, 'data-file-maid': 'scannote' }, text);

          /** Prefer the file count; fall back to the record count on older snapshots. */
          const num = (files, records) => {
            const value = Number.isFinite(files) ? files : records;
            return Number.isFinite(value) ? String(value) : '—';
          };
          const baselineOnly = reconcile === undefined || reconcile === null || reconcile.baseline === true;
          const reconcileAside = baselineOnly
            ? null
            : h(
                'span',
                { 'data-file-maid': 'scanaside', 'data-tone': coverageLost || reported > 0 ? 'warn' : undefined },
                coverageLost
                  ? decisionsGap
                    ? t('scan.recordedIncomplete')
                    : t('scan.ledgerIncomplete')
                  : reported > 0
                    ? fill(t('scan.leakCount'), { n: reported })
                    : t('scan.noLeak'),
              );

          // The projection keeps accepted rows with a flag, so an undo can bring the
          // row back without another scan; the list shows only the open ones.
          const openLeaks = Array.isArray(reconcile?.missing) ? reconcile.missing.filter((item) => item?.acknowledged !== true) : [];
          const reportCount = openLeaks.length;
          const acceptedCount = Number.isFinite(reconcile?.acknowledged_files) ? reconcile.acknowledged_files : 0;
          const reviewKey = `${root}|${status?.generatedAt ?? ''}`;
          React.useEffect(() => {
            if (view !== 'scan') return;
            if (reportCount === 0 && acceptedCount === 0) return;
            if (review.key === reviewKey && review.phase !== 'failed') return;
            void loadReview(reviewKey);
          }, [view, reviewKey, reportCount, acceptedCount]);
          /** The list shown before the rich reply lands: paths only, newest first. */
          const missingRows = openLeaks.slice(0, 5);
          /** The rich reply, once it lands: name, owner, size, and the confirmation. */
          const rich = review.phase === 'ok' && review.data !== null ? review.data : null;
          /** A read-only session may look, not touch. */
          const readonly = rich?.readOnly === true;
          const ledgerRows = rich === null ? [] : (rich.missing ?? []).filter((item) => !ackedLocal.includes(`${item.path}@${item.ctime}`));
          const shown = rich === null ? missingRows.length : Math.min(5, ledgerRows.length);
          if (typeof console !== 'undefined' && rich !== null) console.error('DBG ok', JSON.stringify(rich.missing));
          /** One compact fact line inside an opened row. */
          const factLine = (label, value, key) =>
            h(
              'div',
              { key, 'data-file-maid': 'missfact' },
              h('span', { 'data-file-maid': 'missfactlabel' }, label),
              h('span', { 'data-file-maid': 'missfactvalue' }, value),
            );
          /** The size column says the kind when a number would lie. */
          const sizeText = (item) => {
            if (item.kind === 'symlink') return t('kind.link');
            if (item.kind === 'directory') return t('kind.dir');
            if (item.kind !== 'file' || !Number.isFinite(item.size)) return t('kind.other');
            return formatSize(item.size);
          };
          const leakRows = rich === null
            ? missingRows.map((item) =>
                h('div', { key: `missing-${item.path}`, 'data-file-maid': 'scanrow' }, h('span', { 'data-file-maid': 'scanval' }, item.path)),
              )
            : ledgerRows.slice(0, 5).map((item) => {
                const name = item.path.split('/').pop();
                const open = openLeak === item.path;
                return h(
                  'div',
                  { key: `leak-${item.path}`, 'data-file-maid': 'missrow', 'data-open': open ? 'true' : 'false' },
                  h(
                    'button',
                    {
                      type: 'button',
                      'data-file-maid': 'misstoggle',
                      'aria-expanded': open ? 'true' : 'false',
                      'aria-controls': `leak-detail-${item.path}`,
                      onClick: () => setOpenLeak(open ? '' : item.path),
                    },
                    h('span', { 'data-file-maid': 'missname' }, name),
                    h('span', { 'data-file-maid': 'missage' }, formatAge(item.ctime, t, now)),
                  ),
                  h(
                    'div',
                    { 'data-file-maid': 'misssub' },
                    h('span', { 'data-file-maid': 'missdim' }, item.dir),
                    h('span', { 'data-file-maid': 'missdim', 'data-align': 'end' }, sizeText(item)),
                  ),
                  open
                    ? h(
                        'div',
                        { 'data-file-maid': 'missdetail', id: `leak-detail-${item.path}` },
                        factLine(t('k.pathFull'), item.path, 'path'),
                        factLine(t('k.ctime'), formatClock(new Date(item.ctime).toISOString(), now), 'ctime'),
                        // The two clocks side by side: "touched" is not "changed", and a
                        // reader who sees the bytes are old can tell a rename from a write.
                        item.mtime === null || item.mtime === undefined
                          ? null
                          : factLine(t('k.mtime'), formatClock(new Date(item.mtime).toISOString(), now), 'mtime'),
                        factLine(t('k.owner'), item.dir, 'owner'),
                        readonly ? h('div', { 'data-file-maid': 'scannote', id: 'leak-readonly' }, t('scan.ackReadonly')) : null,
                        h(
                          'button',
                          {
                            type: 'button',
                            'data-file-maid': 'missact',
                            disabled: readonly,
                            'aria-describedby': readonly ? 'leak-readonly' : undefined,
                            onClick: () => void changeAck('ack', item),
                          },
                          t('scan.ack'),
                        ),
                      )
                    : null,
                );
              });
          const missingBody = [...leakRows];
          if (rich === null && missingRows.length > 0 && reportCount > missingRows.length) {
            missingBody.push(
              h(
                'div',
                { key: 'missing-more', 'data-file-maid': 'scanrow' },
                h('span', { 'data-file-maid': 'scanval' }, fill(t('scan.more'), { n: reportCount - missingRows.length })),
              ),
            );
          }
          if (rich !== null && ledgerRows.length > shown) {
            missingBody.push(
              h(
                'div',
                { key: 'leak-more', 'data-file-maid': 'scanrow' },
                h('span', { 'data-file-maid': 'scanval' }, fill(t('scan.showAll'), { n: ledgerRows.length - shown })),
              ),
            );
          }
          if (rich !== null && rich.truncated === true) {
            missingBody.push(
              h('div', { key: 'leak-trunc', 'data-file-maid': 'scannote' }, fill(t('scan.truncatedNote'), { n: rich.candidateLimit })),
            );
          }
          if (review.phase === 'loading') {
            missingBody.push(h('div', { key: 'leak-loading', 'data-file-maid': 'scannote', 'aria-live': 'polite' }, t('scan.reviewLoading')));
          }
          if (review.phase === 'failed') {
            missingBody.push(
              h(
                'div',
                { key: 'leak-failed', 'data-file-maid': 'scannote', 'aria-live': 'polite' },
                review.message === '' ? t('scan.reviewFailed') : review.message,
              ),
            );
          }
          /** What just changed, so a row that disappeared has an explanation. */
          const ackBar = ackNotice === ''
            ? null
            : h(
                'div',
                { 'data-file-maid': 'ackbar', 'aria-live': 'polite' },
                h('span', { 'data-file-maid': 'acktext' }, ackNotice),
                h(
                  'button',
                  { type: 'button', 'data-file-maid': 'linkbutton', onClick: () => setAckNotice('') },
                  t('scan.ackUndo'),
                ),
              );
          /** Accepted leaks stay visible as a count and can be undone one by one. */
          const ackedBlock = acceptedCount > 0
            ? h(
                'div',
                { 'data-file-maid': 'ackblock' },
                h(
                  'button',
                  {
                    type: 'button',
                    'data-file-maid': 'acktoggle',
                    'aria-expanded': openAcked ? 'true' : 'false',
                    onClick: () => setOpenAcked(!openAcked),
                  },
                  fill(t('scan.ackCount'), { n: acceptedCount }),
                ),
                openAcked && rich !== null
                  ? (rich.acknowledged ?? []).map((item) =>
                      h(
                        'div',
                        { key: `acked-${item.path}`, 'data-file-maid': 'ackrow' },
                        h('span', { 'data-file-maid': 'missname' }, item.path.split('/').pop()),
                        h('span', { 'data-file-maid': 'missage' }, formatAge(item.at, t, now)),
                        h(
                          'button',
                          {
                            type: 'button',
                            'data-file-maid': 'linkbutton',
                            disabled: readonly,
                            onClick: () => void changeAck('unack', item),
                          },
                          t('scan.ackUndo'),
                        ),
                      ),
                    )
                  : null,
              )
            : null;

          const reconcileBody = baselineOnly
            ? scanNote('fresh', t('scan.freshBaseline'))
            : h(
                React.Fragment,
                null,
                h(
                  'div',
                  { 'data-file-maid': 'scanstat' },
                  scanStat('newFiles', num(reconcile.new_files), t('k.newFiles')),
                  scanStat('recorded', num(reconcile.recorded_files, reconcile.recorded), t('k.recorded')),
                  scanStat('ledger', num(reconcile.ledger_files, reconcile.ledger), t('k.ledger')),
                ),
                coverageLost
                  ? scanNote('ledgernote', decisionsGap ? t('scan.recordedNote') : t('scan.ledgerNote'))
                  : null,
                // The three cells are net counts; the leak list is per changed inode. A
                // window where one file was deleted and another added shows 0 next to 1,
                // and both numbers are right — say so instead of letting them argue.
                Number.isFinite(reconcile.missing_total) && Number.isFinite(reconcile.new_files) && reconcile.missing_total > reconcile.new_files
                  ? scanNote('mismatch', fill(t('scan.countMismatch'), { net: reconcile.new_files, n: reconcile.missing_total }))
                  : null,
                reconcile.residual === null && reconcile.baseline !== true
                  ? scanNote('residual', t('scan.residualUnknown'))
                  : !coverageLost && Number.isFinite(reconcile.residual) && reconcile.residual > 0
                  ? scanNote('residual', fill(t('scan.residual'), { n: reconcile.residual }))
                  : null,
                ackBar,
                Number.isFinite(reconcile.unknown_files) && reconcile.unknown_files > 0
                  ? scanNote('unknown', fill(t('scan.unknownFiles'), { n: reconcile.unknown_files }))
                  : null,
                coverageLost || (missingBody.length === 0 && acceptedCount === 0)
                  ? null
                  : h('div', { 'data-file-maid': 'scanrows' }, ...missingBody),
                ackedBlock,
              );

          const scanGrid = h(
            'div',
            { 'data-file-maid': 'scanlayout' },
            scanNotice === ''
              ? null
              : h(
                  'div',
                  { 'data-file-maid': 'banner', 'data-tone': 'error' },
                  h('span', { 'data-file-maid': 'bannertext' }, scanNotice),
                ),
            scanGroup(
              'result',
              t('section.scan'),
              h(
                React.Fragment,
                null,
                h(
                  'div',
                  { 'data-file-maid': 'scanstat' },
                  scanStat('files', scanCount(scan?.files), t('k.files')),
                  scanStat('dirs', scanCount(scan?.dirs), t('k.dirs')),
                  scanStat('ms', Number.isFinite(scan?.durationMs) ? `${scan.durationMs} ms` : '—', t('k.durationMs')),
                ),
                scanStatus,
              scanArmed && reportCount > 0
                ? h(
                    'div',
                    { 'data-file-maid': 'scannote', 'data-tone': 'warn', 'aria-live': 'polite' },
                    fill(t('scan.rerunWarn'), { n: reportCount }),
                  )
                : null,
              h(
                'label',
                { 'data-file-maid': 'exportrow' },
                h('input', {
                  type: 'checkbox',
                  checked: exportWanted,
                  disabled: readonly,
                  'aria-describedby': readonly ? 'export-readonly' : undefined,
                  onChange: (event) => {
                    const next = event.target.checked;
                    setExportWanted(next);
                    try {
                      window.localStorage.setItem(exportKey, next ? '1' : '0');
                    } catch {
                      /* a browser without storage still gets the checkbox */
                    }
                  },
                }),
                h('span', null, t('scan.export')),
              ),
              readonly ? h('div', { 'data-file-maid': 'scannote', id: 'export-readonly' }, t('scan.exportReadonly')) : null,
              ),
              scanAction,
            ),
            scanGroup('reconcile', t('section.reconcile'), reconcileBody, reconcileAside),
          );
          const scanBody = scan === undefined
            ? emptyState(
                t('scan.empty'),
                t('scan.emptyHint'),
                h(
                  'button',
                  {
                    type: 'button',
                    'data-file-maid': 'scanact',
                    'data-tone': 'brand',
                    'aria-busy': scanBusy ? 'true' : 'false',
                    onClick: () => void runScan(),
                  },
                  scanBusy ? t('scan.running') : t('scan.scanNow'),
                ),
              )
            : scanGrid;

          /**
           * One 14px stroke glyph, matching the sidebar's segmented row (`§UI`).
           * @param {string} name - which glyph to draw.
           * @returns {object} the svg element.
           */
          /**
           * One small glyph per view, matching the segmented row.
           * @param {string} name - which view.
           * @returns {object} the glyph node.
           */
          const viewGlyph = (name) =>
            h('span', { 'data-file-maid': 'viewglyph', 'aria-hidden': 'true' }, name === 'dirs' ? '▦' : name === 'misplaced' ? '⚠' : '≈');

          const [busy, setBusy] = React.useState(false);
          const [newDir, setNewDir] = React.useState({ path: '', role: 'autonomous', purpose: '' });
          const [showAllDirs, setShowAllDirs] = React.useState(false);
          const [openRow, setOpenRow] = React.useState('');

          /**
           * Call one of the three Host endpoints. The carrier wraps every reply and the
           * business envelope is its `value`, so both layers are unwrapped here.
           * @param {string} method - form, preview or apply.
           * @param {...string} args - positional wire arguments.
           * @returns {Promise<object>} `{ ok: true, value }` or `{ ok: false, errors }`.
           */
          const callRemote = async (method, ...args) => {
            const remote = typeof services?.get === 'function' ? services.get('remote') : undefined;
            const namespace = (typeof services?.get === 'function' ? services.get('remote.fileMaid') : undefined) ?? remote?.fileMaid;
            if (namespace === undefined || typeof namespace[method] !== 'function') {
              return { ok: false, errors: [{ code: 'E_MAID_UNAVAILABLE', message: t('init.unavailable') }] };
            }
            const outcome = await namespace[method](...args);
            if (outcome?.ok === true) return outcome.value ?? { ok: false, errors: [] };
            return { ok: false, errors: outcome?.error === undefined ? [] : [outcome.error] };
          };

          /**
           * Ask the Host to scan the root now and republish the projection.
           * @returns {Promise<void>} fulfillment after the card reloaded the status.
           */
          const runScan = async () => {
            setScanBusy(true);
            const result = await callRemote('scan', root, readerId, JSON.stringify({ report: true, export: exportWanted ? 'json' : 'none' }));
            setScanBusy(false);
            setScanNotice(result?.ok === true ? '' : describeError(result, t('scan.failed')));
            setRevision((value) => value + 1);
          };

          /** Preference key: whether the next scan should also write the export. */
          const exportKey = `dsh-file-maid.export.${root}`;
          React.useEffect(() => {
            try {
              setExportWanted(window.localStorage.getItem(exportKey) === '1');
            } catch {
              setExportWanted(false);
            }
          }, [exportKey]);

          /**
           * Read the rich leak list once per snapshot.
           *
           * It is a real walk of the tree, so it only runs when the card is showing
           * the scan page and there is something to look at.
           * @param {string} key - cache key (`root` + the projection's `generatedAt`).
           * @returns {Promise<void>} fulfillment after the state settles.
           */
          const loadReview = async (key) => {
            if (review.phase === 'loading' && review.key === key) return;
            setReview({ key, phase: 'loading', data: null, message: '' });
            const result = await callRemote('review', root, readerId);
            if (result?.ok === true) setReview({ key, phase: 'ok', data: result.value ?? {}, message: '' });
            else setReview({ key, phase: 'failed', data: null, message: describeError(result, t('scan.reviewFailed')) });
          };

          /**
           * Accept or undo one leak.
           * @param {'ack' | 'unack'} op - what to do.
           * @param {{ path: string, ctime: number }} item - the leak.
           * @returns {Promise<void>} fulfillment after the reply.
           */
          const changeAck = async (op, item) => {
            setAckNotice('');
            const result = await callRemote('ack', root, readerId, JSON.stringify({ op, path: item.path, ctime: item.ctime }));
            if (result?.ok !== true) {
              setAckNotice(describeError(result, t('scan.ackFailed')));
              return;
            }
            setAckedLocal((list) => (op === 'ack'
              ? [...list, `${item.path}@${item.ctime}`]
              : list.filter((key) => key !== `${item.path}@${item.ctime}`)));
            if (op === 'ack') setAckNotice(fill(t('scan.ackDone'), { name: item.path.split('/').pop() }));
            setRevision((value) => value + 1);
          };

          /**
           * The first draft for one form document.
           * @param {object} doc - form payload.
           * @returns {object} the draft.
           */
          const initialDraft = (doc) => {
            const firstTemplate = Array.isArray(doc.templates) && doc.templates.length > 0 ? doc.templates[0] : undefined;
            return {
            template: firstTemplate?.name ?? 'personal',
            create: doc.mode === 'empty',
            candidates: Object.fromEntries((doc.candidates ?? []).map((item) => [item.path, item.role === 'managed' ? 'register-managed' : 'register-autonomous'])),
            output: doc.mode === 'initialized' ? (doc.catalog?.rootDefault ?? '') : (firstTemplate?.output ?? '80-Outputs'),
            custom: '',
            ops: [],
            showMore: false,
            };
          };

          /**
           * Turn the draft into the wire payload the current mode expects.
           * @param {object} doc - form payload.
           * @param {object} current - draft.
           * @returns {object} the payload.
           */
          const shownView = viewsEnabled ? view : 'dirs';
          const viewItems = [
            { value: 'dirs', label: t('view.dirs') },
            { value: 'misplaced', label: t('view.misplaced') },
            { value: 'scan', label: t('view.scan') },
          ].map((item) => ({
            ...item,
            // The card has no room for a row of its own, so the tabs carry the answer to
            // "which workspace is this?" — the nearest `title` is the one a hover shows.
            node: h(
              'span',
              { 'data-file-maid': 'viewlabel' },
              viewGlyph(item.value),
              h('span', null, item.label),
            ),
          }));
          const switchNode =
            SegmentedTabs === undefined
              ? h(
                  'div',
                  { 'data-file-maid': 'views', role: 'tablist', 'aria-label': t('view.label') },
                  viewItems.map((item) =>
                    h(
                      'button',
                      {
                        key: item.value,
                        type: 'button',
                        role: 'tab',
                        id: `file-maid-tab-${item.value}`,
                        'data-view': item.value,
                        'aria-controls': `file-maid-panel-${item.value}`,
                        'data-file-maid': 'view',
                        disabled: !viewsEnabled,
                        'aria-selected': view === item.value ? 'true' : 'false',
                        onClick: () => setView(item.value),
                      },
                      item.node,
                    ),
                  ),
                )
              : h(SegmentedTabs, {
                  className: 'file-maid-views',
                  label: t('view.label'),
                  value: shownView,
                  items: viewItems.map((item) => ({
                    value: item.value,
                    id: `file-maid-tab-${item.value}`,
                    panelId: `file-maid-panel-${item.value}`,
                    label: item.node,
                  })),
                  onChange: (next) => setView(next),
                });

          const visibleRows = showAllDirs ? compactRows : compactRows.slice(0, 5);
          const moreRow =
            dirs.length > 5
              ? h(
                  'button',
                  {
                    type: 'button',
                    'data-file-maid': 'morebar',
                    'aria-expanded': showAllDirs ? 'true' : 'false',
                    'aria-controls': 'file-maid-dirlist',
                    onClick: () => setShowAllDirs(!showAllDirs),
                  },
                  h('span', { 'data-file-maid': 'morebarlabel' }, showAllDirs ? t('more.hide') : fill(t('more.show'), { n: dirs.length - 5 })),
                  h('span', { 'data-file-maid': 'morebarglyph', 'aria-hidden': 'true' }, showAllDirs ? '▴' : '▾'),
                )
              : null;
          const rules = Array.isArray(catalog?.rules) ? catalog.rules : [];
          /**
           * Add or remove one rule. The first matching rule wins in the decider, so the
           * Host refuses a duplicate instead of letting a new one quietly shadow it.
           * @param {'rule-add' | 'rule-remove'} op - what to do.
           * @param {{ match?: string, dir?: string }} body - the rule.
           * @returns {Promise<boolean>} whether the Host accepted it.
           */
          const writeRule = async (op, body) => {
            setRuleBusy(true);
            setRuleNotice('');
            const result = await callRemote('save', root, readerId, JSON.stringify({ op, ...body }));
            setRuleBusy(false);
            if (result?.ok !== true) {
              setRuleNotice(describeError(result, t('rule.failed')));
              return false;
            }
            setRevision((value) => value + 1);
            return true;
          };

          const ruleRows = rules.map((rule) =>
            h(
              'div',
              { key: `rule-${rule.match}`, 'data-file-maid': 'rulerow' },
              h('span', { 'data-file-maid': 'rulematch' }, rule.match),
              h('span', { 'data-file-maid': 'ruletarget' }, `→ ${rule.dir}`),
              h(
                'button',
                {
                  type: 'button',
                  'data-file-maid': 'linkbutton',
                  disabled: ruleBusy,
                  onClick: () => void writeRule('rule-remove', { match: rule.match }),
                },
                t('rule.delete'),
              ),
            ),
          );

          const ruleFormNode = ruleForm === undefined
            ? null
            : h(
                'div',
                { 'data-file-maid': 'ruleform' },
                h('input', {
                  type: 'text',
                  'data-file-maid': 'ruleinput',
                  'aria-label': t('rule.match'),
                  placeholder: t('rule.matchHint'),
                  maxLength: 40,
                  value: ruleForm.match,
                  onChange: (event) => setRuleForm({ ...ruleForm, match: event.target.value }),
                }),
                h(
                  'select',
                  {
                    'data-file-maid': 'ruledir',
                    'aria-label': t('rule.target'),
                    value: ruleForm.dir,
                    onChange: (event) => setRuleForm({ ...ruleForm, dir: event.target.value }),
                  },
                  dirs.map((dir) => h('option', { key: dir.path, value: dir.path }, dir.path)),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    'data-file-maid': 'rulesave',
                    'data-tone': 'brand',
                    disabled: ruleBusy || ruleForm.match.trim().length === 0 || ruleForm.dir === '',
                    onClick: () => {
                      void writeRule('rule-add', { match: ruleForm.match.trim(), dir: ruleForm.dir }).then((done) => {
                        if (done) setRuleForm(undefined);
                      });
                    },
                  },
                  t('rule.save'),
                ),
                h('button', { type: 'button', 'data-file-maid': 'linkbutton', onClick: () => setRuleForm(undefined) }, t('rule.cancel')),
              );

          const rulesBlock = h(
            'div',
            { 'data-file-maid': 'rulegroup' },
            h(
              'div',
              { 'data-file-maid': 'sectionhead' },
              h('span', { 'data-file-maid': 'rulecount' }, `${t('section.rules')} ${rules.length}`),
              h('span', { 'data-file-maid': 'spacer' }),
              h(
                'button',
                {
                  type: 'button',
                  'data-file-maid': 'ghostbutton',
                  onClick: () => setRuleForm(ruleForm === undefined ? { match: '', dir: dirs[0]?.path ?? '' } : undefined),
                },
                t('rule.add'),
              ),
            ),
            rules.length === 0 && ruleForm === undefined
              ? h('div', { 'data-file-maid': 'scannote' }, t('rule.empty'))
              : null,
            rules.length === 0 ? null : h('div', { 'data-file-maid': 'rulelist' }, ...ruleRows),
            ruleNotice === '' ? null : h('div', { 'data-file-maid': 'rowerror' }, ruleNotice),
            ruleFormNode,
          );

          /**
           * Open the directory form on one row, or on an empty one for `add`.
           * @param {'add' | 'edit'} mode - which operation the form will send.
           * @param {object} [dir] - the row being edited.
           * @returns {void}
           */
          const openManage = (mode, dir) => {
            setManageError('');
            // The form and an expanded row both live in a ~240px column; showing them
            // at once forces a scroll for no benefit.
            setOpenDir('');
            setPurposeOpen('');
            setManage({
              mode,
              path: dir?.path ?? '',
              purpose: dir?.about ?? '',
              excludes: typeof dir?.excludes === 'string' ? dir.excludes : '',
              makeDefault: mode === 'edit' && dir?.path === catalog?.rootDefault,
            });
          };

          /**
           * Send the form to the Host and reload the projection it rewrote.
           * @param {'add' | 'edit' | 'remove'} op - the operation.
           * @param {object} [dir] - the row being removed.
           * @returns {Promise<void>} fulfillment after the attempt.
           */
          const submitManage = async (op, dir) => {
            // The form calls it `edit`; the Host's operations are add/update/remove.
            const body = op === 'remove'
              ? { op, path: dir?.path ?? '' }
              : {
                  op: op === 'edit' ? 'update' : op,
                  path: (manage?.path ?? '').trim(),
                  purpose: manage?.purpose ?? '',
                  excludes: manage?.excludes ?? '',
                  makeDefault: manage?.makeDefault === true,
                };
            setManageBusy(true);
            setManageError('');
            const result = await callRemote('save', root, readerId, JSON.stringify(body));
            setManageBusy(false);
            if (result?.ok === true) {
              setManage(undefined);
              setRevision((value) => value + 1);
              return;
            }
            setManageError(describeError(result, t('manage.failed')));
          };

          /**
           * Ask the Host to open the system folder dialog and take its answer.
           * @returns {Promise<void>} fulfillment after the dialog closed.
           */
          /**
           * Ask the Host to open the system folder dialog.
           * @returns {Promise<{ path: string } | { error: string } | undefined>} the chosen
           * folder relative to the root, an error sentence, or nothing when cancelled.
           */
          const askFolder = async () => {
            const result = await callRemote('pick', root, readerId);
            if (result?.ok !== true) return { error: describeError(result, t('manage.failed')) };
            if (result.value?.cancelled === true || typeof result.value?.path !== 'string') return undefined;
            return { path: result.value.path };
          };

          const pickDirectory = async () => {
            setManageBusy(true);
            setManageError('');
            const chosen = await askFolder();
            setManageBusy(false);
            if (chosen?.error !== undefined) {
              setManageError(chosen.error);
              return;
            }
            if (chosen === undefined) return;
            setManage((current) => (current === undefined ? current : { ...current, path: chosen.path }));
          };

          /**
           * A directory needs a folder and a sentence saying what lands there;
           * refusals are optional. The folder check is the cheap half of the
           * Host's rule, so the button never invites a name that cannot be saved.
           */
          const managePath = manage === undefined ? '' : manage.path.trim();
          // Same rule the host applies (up to three segments, no dot segments, no
          // absolute path): the two forms used to read one rule two ways.
          const managePathLegal = (() => {
            const raw = managePath.trim();
            if (raw === '' || raw.startsWith('/') || raw.includes('\\')) return false;
            const parts = raw.split('/').filter((part) => part !== '');
            return (
              parts.length > 0 &&
              parts.length <= 3 &&
              parts.every((part) => part !== '' && part !== '.' && part !== '..' && !part.startsWith('.'))
            );
          })();
          const manageReady =
            manage !== undefined &&
            manage.mode !== 'remove' &&
            managePathLegal &&
            manage.purpose.trim().length > 0;
          /** What still stands between this form and a save, in the user's words. */
          const manageHint = (() => {
            if (manage === undefined || manage.mode === 'remove') return '';
            if (managePath.length > 0 && !managePathLegal) return t('manage.pathInvalid');
            const missing = [];
            if (managePath.length === 0) missing.push(t('manage.path'));
            if (manage.purpose.trim().length === 0) missing.push(t('manage.purpose'));
            return missing.length === 0 ? '' : fill(t('manage.required'), { fields: missing.join('、') });
          })();

          const manageBox = manage === undefined
            ? null
            : manage.mode === 'remove'
              ? h(
                  'div',
                  { 'data-file-maid': 'managebox' },
                  h('div', { 'data-file-maid': 'managerow' },
                    h('span', { 'data-file-maid': 'muted' }, fill(t('manage.confirmRemove'), { path: manage.path }))),
                  manageError === '' ? null : h('div', { 'data-file-maid': 'manageerror', role: 'alert' }, manageError),
                  h(
                    'div',
                    { 'data-file-maid': 'manageactions' },
                    h(
                      'button',
                      { type: 'button', 'data-file-maid': 'button', disabled: manageBusy, onClick: () => submitManage('remove', manage) },
                      t('manage.delete'),
                    ),
                    h(
                      'button',
                      { type: 'button', 'data-file-maid': 'linkbutton', disabled: manageBusy, onClick: () => setManage(undefined) },
                      t('manage.cancel'),
                    ),
                  ),
                )
              : h(
                'div',
                { 'data-file-maid': 'managebox' },
                h(
                  'div',
                  { 'data-file-maid': 'managerow' },
                  h('label', { 'data-file-maid': 'muted', htmlFor: 'file-maid-manage-path' }, t('manage.path'), h('span', { 'data-file-maid': 'required' }, ' *')),
                  h('input', {
                    'data-file-maid': 'input',
                    id: 'file-maid-manage-path',
                    required: true,
                    'data-invalid': managePath.length === 0 || !managePathLegal ? 'true' : 'false',
                    value: manage.path,
                    disabled: manage.mode === 'edit',
                    placeholder: '80-Outputs',
                    onChange: (event) => setManage({ ...manage, path: event.target.value }),
                  }),
                  manage.mode === 'edit'
                    ? null
                    : h(
                        'button',
                        { type: 'button', 'data-file-maid': 'linkbutton', disabled: manageBusy, onClick: pickDirectory },
                        t('manage.pick'),
                      ),
                ),
                h(
                  'div',
                  { 'data-file-maid': 'managerow' },
                  h('label', { 'data-file-maid': 'muted', htmlFor: 'file-maid-manage-purpose' }, t('manage.purpose'), h('span', { 'data-file-maid': 'required' }, ' *')),
                  h('input', {
                    'data-file-maid': 'input',
                    id: 'file-maid-manage-purpose',
                    required: true,
                    maxLength: 200,
                    'data-invalid': manage.purpose.trim().length === 0 ? 'true' : 'false',
                    value: manage.purpose,
                    placeholder: t('manage.purposeHint'),
                    onChange: (event) => setManage({ ...manage, purpose: event.target.value }),
                  }),
                ),
                h(
                  'div',
                  { 'data-file-maid': 'managerow' },
                  h('label', { 'data-file-maid': 'muted', htmlFor: 'file-maid-manage-excludes' }, t('manage.excludes')),
                  h('input', {
                    'data-file-maid': 'input',
                    id: 'file-maid-manage-excludes',
                    maxLength: 200,
                    value: manage.excludes,
                    placeholder: t('manage.termsHint'),
                    onChange: (event) => setManage({ ...manage, excludes: event.target.value }),
                  }),
                ),
                manage.mode === 'edit'
                  ? h(
                      'div',
                      { 'data-file-maid': 'managerow' },
                      h(
                        'label',
                        { 'data-file-maid': 'muted', htmlFor: 'file-maid-manage-fallback' },
                        h('input', {
                          'data-file-maid': 'check',
                          id: 'file-maid-manage-fallback',
                          type: 'checkbox',
                          checked: manage.makeDefault === true,
                          disabled: manage.makeDefault === true,
                          onChange: (event) => setManage({ ...manage, makeDefault: event.target.checked }),
                        }),
                        t('manage.fallback'),
                      ),
                      h(
                        'span',
                        { 'data-file-maid': 'muted' },
                        manage.makeDefault === true ? t('manage.fallbackCurrent') : t('manage.fallbackHint'),
                      ),
                    )
                  : null,
                manageError === '' ? null : h('div', { 'data-file-maid': 'manageerror' }, manageError),
                manageHint === '' ? null : h('div', { 'data-file-maid': 'managehint' }, manageHint),
                h(
                  'div',
                  { 'data-file-maid': 'manageactions' },
                  h(
                    'button',
                    { type: 'button', 'data-file-maid': 'button', 'data-tone': 'primary', disabled: manageBusy || !manageReady, onClick: () => submitManage(manage.mode) },
                    manage.mode === 'add' ? t('manage.create') : t('manage.save'),
                  ),
                  h(
                    'button',
                    { type: 'button', 'data-file-maid': 'linkbutton', disabled: manageBusy, onClick: () => setManage(undefined) },
                    t('manage.cancel'),
                  ),
                ),
              );

          const bodyNode = compact
            ? h(
                React.Fragment,
                null,
                dirs.length === 0
                  ? null
                  : h(
                      'div',
                      { 'data-file-maid': 'sectionhead' },
                      h('span', null, `${t('view.dirs')} ${dirs.length}`),
                      h('span', { 'data-file-maid': 'spacer' }),
                      h(
                        'button',
                        { type: 'button', 'data-file-maid': 'ghostbutton', onClick: () => openManage('add') },
                        t('manage.add'),
                      ),
                    ),
                dirError === '' ? null : h('div', { 'data-file-maid': 'rowerror' }, dirError),
                manageBox,
                dirs.length === 0
                  ? hintText === ''
                    ? null
                    : emptyState(t('section.catalog'), hintText)
                  : h('div', { 'data-file-maid': 'tablist', id: 'file-maid-dirlist' }, visibleRows),
                moreRow,
                dirs.length === 0 ? null : rulesBlock,
              )
            : h(
                React.Fragment,
                null,
                // The wide page wears the same head as the card's three pages: a quiet
                // overline with the row count. It used to be a 12px bold primary line,
                // which made the 目录 and 错投 tabs disagree on the one element they
                // should agree on. An empty list states itself instead of counting zero.
                dirs.length === 0
                  ? null
                  : h(
                      'div',
                      { 'data-file-maid': 'sectionhead' },
                      h('span', null, `${t('section.catalog')} ${dirs.length}`),
                    ),
                manageBox,
                table,
                rulesBlock,
              );

          /**
           * The card drops the body entirely while the switch is inert — there is nothing to
           * show and the reason already sits on the hint line. The wide page keeps it: there
           * the reason lives in the banner, so the section still needs its slot.
           */
          /* ---- setup layer: turn a root without a table into a routable one ---- */
          const setupEntry = !viewsEnabled && embedded && state.phase === 'ok' && catalogState === 'UNINITIALIZED';
          const setupBlank = {
            step: 'list',
            dirs: [],
            rootDefault: '',
            draft: { path: '', purpose: '', excludes: '' },
            problem: null,
            checking: false,
            picking: false,
            error: null,
            scan: null,
          };
          const beginSetup = () => setSetup({ ...setupBlank });
          const setupPatch = (patch) => setSetup((current) => ({ ...(current ?? setupBlank), ...patch }));
          const setupForm = setup?.draft ?? { path: '', purpose: '', excludes: '' };
          const setupPath = setupForm.path.trim();
          const setupPurpose = setupForm.purpose.trim();
          const setupDuplicate = (setup?.dirs ?? []).some((dir) => dir.path === setupPath.replace(/\\+/gu, '/').replace(/\/+$/u, ''));
          const setupFormReady = setupPath !== '' && setupPurpose !== '' && setup?.problem == null && !setupDuplicate;
          const setupFormHint = setupFormReady
            ? ''
            : fill(t('setup.needFields'), {
                fields: [
                  setupPath === '' ? t('setup.path') : '',
                  setupPurpose === '' ? t('setup.purpose') : '',
                ].filter((item) => item !== '').join('、'),
              });
          const checkSetupPath = async () => {
            const value = setupPath;
            if (value === '') {
              setupPatch({ problem: null, checking: false });
              return;
            }
            setupPatch({ checking: true });
            const result = await callRemote('draft', root, readerId, value);
            if (result?.ok !== true) {
              setupPatch({ checking: false, problem: describeError(result, t('setup.checkFailed')) });
              return;
            }
            setupPatch({ checking: false, problem: result.value?.path?.problem ?? null });
          };
          const pickSetupPath = async () => {
            setupPatch({ picking: true, error: null });
            const chosen = await askFolder();
            if (chosen?.error !== undefined) {
              setupPatch({ picking: false, problem: chosen.error });
              return;
            }
            if (chosen === undefined) {
              setupPatch({ picking: false });
              return;
            }
            setupPatch({ picking: false, draft: { ...setupForm, path: chosen.path }, problem: null });
            // The draft check is what catches a folder that is missing or too deep.
            const result = await callRemote('draft', root, readerId, chosen.path);
            if (result?.ok === true) setupPatch({ problem: result.value?.path?.problem ?? null });
            else setupPatch({ problem: describeError(result, t('setup.checkFailed')) });
          };
          const addSetupRow = () => {
            if (!setupFormReady) return;
            const relative = setupPath.replace(/\\+/gu, '/').replace(/\/+$/u, '');
            const next = [...(setup?.dirs ?? []), { path: relative, purpose: setupPurpose, excludes: setupForm.excludes.trim() }];
            setupPatch({
              dirs: next,
              rootDefault: setup?.rootDefault === '' ? relative : (setup.rootDefault ?? ''),
              draft: { path: '', purpose: '', excludes: '' },
              problem: null,
            });
          };
          const removeSetupRow = (path) => {
            const next = (setup?.dirs ?? []).filter((dir) => dir.path !== path);
            setupPatch({ dirs: next, rootDefault: setup?.rootDefault === path ? '' : (setup?.rootDefault ?? '') });
          };
          const writeSetup = async () => {
            setupPatch({ step: 'writing', error: null });
            const body = JSON.stringify({ op: 'init', dirs: setup?.dirs ?? [], rootDefault: setup?.rootDefault ?? '' });
            const result = await callRemote('save', root, readerId, body);
            if (result?.ok === true) {
              const value = result.value ?? {};
              setSetup((current) => ({ ...(current ?? setupBlank), step: 'done', scan: value.scan ?? null }));
              setRevision((count) => count + 1);
              return;
            }
            const code = result?.errors?.[0]?.code ?? '';
            if (code === 'E_MAID_EXISTS') {
              // Somebody finished the same root meanwhile: show the finished state.
              setSetup((current) => ({ ...(current ?? setupBlank), step: 'done', scan: null }));
              setRevision((count) => count + 1);
              return;
            }
            setupPatch({ step: 'failed', error: describeError(result, t('setup.failed')) });
          };
          const setupBack = (target) => () => {
            if (target === 'close') {
              setSetup(undefined);
              return;
            }
            setupPatch({ step: target, error: null });
          };
          const setupLayer = (() => {
            if (setup === undefined) {
              if (!setupEntry) return null;
              return h(
                'div',
                { 'data-file-maid': 'setuplayer' },
                h('div', { 'data-file-maid': 'setuplead' }, t('setup.lead')),
                h('div', { 'data-file-maid': 'setupnote' }, t('setup.detail')),
                h(
                  'button',
                  { type: 'button', 'data-file-maid': 'setupcta', onClick: beginSetup },
                  t('setup.entry'),
                ),
              );
            }
            const step = setup.step;
            const back = (target) =>
              h(
                'button',
                { type: 'button', 'data-file-maid': 'setupback', onClick: setupBack(target) },
                t('setup.leave'),
              );
            const actions = (...children) => h('div', { 'data-file-maid': 'setupactions' }, ...children);
            if (step === 'done') {
              const scan = setup.scan;
              return h(
                'div',
                { 'data-file-maid': 'setuplayer' },
                h('div', { 'data-file-maid': 'setuptitle' }, fill(t('setup.done'), { dirs: setup.dirs.length })),
                h(
                  'div',
                  { 'data-file-maid': 'setupdonemeta' },
                  scan === null || scan === undefined
                    ? t('setup.scanPending')
                    : fill(t('setup.doneMeta'), { files: fileCount(scan.files) }),
                ),
                h('div', { 'data-file-maid': 'setupnote' }, t('setup.doneNote')),
                actions(
                  h(
                    'button',
                    {
                      type: 'button',
                      'data-file-maid': 'setupcta',
                      onClick: () => {
                        setSetup(undefined);
                        setView('dirs');
                        setRevision((count) => count + 1);
                      },
                    },
                    t('setup.doneAction'),
                  ),
                ),
              );
            }
            if (step === 'failed') {
              return h(
                'div',
                { 'data-file-maid': 'setuplayer' },
                h('div', { 'data-file-maid': 'setuptitle' }, t('setup.failed')),
                h('div', { 'data-file-maid': 'setuperror', role: 'alert' }, setup.error ?? ''),
                h('div', { 'data-file-maid': 'setupnote' }, fill(t('setup.errorKept'), { n: setup.dirs.length })),
                actions(
                  h('button', { type: 'button', 'data-file-maid': 'setupcta', onClick: () => writeSetup() }, t('setup.retry')),
                  h('button', { type: 'button', 'data-file-maid': 'setupsecondary', onClick: setupBack('confirm') }, t('setup.back')),
                ),
              );
            }
            if (step === 'writing') {
              return h(
                'div',
                { 'data-file-maid': 'setuplayer', 'aria-busy': 'true' },
                h('div', { 'data-file-maid': 'setuptitle' }, t('setup.writing')),
                h('div', { 'data-file-maid': 'setuppromise' }, t('setup.confirmPromise')),
                h('div', { 'data-file-maid': 'setupstatus', 'aria-live': 'polite' }, t('setup.scanning')),
              );
            }
            if (step === 'confirm') {
              const missingDefault = setup.rootDefault === '';
              return h(
                'div',
                { 'data-file-maid': 'setuplayer' },
                h('div', { 'data-file-maid': 'setuphead' }, back('list'), h('span', { 'data-file-maid': 'setuptitle' }, t('setup.confirmTitle'))),
                h('div', { 'data-file-maid': 'setupcount' }, fill(t('setup.count'), { n: setup.dirs.length })),
                h(
                  'div',
                  { 'data-file-maid': 'setupconfirmlist' },
                  ...setup.dirs.map((dir) =>
                    h(
                      'div',
                      { key: `c-${dir.path}`, 'data-file-maid': 'setupconfirmrow' },
                      dir.path === setup.rootDefault ? h('span', { 'data-file-maid': 'setupdot', 'aria-hidden': 'true' }, '●') : null,
                      h('span', { 'data-file-maid': 'mono' }, dir.path),
                    ),
                  ),
                ),
                h('div', { 'data-file-maid': 'setupnote' }, fill(t('setup.confirmDefault'), { path: setup.rootDefault })),
                h('div', { 'data-file-maid': 'setuppromise' }, t('setup.confirmPromise')),
                missingDefault ? h('div', { 'data-file-maid': 'setuperror', role: 'alert' }, t('setup.needDefault')) : null,
                actions(
                  h('button', { type: 'button', 'data-file-maid': 'setupcta', disabled: missingDefault, onClick: () => writeSetup() }, t('setup.write')),
                ),
              );
            }
            if (step === 'form') {
              /**
               * One labelled field in the setup form.
               * @param {string} key - draft field.
               * @param {string} label - visible label.
               * @param {string} placeholder - example value.
               * @param {boolean} needed - whether the step cannot continue without it.
               * @returns {object} the element.
               */
              const field = (key, label, placeholder, needed) =>
                h(
                  'label',
                  { 'data-file-maid': 'setupfield' },
                  h('span', { 'data-file-maid': 'setuplabel' }, label, needed === true ? h('span', { 'data-file-maid': 'required' }, ' *') : null),
                  h('input', {
                    type: 'text',
                    'data-file-maid': 'setupinput',
                    'aria-required': needed === true ? 'true' : 'false',
                    placeholder,
                    maxLength: key === 'path' ? undefined : 200,
                    value: setupForm[key],
                    onChange: (event) => setupPatch({ draft: { ...setupForm, [key]: event.target.value } }),
                    onBlur: key === 'path' ? () => void checkSetupPath() : undefined,
                  }),
                );
              return h(
                'div',
                { 'data-file-maid': 'setuplayer' },
                h('div', { 'data-file-maid': 'setuphead' }, back('list'), h('span', { 'data-file-maid': 'setuptitle' }, t('setup.addTitle'))),
                h(
                  'div',
                  { 'data-file-maid': 'setupfield' },
                  h(
                    'label',
                    { 'data-file-maid': 'setuplabel', htmlFor: 'file-maid-setup-path' },
                    t('setup.path'),
                    h('span', { 'data-file-maid': 'required' }, ' *'),
                  ),
                  h(
                    'span',
                    { 'data-file-maid': 'setuprowof' },
                    h('input', {
                      type: 'text',
                      id: 'file-maid-setup-path',
                      'data-file-maid': 'setupinput',
                      'aria-required': 'true',
                      placeholder: t('setup.pathPh'),
                      value: setupForm.path,
                      onChange: (event) => setupPatch({ draft: { ...setupForm, path: event.target.value } }),
                      onBlur: () => void checkSetupPath(),
                    }),
                    h(
                      'button',
                      {
                        type: 'button',
                        'data-file-maid': 'setupsecondary',
                        disabled: setup?.picking === true,
                        onClick: () => void pickSetupPath(),
                      },
                      t('manage.pick'),
                    ),
                  ),
                ),
                setup.problem === null
                  ? h('div', { 'data-file-maid': 'setuphint' }, t('setup.pathHint'))
                  : h('div', { 'data-file-maid': 'setupproblem', role: 'status' }, setup.problem),
                setupDuplicate ? h('div', { 'data-file-maid': 'setupproblem' }, t('setup.dup')) : null,
                (setup?.dirs ?? []).length >= 35
                  ? h('div', { 'data-file-maid': 'setuphint' }, fill(t('setup.tooMany'), { n: (setup?.dirs ?? []).length }))
                  : null,
                field('purpose', t('setup.purpose'), t('setup.purposePh'), true),
                field('excludes', t('setup.excludes'), t('setup.excludesPh'), false),
                actions(
                  setupFormHint === '' ? null : h('div', { 'data-file-maid': 'setuphint' }, setupFormHint),
                  h('button', { type: 'button', 'data-file-maid': 'setupcta', disabled: !setupFormReady, onClick: addSetupRow }, t('setup.ok')),
                  h('button', { type: 'button', 'data-file-maid': 'setupsecondary', onClick: setupBack('list') }, t('setup.cancel')),
                ),
              );
            }
            // list
            return h(
              'div',
              { 'data-file-maid': 'setuplayer' },
              h(
                'div',
                { 'data-file-maid': 'setuphead' },
                back('close'),
                h('span', { 'data-file-maid': 'setuptitle' }, t('setup.listTitle')),
                h('span', { 'data-file-maid': 'setupcount' }, fill(t('setup.count'), { n: setup.dirs.length })),
              ),
              setup.dirs.length === 0
                ? h(
                    'div',
                    null,
                    h('div', { 'data-file-maid': 'setuplead' }, t('setup.emptyTitle')),
                    h('div', { 'data-file-maid': 'setupnote' }, t('setup.emptyHint')),
                  )
                : h(
                    'div',
                    { 'data-file-maid': 'setuplist', role: 'list' },
                    ...setup.dirs.map((dir) =>
                      h(
                        'div',
                        { key: `r-${dir.path}`, 'data-file-maid': 'setuprow', role: 'listitem' },
                        h(
                          'label',
                          { 'data-file-maid': 'setuprowmain' },
                          h('input', {
                            type: 'radio',
                            name: 'file-maid-default',
                            'data-file-maid': 'setupradio',
                            checked: setup.rootDefault === dir.path,
                            'aria-label': fill(t('setup.defaultOf'), { path: dir.path }),
                            onChange: () => setupPatch({ rootDefault: dir.path }),
                          }),
                          h('span', { 'data-file-maid': 'setuppath' }, dir.path),
                          h('span', { 'data-file-maid': 'setuppurpose' }, dir.purpose),
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            'data-file-maid': 'setupremove',
                            'aria-label': fill(t('setup.removeOf'), { path: dir.path }),
                            onClick: () => removeSetupRow(dir.path),
                          },
                          t('setup.remove'),
                        ),
                      ),
                    ),
                  ),
              setup.dirs.length === 0
                ? null
                : h('div', { 'data-file-maid': 'setupdefaulthint' }, setup.rootDefault === '' ? t('setup.needDefault') : t('setup.defaultHint')),
              actions(
                h('button', { type: 'button', 'data-file-maid': 'setupcta', onClick: setupBack('form') }, t('setup.add')),
                setup.dirs.length === 0
                  ? null
                  : h('button', { type: 'button', 'data-file-maid': 'setupsecondary', disabled: setup.rootDefault === '', onClick: setupBack('confirm') }, fill(t('setup.next'), { n: setup.dirs.length })),
              ),
            );
          })();

          const bodyBlock =
            viewsEnabled || !embedded || setupLayer !== null
              ? h(
                  'div',
                  {
                    'data-file-maid': 'viewbody',
                    id: `file-maid-panel-${shownView}`,
                    role: 'tabpanel',
                    'aria-labelledby': `file-maid-tab-${shownView}`,
                  },
                  setupLayer !== null
                    ? setupLayer
                    : shownView === 'dirs'
                    ? bodyNode
                    : shownView === 'scan'
                      ? scanBody
                      : h(
                          React.Fragment,
                          null,
                          h(
                            'div',
                            { 'data-file-maid': 'sectionhead' },
                            h(
                              'span',
                              null,
                              misplaced.length === 0
                                ? t('section.misplaced')
                                : `${t('section.misplaced')} ${misplaced.length}`,
                            ),
                          ),
                          misplacedList,
                        ),
                )
              : null;

          const viewslot = h(
            'div',
            {
              'data-file-maid': 'viewslot',
              'data-disabled': viewsEnabled ? 'false' : 'true',
              'aria-disabled': viewsEnabled ? 'false' : 'true',
              ...(viewsEnabled ? {} : { inert: '' }),
            },
            switchNode,
          );

          return h(
            'div',
            { 'data-file-maid': compact ? 'tabpage' : 'page' },
            styles,
            header,
            // The card already shows the picked root (and its own age), and the scan details
            // live in the 扫描 section, so this line only repeats them.
            embedded || (metaParts.length === 0 && roots.length <= 1) ? null : meta,
            // The card body explains its own state inline; the wide page keeps banners.
            embedded ? hintLine : null,
            banners,
            // Inside the setup flow (S2–S7) the strip is hidden: those screens replace
            // the three pages instead of sitting under them, and dimmed tabs invite a
            // click that cannot work.
            setup === undefined ? viewslot : null,
            bodyBlock,
          );
        }

        /**
         * A tooltip that survives the card's own clipping. A native `title` does not show
         * up here (the badge sits inside a button, and the sidebar clips overflow), so the
         * bubble renders into `document.body` and is positioned against the badge.
         * @param {object} props - `{tip, children}`.
         * @returns {object} the trigger plus, while hovered, the portal.
         */
        const StateTip = (props) => {
          const { tip, children } = props;
          const [spot, setSpot] = React.useState(null);
          const holder = React.useRef(null);
          const show = () => {
            const node = holder.current;
            if (node === null || node === undefined) return;
            const rect = node.getBoundingClientRect();
            const width = Math.min(240, Math.max(160, window.innerWidth - 24));
            const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
            // Flip above the badge near the bottom edge: the card head sits right above the
            // first body line, and a downward bubble used to cover it.
            const above = rect.bottom + 96 > window.innerHeight;
            setSpot(
              above
                ? { left, width, bottom: Math.max(8, window.innerHeight - rect.top + 6) }
                : { left, width, top: rect.bottom + 6 },
            );
          };
          const hide = () => setSpot(null);
          React.useEffect(() => {
            if (spot === null) return undefined;
            const close = () => setSpot(null);
            window.addEventListener('scroll', close, true);
            window.addEventListener('resize', close);
            return () => {
              window.removeEventListener('scroll', close, true);
              window.removeEventListener('resize', close);
            };
          }, [spot === null]);
          const bubble =
            spot === null || reactDomRenderer === null || typeof reactDomRenderer.createPortal !== 'function'
              ? null
              : reactDomRenderer.createPortal(
                  h(
                    'div',
                    {
                      'data-file-maid': 'statetipbox',
                      role: 'tooltip',
                      style: {
                        position: 'fixed',
                        left: `${spot.left}px`,
                        width: `${spot.width}px`,
                        ...(spot.top === undefined ? { bottom: `${spot.bottom}px` } : { top: `${spot.top}px` }),
                      },
                    },
                    tip,
                  ),
                  document.body,
                );
          return h(
            React.Fragment,
            null,
            h(
              'span',
              {
                ref: holder,
                'data-file-maid': 'statetip',
                onMouseEnter: show,
                onMouseLeave: hide,
                onFocus: show,
                onBlur: hide,
                tabIndex: 0,
              },
              children,
            ),
            bubble,
          );
        };

        /**
         * The sidebar card: one header row that collapses, then the panel body.
         * It renders in its own React root inside the browsing region, so the region's
         * own component is never re-rendered by this plugin.
         * @returns {object} the card element.
         */
        const FileMaidCard = () => {
          const [open, setOpen] = React.useState(() => {
            try {
              return window.localStorage.getItem(OPEN_KEY) === '1';
            } catch {
              return false;
            }
          });
          const [, wake] = React.useState(0);
          React.useEffect(() => {
            const listener = () => wake((value) => value + 1);
            cardState.listeners.add(listener);
            return () => cardState.listeners.delete(listener);
          }, []);
          const toggle = () => {
            setOpen((current) => {
              const next = !current;
              try {
                window.localStorage.setItem(OPEN_KEY, next ? '1' : '0');
              } catch {
                /* a private window keeps the state in memory only */
              }
              return next;
            });
          };
          // The body stays mounted so the collapsed header can name the state it read;
          // it is hidden rather than unmounted, which keeps one fetch per card mount.
          const body = h(
            'div',
            { 'data-file-maid': 'cardbody', id: 'file-maid-cardbody', hidden: open ? undefined : true, style: open ? undefined : { display: 'none' } },
            h(FileMaidPanel, { compact: true, embedded: true }),
          );
          const badge = cardState.value;
          return h(
            'div',
            { 'data-file-maid': 'card', 'data-open': open ? 'true' : 'false' },
            h(
              'div',
              { 'data-file-maid': 'cardhead' },
              // The disclosure is a button of its own: the refresh button and the badge are
              // siblings, so pressing refresh no longer collapses the card (and a button is
              // never nested inside another button).
              h(
                'button',
                {
                  type: 'button',
                  'data-file-maid': 'cardtoggle',
                  'aria-expanded': open ? 'true' : 'false',
                  'aria-controls': 'file-maid-cardbody',
                  onClick: toggle,
                },
                h(
                  'span',
                  { 'data-file-maid': 'chevron', 'aria-hidden': 'true', style: { transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 140ms ease' } },
                  h('svg', { width: 12, height: 12, viewBox: '0 0 16 16', focusable: 'false' }, h('path', { d: 'M6 3.5 10.5 8 6 12.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' })),
                ),
                h(
                  'span',
                  { 'data-file-maid': 'cardtitle' },
                  t('title'),
                  // The workspace name rides along, but it is the first thing to give way:
                  // a truncated "文档…" would make the product name unrecognizable.
                  badge === undefined || badge.workspace === undefined || badge.workspace === ''
                    ? null
                    : h('span', { 'data-file-maid': 'cardsuffix' }, ` · ${badge.workspace}`),
                ),
              ),
              badge === undefined
                ? null
                : (() => {
                    const mark = h(
                      'span',
                      { 'data-file-maid': 'badge', 'data-tone': badge.tone, role: 'status' },
                      h('span', { 'data-file-maid': 'badgedot', 'aria-hidden': 'true' }),
                      h('span', { 'data-file-maid': 'badgelabel' }, badge.label),
                    );
                    // A bubble that repeats the word you are already looking at is noise:
                    // only wrap it in one when it can say something the label cannot.
                    const tip = typeof badge.detail === 'string' ? badge.detail.trim() : '';
                    return tip === '' || tip === badge.label ? mark : h(StateTip, { tip }, mark);
                  })(),
            ),
            body,
          );
        };

        // Wide page for the fallback path: reachable when no sidebar shell owns the region.
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, FileMaidPanel));

        /**
         * Mount the card in its own React root above the sidebar's browsing region.
         *
         * Wrapping the region's occupant put the card in place but made this plugin
         * re-render another plugin's component; a session switch then produced
         * `cannot get required service "remote" in inactive context` and froze the page.
         * Instead the card owns a host element of its own, prepended to the region, and
         * reads sessions straight from the service — the region stays untouched.
         * @param {object} context - plugin context.
         * @param {Function} report - called once with whether the host landed.
         * @returns {Function} disposer.
         */
        const installCardSlot = (context, report) => {
          if (reactDom === null || typeof document === 'undefined') {
            report(false);
            return () => {};
          }
          let host;
          let root;
          let panel;
          let observer;
          let timer;
          let done = false;
          let disposed = false;
          let scheduled = false;
          const settle = (ok) => {
            if (done) return;
            done = true;
            if (timer !== undefined) {
              clearInterval(timer);
              timer = undefined;
            }
            // Stop watching once the outcome is decided: a container that appears after the
            // fallback icon registered must not open a second entry into the same data.
            if (observer !== undefined) {
              observer.disconnect();
              observer = undefined;
            }
            report(ok);
          };
          const findPanel = () => {
            const shell = document.querySelector('#dsh-st-shell-panel');
            if (shell !== null) return shell;
            const region = document.querySelector('.bhn1Oq_root');
            return region === null ? null : region.parentElement;
          };
          /**
           * Stack the card above the browsing region.
           *
           * The region carries inline `flex` values from the shell, so a sheet rule would
           * have to shout `!important` at every child; writing the three declarations on
           * the nodes we actually own keeps the override local and visible in the DOM.
           * @returns {void}
           */
          const applyPanelLayout = () => {
            if (panel === undefined) return;
            panel.style.setProperty('display', 'flex', 'important');
            panel.style.setProperty('flex-direction', 'column', 'important');
            panel.style.setProperty('min-height', '0', 'important');
            for (const child of panel.children) {
              if (child === host) {
                child.style.setProperty('display', 'block', 'important');
                child.style.setProperty('flex', '0 0 auto', 'important');
              } else {
                child.style.setProperty('flex', '1 1 auto', 'important');
                child.style.setProperty('min-height', '0', 'important');
              }
            }
          };

          const ensure = () => {
            if (disposed) return false;
            const next = findPanel();
            if (next === null) return false;
            if (host === undefined) {
              host = document.createElement('div');
              host.setAttribute('data-file-maid', 'cardslot');
              root = reactDom.createRoot(host);
              root.render(h(FileMaidCard));
            }
            if (panel !== next) {
              if (panel !== undefined) panel.removeAttribute('data-file-maid-panel');
              next.setAttribute('data-file-maid-panel', '');
              panel = next;
            }
            if (host.parentElement !== next) next.prepend(host);
            applyPanelLayout();
            settle(true);
            return true;
          };
          if (!ensure()) {
            let ticks = 0;
            timer = setInterval(() => {
              ticks += 1;
              if (ensure() || ticks >= 24) {
                clearInterval(timer);
                timer = undefined;
                if (!done) settle(false);
              }
            }, 125);
          }
          if (typeof MutationObserver === 'function' && !done) {
            observer = new MutationObserver(() => {
              // Streaming output mutates the document hundreds of times a second; coalesce
              // the lookups into one per task instead of one per mutation record.
              if (scheduled || done || disposed) return;
              scheduled = true;
              const run = () => {
                scheduled = false;
                if (!done && !disposed) ensure();
              };
              if (typeof queueMicrotask === 'function') queueMicrotask(run);
              else setTimeout(run, 0);
            });
            try {
              observer.observe(document.body, { childList: true, subtree: true });
            } catch {
              observer = undefined;
            }
          }
          return () => {
            disposed = true;
            if (timer !== undefined) {
              clearInterval(timer);
              timer = undefined;
            }
            if (observer !== undefined) {
              observer.disconnect();
              observer = undefined;
            }
            // Teardown must not report a failure: registering a slot from a context that is
            // already being destroyed throws and aborts the rest of the cleanup.
            if (root !== undefined) {
              try {
                root.unmount();
              } catch {
                /* an unmount during teardown can throw; the node is removed next */
              }
            }
            if (host !== undefined && host.parentElement !== null) host.remove();
            if (panel !== undefined) panel.removeAttribute('data-file-maid-panel');
            host = undefined;
            root = undefined;
            panel = undefined;
          };
        };

        ctx.effect(() =>
          installCardSlot(ctx, (ok) => {
            // Without the browsing region there is nowhere to hang the card, so the panel
            // icon row carries the same view instead.
            if (ok) return;
            ctx.slots.inject('sidebar.panellist', () =>
              ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 5, label: () => t('title'), locale: NS }, SidebarIcon),
            );
          }),
        );
      },
    };
  },
});
