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
      descriptorOf('scan', ['root', 'sessionId']),
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
        'label.uninitialized': '还没启用；让 AI 整理一次文件后开启。',
        'label.default': '默认落点',
        'label.scan': '最近扫描',
        'label.threshold': '阈值',
        'label.degraded': '已降级',
        'label.baseline': '基线快照',
        'label.watch': '观察中',
        'label.watchOff': '未观察',
        'col.dir': '目录',
        'col.files': '文件',
        'col.size': '体积',
        'col.about': '用途',
        'view.label': '视图',
        'view.dirs': '目录',
        'view.misplaced': '日志',
        'view.scan': '扫描',
        'k.scannedAt': '时间',
        'k.durationMs': '耗时',
        'k.files': '文件',
        'k.dirs': '目录',
        'k.degraded': '降级',
        'k.baseline': '基线',
        'k.watched': '观察',
        'k.newFiles': '新增',
        'k.recorded': '插件通道',
        'k.gap': '差额',
        'k.threshold': '阈值',
        'k.weights': '权重',
        'k.hash': '指纹',
        'k.root': '路径',
        'section.catalog': '目录表',
        'section.misplaced': '最近落点',
        'section.scan': '本次扫描',
        'section.params': '判定参数',
        'section.reconcile': '对账',
        'section.missing': '漏网文件',
        'scan.rerun': '重新扫描',
        'scan.running': '扫描中…',
        'scan.failed': '扫描没有完成，稍后再试。',
        'scan.more': '还有 {n} 个',
        'scan.ledgerIncomplete': '账本未覆盖',
        'scan.scanNow': '立即扫描',
        'scan.freshBaseline': '这是第一次扫描，已记下基线；下次扫描才能看出新增与漏网。',
        'scan.noLeak': '无漏网',
        'scan.leakCount': '漏网 {n}',
        'scan.residual': '另有 {n} 个文件未被列出（时间字段看不出是哪些）',
        'scan.ledgerNote': '账本未覆盖本次窗口，只报数量',
        'scan.recordedIncomplete': '落点日志未覆盖',
        'scan.recordedNote': '本窗口内日志轮转过，清单不可靠，只报数量',
        'scan.residualUnknown': '本窗口有覆盖缺口，差额无法计算',
        'scan.factRoot': '根',
        'k.ledger': '账本',
        'k.missing': '漏网',
        'section.baseline': '根与基线',
        'weight.keyword': '关键词',
        'weight.desc': '用途',
        'weight.prior': '先验',
        'scan.baselineSet': '有快照',
        'scan.baselineNone': '无快照',
        'scan.degraded': '已降级',
        'scan.degradedNone': '正常',
        'scan.empty': '没有扫描记录',
        'scan.emptyHint': '会话进入工作区时会在后台统计一次，几秒后这里出现结果；也可以让我重新扫描。',
        'detail.keywords': '关键词',
        'detail.noKeywords': '无',
        'detail.excludes': '排除：',
        'detail.noExcludes': '—',
        'detail.misplaced': '路由指向本目录',
        'detail.misplacedShort': '落点',
        'detail.excludesShort': '排除 {terms}',
        'detail.landed': '落点 {n}',
        'detail.purposeMore': '展开',
        'detail.purposeLess': '收起',
        'dir.row': '{path}，{files} 个文件',
        'manage.editOf': '编辑 {path}',
        'manage.deleteOf': '删除 {path}',
        'detail.default': '默认落点',
        'misplaced.empty': '没有记录',
        'misplaced.emptyHint': '最近的落点判定与依据会记在这里。',
        'misplaced.into': '落点',
        'hint.notManaged': '已退出管理，不再归类或拦截；删除 .maid/opt-out 后刷新恢复。',
        'hint.absent': '整理一次文件后会显示。',
        'hint.error': '读不到数据',
        'hint.emptyCatalog': '还没有可以归类的文件夹。',
        'hint.noTable': '还没有可用的目录表。',
        'hint.failed': '可以点「刷新」再试一次。',
        'hint.denied': '换一个能读文件的会话。',
        'hint.noRoots': '打开一个会话后显示。',
        'hint.degraded': '文件太多，只跟踪已声明的目录；区外新文件不会被发现。',
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
        'init.output': '默认落点',
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
        'setup.defaultOf': '把 {path} 设为默认落点',
        'setup.defaultHint': '点左侧圆点选默认落点；判不出来的文件会进这里。',
        'setup.needDefault': '还没有选默认落点',
        'setup.needFields': '还需要填写：{fields}',
        'setup.path': '路径',
        'setup.purpose': '用途',
        'setup.excludes': '排除',
        'setup.pathPh': '例如 80-Outputs',
        'setup.pathHint': '相对工作区根，最多 3 段。',
        'setup.purposePh': '一句话说明这个目录收什么',
        'setup.excludesPh': '一句话说明什么不该放这里（可空）',
        'setup.dup': '这个目录已经加过了',
        'setup.checkFailed': '没能检查这个路径，稍后再试。',
        'setup.count': '{n} 个目录',
        'setup.next': '下一步 · {n}',
        'setup.confirmTitle': '确认启用',
        'setup.confirmDefault': '默认落点：{path}',
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
        'more.hide': '收起',
        'refresh': '刷新',
        'readonly': '只读视图 · 不改动任何配置',
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
        'label.uninitialized': 'Not enabled yet; one tidy-up turns it on.',
        'label.default': 'default',
        'label.scan': 'last scan',
        'label.threshold': 'threshold',
        'label.degraded': 'degraded',
        'label.baseline': 'baseline',
        'label.watch': 'watching',
        'label.watchOff': 'not watching',
        'col.dir': 'dir',
        'col.files': 'files',
        'col.size': 'size',
        'col.about': 'purpose',
        'view.label': 'view',
        'view.dirs': 'Directories',
        'view.misplaced': 'Log',
        'view.scan': 'Scan',
        'k.scannedAt': 'time',
        'k.durationMs': 'duration',
        'k.files': 'files',
        'k.dirs': 'dirs',
        'k.degraded': 'degraded',
        'k.baseline': 'baseline',
        'k.watched': 'watching',
        'k.threshold': 'threshold',
        'k.weights': 'weights',
        'k.hash': 'hash',
        'k.root': 'path',
        'section.catalog': 'Catalog',
        'section.misplaced': 'Recent decisions',
        'section.scan': 'This scan',
        'section.params': 'Decision rules',
        'section.reconcile': 'Reconcile',
        'section.missing': 'Unaccounted files',
        'scan.rerun': 'Scan now',
        'scan.running': 'Scanning…',
        'scan.failed': 'The scan did not finish; try again shortly.',
        'scan.more': '{n} more',
        'scan.ledgerIncomplete': 'ledger does not cover this window',
        'scan.scanNow': 'Scan now',
        'scan.freshBaseline': 'First scan: the baseline is recorded now, so the next scan can show what is new.',
        'scan.noLeak': 'nothing unaccounted',
        'scan.leakCount': '{n} unaccounted',
        'scan.residual': '{n} more could not be named (no usable timestamp)',
        'scan.ledgerNote': 'the ledger does not cover this window; counts only',
        'scan.recordedIncomplete': 'decision log rotated',
        'scan.recordedNote': 'the log rotated inside this window, so the list is unreliable; counts only',
        'scan.residualUnknown': 'this window has a coverage gap, so the remainder cannot be computed',
        'scan.factRoot': 'root',
        'k.newFiles': 'new',
        'k.recorded': 'via plugin',
        'k.ledger': 'Ledger',
        'k.missing': 'Unaccounted',
        'section.baseline': 'Root & baseline',
        'weight.keyword': 'keyword',
        'weight.desc': 'purpose',
        'weight.prior': 'prior',
        'scan.baselineSet': 'snapshot set',
        'scan.baselineNone': 'no snapshot',
        'scan.degraded': 'degraded',
        'scan.degradedNone': 'normal',
        'scan.empty': 'no scan yet',
        'scan.emptyHint': 'A session counts this workspace in the background as it starts, so numbers appear within seconds.',
        'detail.keywords': 'keywords',
        'detail.noKeywords': 'none',
        'detail.excludes': 'Excludes:',
        'detail.noExcludes': '—',
        'detail.misplaced': 'misplaced into this dir',
        'detail.misplacedShort': 'into',
        'detail.excludesShort': 'excludes {terms}',
        'detail.landed': 'landed {n}',
        'detail.purposeMore': 'more',
        'detail.purposeLess': 'less',
        'dir.row': '{path}, {files} files',
        'manage.editOf': 'Edit {path}',
        'manage.deleteOf': 'Delete {path}',
        'detail.default': 'default dir',
        'misplaced.empty': 'none recorded',
        'misplaced.emptyHint': 'Recent placement decisions and their reasons are listed here.',
        'misplaced.into': 'into',
        'hint.notManaged': 'Opted out: no longer sorts or blocks files. Delete .maid/opt-out and refresh to resume.',
        'hint.absent': 'It appears after one tidy-up.',
        'hint.error': 'Could not read data',
        'hint.emptyCatalog': 'No folders to organise yet.',
        'hint.noTable': 'No folder table yet.',
        'hint.failed': 'Try refresh again in a moment.',
        'hint.denied': 'Switch to a session that can read files.',
        'hint.noRoots': 'Open a session to see its folder.',
        'hint.degraded': 'Too many files: only managed folders are tracked, so new files outside them go unnoticed.',
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
        'init.output': 'default dir',
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
        'setup.defaultOf': 'Make {path} the default',
        'setup.defaultHint': 'Pick the default with the dot; files that cannot be placed go here.',
        'setup.needDefault': 'No default folder chosen',
        'setup.needFields': 'Still missing: {fields}',
        'setup.path': 'path',
        'setup.purpose': 'purpose',
        'setup.excludes': 'excludes',
        'setup.pathPh': 'e.g. 80-Outputs',
        'setup.pathHint': 'Relative to the root, up to 3 segments.',
        'setup.purposePh': 'one line: what belongs here',
        'setup.excludesPh': 'one line on what does not belong; optional',
        'setup.dup': 'Already added',
        'setup.checkFailed': 'Could not check the path; try again.',
        'setup.count': '{n} folders',
        'setup.next': 'Next · {n}',
        'setup.confirmTitle': 'Confirm',
        'setup.confirmDefault': 'default: {path}',
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
        'more.hide': 'less',
        'refresh': 'refresh',
        'readonly': 'read-only view · changes nothing',
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
     * Shorten a root path to its last two segments.
     *
     * A 252px card row cannot hold `/Users/name/Desktop/Work` without wrapping, and a
     * plain tail ellipsis would keep exactly the part nobody reads (`/Users/name/…`)
     * while cutting the leaf that identifies the workspace. The leading segments are
     * replaced by `…`, the leaf keeps its full width, and the untouched path stays in
     * the row's `title`.
     * @param {string|undefined} path - absolute root path.
     * @returns {string} the shortened path, or `—` when there is none.
     */
    function shortRootPath(path) {
      if (typeof path !== 'string' || path === '') return '—';
      const parts = path.split('/').filter((part) => part !== '');
      if (parts.length <= 2) return path;
      return `…/${parts.slice(-2).join('/')}`;
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

    /**
     * Format a byte count for the catalog table.
     * @param {number} bytes - size in bytes.
     * @returns {string} a short human size.
     */
    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
      if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
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
            '[data-file-maid="page"]{display:flex;flex-direction:column;gap:10px;max-width:1080px;margin:0 auto;padding:16px 20px 20px;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-primary);height:100%;overflow:auto;box-sizing:border-box;}',
            '[data-file-maid="header"]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
            '[data-file-maid="title"]{font-size:14px;font-weight:600;}',
            '[data-file-maid="spacer"]{flex:1 1 auto;}',
            '[data-file-maid="muted"]{color:var(--dsw-alias-label-secondary);}',
            '[data-file-maid="badge"]{display:inline-flex;align-items:center;gap:5px;min-width:0;padding:0;border:0;background:none;font-size:11px;font-weight:500;letter-spacing:.2px;white-space:nowrap;color:color-mix(in srgb,var(--maid-tone,currentColor) 58%,var(--dsw-alias-label-primary));}',
            '[data-file-maid="badgelabel"]{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
            '[data-file-maid="badgedot"]{flex:0 0 auto;width:6px;height:6px;border-radius:50%;background:var(--maid-tone,currentColor);box-shadow:0 0 0 2px color-mix(in srgb,var(--maid-tone,currentColor) 18%,transparent);}',
            '[data-file-maid="mono"]{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}',
            '[data-file-maid="select"]{max-width:42ch;padding:2px 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;}',
            '[data-file-maid="select"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
            '[data-file-maid="meta"]{display:flex;flex-wrap:wrap;gap:4px 14px;align-items:center;color:var(--dsw-alias-label-secondary);}',
            '[data-file-maid="banner"]{display:flex;align-items:flex-start;gap:8px;padding:6px 10px;border-left:2px solid var(--dsw-alias-state-warn-primary);border-radius:4px;background:var(--dsw-alias-bg-layer-2);}',
            '[data-file-maid="bannertext"]{flex:1 1 auto;min-width:0;}',
            '[data-file-maid="bannerclose"]{flex:0 0 auto;margin:-1px -2px 0 0;padding:0 2px;border:0;background:none;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.1;cursor:pointer;border-radius:3px;}',
            '[data-file-maid="bannerclose"]:hover{color:var(--dsw-alias-label-primary);}',
            '[data-file-maid="bannerclose"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
            '[data-file-maid="banner"][data-tone="error"]{border-left-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);}',
            '[data-file-maid="banner"][data-tone="warn"]{border-left-color:var(--dsw-alias-state-warn-primary);}',
            '[data-file-maid="section"]{margin-top:2px;font-weight:600;}',
            '[data-file-maid="table"]{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;}',
            '[data-file-maid="th"]{padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500;text-align:left;white-space:nowrap;}',
            '[data-file-maid="th"][data-align="num"]{text-align:right;}',
            '[data-file-maid="td"]{padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:baseline;}',
            '[data-file-maid="tr"]:hover{background:var(--dsw-alias-bg-layer-1);}',
            '[data-file-maid="td"][data-align="num"]{text-align:right;white-space:nowrap;}',
            '[data-file-maid="cell"]{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:38ch;}',
            '[data-file-maid="row-toggle"]{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:0;border:0;background:none;color:inherit;font:inherit;cursor:pointer;text-align:left;}',
            '[data-file-maid="row-toggle"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:4px;}',
            '[data-file-maid="detail"]{padding:4px 8px 10px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);}',
            '[data-file-maid="chips"]{display:inline-flex;flex-wrap:wrap;gap:4px;}',
            '[data-file-maid="chip"]{padding:0 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;font-size:11px;}',
            '[data-file-maid="star"]{color:var(--dsw-alias-brand-primary);}',
            '[data-file-maid="button"]{padding:2px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;white-space:nowrap;cursor:pointer;}',
            '[data-file-maid="cardhead"] [data-file-maid="button"]{flex:0 0 auto;}',
            '[data-file-maid="button"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
            /* A misplaced record is a two-line ledger row: name and target share the
               first line, the folder it actually sits in and its age the second. Both
               right-hand cells are flush right, so ten records read as two columns
               instead of ten ragged sentences in a 252px body. */
            '[data-file-maid="list"]{margin:2px 0 0;padding:0;list-style:none;}',
            '[data-file-maid="item"]{display:flex;flex-direction:column;gap:1px;min-width:0;padding:var(--maid-row-pad) 0;border-top:1px solid var(--dsw-alias-border-l1);}',
            '[data-file-maid="item"]:first-child{border-top:0;}',
            '[data-file-maid="itemhead"]{display:flex;align-items:baseline;gap:8px;min-width:0;}',
            '[data-file-maid="itemname"]{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:var(--maid-fs-row);}',
            '[data-file-maid="itemtarget"]{flex:0 0 auto;min-width:0;max-width:48%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-brand-primary);font-size:var(--maid-fs-meta);line-height:1.4;}',
            '[data-file-maid="itemmeta"]{display:flex;align-items:baseline;gap:8px;min-width:0;color:var(--dsw-alias-label-secondary);font-size:var(--maid-fs-meta);line-height:1.4;}',
            '[data-file-maid="itemwhere"]{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}',
            '[data-file-maid="itemage"]{flex:0 0 auto;margin-left:auto;font-variant-numeric:tabular-nums;white-space:nowrap;}',
            /* The empty state is the same two lines on all three pages: what this list
               is, then one sentence about why it is empty and what fills it. Two tiers of
               type on the shared scale, no box, no icon — the shape a reader meets when
               the list is there is the shape they meet when it is not. */
            '[data-file-maid="emptystate"]{display:flex;flex-direction:column;gap:2px;padding:6px 0 8px;color:var(--dsw-alias-label-secondary);font-size:var(--maid-fs-row);line-height:1.45;}',
            '[data-file-maid="emptyhint"]{color:var(--dsw-alias-label-tertiary);font-size:var(--maid-fs-meta);line-height:1.45;}',
            /* Screen-reader-only label: the arrow is decoration, the words behind it are not. */
            '[data-file-maid="sronly"]{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;}',
            /* The wide page has room for 1080px, which would stretch one record into a
               line the eye cannot follow back to its start; keep the measure readable. */
            '[data-file-maid="page"] [data-file-maid="list"]{max-width:640px;}',
            '[data-file-maid="views"]{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:2px;height:32px;padding:2px;border-radius:var(--dsw-radius-sm,8px);box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);}',
            '[data-file-maid="initrow"]{display:flex;flex-direction:column;gap:6px;}' ,
            '[data-file-maid="init"]{display:inline-flex;align-items:center;justify-content:center;height:24px;padding:0 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;cursor:pointer;}' ,
            '[data-file-maid="init"]:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.12));}',
            '[data-file-maid="init"]:disabled{opacity:.6;cursor:default;}',
            '[data-file-maid="init"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
            '[data-file-maid="statusline"]{display:flex;flex-direction:column;gap:2px;margin:2px 0 2px;min-width:0;}',
            '[data-file-maid="sectionhead"]{display:flex;align-items:baseline;gap:5px;min-width:0;margin:0;color:var(--dsw-alias-label-secondary);font-size:var(--maid-fs-meta);font-weight:600;line-height:1.4;letter-spacing:.3px;}',
            '[data-file-maid="statusline"]>div{display:flex;align-items:center;gap:6px;min-width:0;}',
            '[data-file-maid="statusline"][data-align="center"]{align-items:center;margin-top:8px;}',
            /* One section head for all three pages: a quiet overline that names the
               list, an optional count right after it, and at most one action pushed to
               the right edge. Quiet on purpose — the rows are the answer, the head only
               says which answer. The scan page's three group heads carry the same
               measure, so a reader learns the pattern once. */
            '[data-file-maid="sectionhead"] [data-file-maid="linkbutton"]{font-size:var(--maid-fs-meta);line-height:1.4;padding:0 1px;}',
            '[data-file-maid="edithead"]{display:flex;align-items:center;gap:6px;margin:0 0 4px;min-width:0;}',
            '[data-file-maid="editlevel"]{display:flex;flex-direction:column;gap:4px;margin:0 0 4px;}',
            '[data-file-maid="divider"]{height:1px;margin:2px 0;background:var(--dsw-alias-border-l1);}',
            '[data-file-maid="editrow"]{display:flex;flex-direction:column;gap:2px;min-width:0;border-bottom:1px solid var(--dsw-alias-border-l1);}',
            '[data-file-maid="editline"]{display:flex;align-items:center;gap:6px;min-width:0;padding:2px 0;}',
            '[data-file-maid="editactions"]{display:flex;align-items:center;gap:10px;padding:0 0 4px 14px;}',
            '[data-file-maid="managebox"]{display:flex;flex-direction:column;gap:6px;margin:0 0 10px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);}',
            '[data-file-maid="managerow"]{display:flex;align-items:center;gap:8px;min-width:0;}',
            '[data-file-maid="input"]{flex:1 1 auto;min-width:0;height:24px;padding:0 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:4px;background:var(--dsw-alias-bg-base);color:inherit;font:inherit;font-size:var(--maid-fs-row);}',
            '[data-file-maid="manageactions"]{display:flex;align-items:center;gap:10px;margin-top:4px;}',
            '[data-file-maid="required"]{color:var(--dsw-alias-brand-primary);}',
            '[data-file-maid="input"][data-invalid="true"]{border-color:var(--dsw-alias-border-l2,currentColor);}',
            '[data-file-maid="managehint"]{color:var(--dsw-alias-label-tertiary);font-size:var(--maid-fs-meta);}',
            '[data-file-maid="manageerror"]{color:var(--dsw-alias-label-primary);font-size:var(--maid-fs-meta);border-left:2px solid var(--dsw-alias-state-error-primary);padding-left:6px;}',
            '[data-file-maid="defaulttag"]{flex:0 0 auto;color:var(--dsw-alias-brand-primary);font-size:var(--maid-fs-meta);line-height:14px;white-space:nowrap;}',
            '[data-file-maid="editrow"][data-state="removed"] [data-file-maid="mono"]{opacity:.6;}',
            '[data-file-maid="editrow"][data-state="updated"] [data-file-maid="edithint"]{color:var(--dsw-alias-brand-primary);}',
            '[data-file-maid="editrow"][data-state="added"] [data-file-maid="mono"]{color:var(--dsw-alias-brand-primary);}',
            '[data-file-maid="initbox"]{display:flex;flex-direction:column;gap:6px;margin:2px 0 6px;}',
            '[data-file-maid="initrow"]{display:flex;flex-direction:row;flex-wrap:wrap;align-items:center;gap:6px;}',
            '[data-file-maid="draftrow"]{display:flex;align-items:center;gap:6px;min-width:0;padding:2px 0;border-bottom:1px solid var(--dsw-alias-border-l1);}',
            '[data-file-maid="draftrow"]>[data-file-maid="mono"]{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;}',
            '[data-file-maid="linkbutton"]{flex:0 0 auto;padding:0 3px;border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:16px;white-space:nowrap;cursor:pointer;border-radius:4px;}',
            '[data-file-maid="linkbutton"]:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);}',
            '[data-file-maid="linkbutton"]:disabled{opacity:.5;cursor:default;}',
            '[data-file-maid="linkbutton"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
            '[data-file-maid="select"]{min-width:0;max-width:100%;height:22px;padding:0 4px;border:1px solid var(--dsw-alias-border-l2);border-radius:5px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;font-size:11px;}',
            '[data-file-maid="input"]{min-width:0;flex:1 1 80px;height:22px;padding:0 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:5px;background:transparent;color:inherit;font:inherit;font-size:11px;}',
            '[data-file-maid="textarea"]{width:100%;min-height:52px;padding:4px 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:5px;background:transparent;color:inherit;font:inherit;font-size:11px;resize:vertical;}',
            '[data-file-maid="edithint"]{color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:1.45;}',
            '[data-file-maid="viewslot"][data-disabled="true"]{opacity:.55;}',
            '[data-file-maid="viewslot"][data-disabled="true"] [role="tab"],[data-file-maid="viewslot"][data-disabled="true"] button{pointer-events:none;cursor:default;}',
            /* Same geometry as the sidebar row: icon + label, one compact track. */
            /* The sidebar card: one header row, then the panel body when open. */
            '[data-file-maid="card"]{--maid-row:32px;display:flex;flex-direction:column;min-width:0;flex:0 0 auto;margin:0 0 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1);overflow:hidden;}',
            '[data-file-maid="card"][data-open="false"]{height:var(--maid-row);box-sizing:border-box;}',
            '[data-file-maid="cardhead"]{display:flex;align-items:center;gap:5px;width:100%;height:100%;min-height:30px;padding:0 6px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;}',
            '[data-file-maid="cardhead"]:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
            '[data-file-maid="card"][data-open="true"] [data-file-maid="cardhead"]{color:var(--dsw-alias-label-primary);font-weight:600;}',
            '[data-file-maid="cardtoggle"]{display:flex;align-items:center;gap:5px;min-width:0;flex:1 1 auto;height:100%;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer;}',
            '[data-file-maid="cardtoggle"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;border-radius:4px;}',
            '[data-file-maid="chevron"]{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;}',
            '[data-file-maid="cardtitle"]{flex:0 0 auto;white-space:nowrap;}',
            '[data-file-maid="cardsuffix"]{flex:0 8 auto;min-width:0;max-width:76px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-weight:500;}',
            '[data-file-maid="cardhead"] [data-file-maid="badge"]{flex:0 1 auto;min-width:0;margin-left:5px;padding:0 5px;font-size:10px;line-height:15px;}',
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
            '[data-file-maid-panel]{display:flex !important;flex-direction:column !important;min-height:0;}',
            /* The host keeps the region's inline inset on the right so the card lines up
               with the segmented row above it instead of running to the column edge. */
            '[data-file-maid-panel]>[data-file-maid="cardslot"]{display:block;flex:0 0 auto !important;min-width:0;box-sizing:border-box;padding:0 var(--dsh-sidebar-inline-padding,12px) 6px 0;}',
            '[data-file-maid-panel]>*:not([data-file-maid="cardslot"]){flex:1 1 auto !important;min-width:0;min-height:0;}',
            '[data-file-maid="card"]{width:100%;box-sizing:border-box;flex:0 0 auto;}',
            // Border-box for every element this plugin owns inside the card: a 100%-wide
            // row with horizontal padding would otherwise overflow into the card's
            // `overflow:hidden` and lose its right padding (the refresh button ended up
            // flush against the card edge).
            '[data-file-maid="card"],[data-file-maid="card"] [data-file-maid]{box-sizing:border-box;}',
                        /* Compact scale inside the card: the sidebar column is 264px wide and the
               region above and below it is dense, so every row is tightened here. */
            '[data-file-maid="card"] [data-file-maid="tabpage"]{gap:8px;padding:0 0 2px;font-size:11.5px;line-height:1.45;}',
            '[data-file-maid="card"] [data-file-maid="header"]{gap:6px;}',
            '[data-file-maid="card"] [data-file-maid="meta"]{gap:2px 8px;font-size:11px;line-height:1.45;}',
            '[data-file-maid="card"] [data-file-maid="banner"]{padding:4px 8px;font-size:11px;line-height:1.4;}',
            '[data-file-maid="card"] [data-file-maid="section"]{margin:0;font-size:11px;}',
            '[data-file-maid="card"] [data-file-maid="muted"]{font-size:11px;}',
            '[data-file-maid="card"] [data-file-maid="badge"]{font-size:10.5px;line-height:16px;}',
            /* State badges carry colour: a reader should see "not initialised" without
               reading the words, and hover tells why. */
            /* The badge inherits the header's own cursor; a help cursor promised a native
               tooltip that this host never draws. */
            '[data-file-maid="badge"]{cursor:inherit;}',
            '[data-file-maid="statetip"]{display:inline-flex;align-items:center;flex:0 0 auto;min-width:0;outline:none;border-radius:4px;}',
            '[data-file-maid="statetip"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}',
            '[data-file-maid="statetipbox"]{z-index:9999;box-sizing:border-box;padding:5px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-3));box-shadow:var(--dsw-elevation-prominent,0 8px 20px rgba(0,0,0,.34));color:var(--dsw-alias-label-primary);font-size:11px;line-height:1.45;white-space:normal;pointer-events:none;}',
            '[data-file-maid="badge"][data-tone="ok"]{--maid-tone:var(--dsw-alias-state-success-primary,#22c55e);}',
            '[data-file-maid="badge"][data-tone="warn"]{--maid-tone:var(--dsw-alias-state-warn-primary,#f59e0b);}',
            '[data-file-maid="badge"][data-tone="error"]{--maid-tone:var(--dsw-alias-state-error-primary,#ef4444);}',
            '[data-file-maid="badge"][data-tone="muted"]{--maid-tone:var(--dsw-alias-label-secondary);}',
            '[data-file-maid="card"] [data-file-maid="select"]{padding:2px 6px;font-size:11.5px;line-height:18px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);border-color:transparent;}',
            '[data-file-maid="card"] [data-file-maid="button"]{padding:1px 7px;font-size:11px;line-height:16px;}',
            '[data-file-maid="rootline"]{display:flex;align-items:baseline;gap:6px;min-width:0;max-width:100%;}',
            '[data-file-maid="rootlabel"]{flex:0 0 auto;color:var(--dsw-alias-label-secondary);font-size:10.5px;letter-spacing:.2px;}',
            '[data-file-maid="rootvalue"]{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;font-weight:500;color:var(--dsw-alias-label-primary);opacity:.86;}',
            '[data-file-maid="card"] [data-file-maid="pickerglyph"]+[data-file-maid="select"]{flex:1 1 auto;min-width:0;}',
            '[data-file-maid="card"] [data-file-maid="tabdetail"]{padding:0 2px 5px 18px;}',
'[data-file-maid="card"] .file-maid-views{max-width:none;--segmented-tabs-inset:2px;}',
            /* Mid-scale: the shipped control draws 34px tabs at 14px text, which reads
               oversized in a 264px card; 22px/11px was cramped. Scale the tab, the text and
               the glyph together so the slider and the label keep one metric. */
            '[data-file-maid="card"] .file-maid-views [role="tab"]{height:28px;font-size:12px;line-height:1;padding:0 4px;}',
            '[data-file-maid="card"] .file-maid-views [data-file-maid="viewlabel"] svg{width:12px;height:12px;}',
            '[data-file-maid="card"] .file-maid-views [role="tab"]{flex:1 1 0;min-width:0;padding:0 2px;}',
            '[data-file-maid="views"]>[data-file-maid="view"]{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:0;padding:0 8px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;line-height:1;border-radius:calc(var(--dsw-radius-sm,8px) - 2px);cursor:pointer;}',
            '[data-file-maid="views"]>[data-file-maid="view"][aria-selected="true"]{color:var(--dsw-alias-label-primary);font-weight:600;background:var(--dsw-alias-bg-layer-2);box-shadow:0 1px 2px rgba(0,0,0,.12);}',
            /* The label carries a 22px line box from the tab pill; CJK glyphs sit low in it,
               so the icon and the word disagree by a pixel. Collapse the line box and let
               flex centring align the two boxes instead. */
            '[data-file-maid="viewlabel"]{display:inline-flex;align-items:center;gap:6px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1;}',
            '[data-file-maid="viewlabel"]>span{display:inline-flex;align-items:center;line-height:1;}',
            '[data-file-maid="viewlabel"]>svg{display:block;flex:0 0 auto;}',
            '.file-maid-views{max-width:360px;}',
            '[data-file-maid="view"]{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:28px;padding:0 10px;border:0;border-radius:6px;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap;}',
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
            '[data-file-maid="scangroup"]>[data-file-maid="sectionhead"]{margin:0;color:var(--dsw-alias-label-secondary);font-size:10.5px;font-weight:600;line-height:1.4;letter-spacing:.3px;}',
            '[data-file-maid="scanstat"]{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0 8px;}',
            '[data-file-maid="scancell"]{display:flex;flex-direction:column;min-width:0;}',
            '[data-file-maid="scancell"]>[data-file-maid="scanval"]{flex:0 0 auto;margin-left:0;text-align:left;font-size:13px;font-weight:600;line-height:1.25;}',
            '[data-file-maid="scanlabel"]{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:var(--maid-fs-meta);line-height:1.4;}',
            '[data-file-maid="scangroup"]>[data-file-maid="sectionhead"]{display:flex;align-items:center;justify-content:space-between;gap:8px;}',
            '[data-file-maid="scanact"]{appearance:none;border:0;background:transparent;padding:2px 4px;border-radius:4px;font:inherit;font-size:11px;line-height:16px;color:var(--dsw-alias-brand-primary,inherit);cursor:pointer;}',
            '[data-file-maid="scanact"]:hover{background:var(--dsw-alias-interactive-bg-hover,transparent);}',
            '[data-file-maid="scanact"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,currentColor);outline-offset:1px;}',
            '[data-file-maid="scanact"][aria-busy="true"]{opacity:.55;cursor:progress;}',
            '[data-file-maid="scanstatus"]{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-top:4px;font-size:10.5px;color:var(--dsw-alias-label-secondary);}',
            '[data-file-maid="scanverdict"][data-tone="warn"]{color:var(--dsw-alias-state-warn-primary);}',
            '[data-file-maid="scanaside"][data-tone="warn"]{color:var(--dsw-alias-state-warn-primary);}',
            '[data-file-maid="scannote"]{margin-top:4px;font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-secondary);}',
            '[data-file-maid="scanfacts"]{margin-top:8px;padding-top:4px;border-top:1px solid var(--dsw-alias-border-l1);font-size:10.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-secondary);}',
            '[data-file-maid="scanrows"]{display:flex;flex-direction:column;margin-top:var(--maid-gap-head);min-width:0;}',
            '[data-file-maid="scanrow"]{display:flex;align-items:baseline;gap:var(--maid-gap-kv);min-width:0;padding:var(--maid-row-pad) 0;border-top:1px solid var(--dsw-alias-border-l1);}',
            '[data-file-maid="scanrows"]>[data-file-maid="scanrow"]:first-child{border-top:0;padding-top:0;}',
            '[data-file-maid="scankey"]{flex:0 0 auto;color:var(--dsw-alias-label-secondary);font-size:var(--maid-fs-meta);line-height:1.45;white-space:nowrap;}',
            '[data-file-maid="scanval"]{flex:1 1 auto;min-width:0;margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;font-size:var(--maid-fs-row);line-height:1.45;font-variant-numeric:tabular-nums;}',
            '[data-file-maid="scanval"][data-tone="warn"]{color:var(--dsw-alias-state-warn-primary);}',
            '[data-file-maid="scanpath"]{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:var(--maid-fs-meta);color:var(--dsw-alias-label-primary);opacity:.86;}',
            '[data-file-maid="scanhash"]{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:var(--maid-fs-meta);color:var(--dsw-alias-label-secondary);}',
            /* The wide page has 1080px; three figures would stretch into a billboard. */
            '[data-file-maid="page"] [data-file-maid="scanlayout"]{max-width:340px;}',
            '[data-file-maid="tabpage"]{display:flex;flex-direction:column;gap:8px;padding:2px 2px 10px;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-primary);box-sizing:border-box;}',
            /* The three pages are one list language, so its measures are stated once and
               read by every page: a row's breathing room and rule, the two text tiers a
               record is allowed to use, the gap between a section head and its rows, and
               the gap between two key/value halves of one row. Both roots declare them,
               so the card and the wide page cannot drift apart one rule at a time. */
            '[data-file-maid="tabpage"],[data-file-maid="page"]{--maid-fs-row:11.5px;--maid-fs-meta:10.5px;--maid-row-pad:3px;--maid-gap-kv:8px;--maid-gap-section:7px;--maid-gap-head:2px;}',
            '[data-file-maid="viewbody"]{display:flex;flex-direction:column;gap:var(--maid-gap-section);min-width:0;}',
            '[data-file-maid="hint"]{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.45;}',
            '[data-file-maid="hint"][data-tone="error"]{color:var(--dsw-alias-state-error-primary,#ef4444);}',
            '[data-file-maid="tablist"]{display:flex;flex-direction:column;}',
            '[data-file-maid="setuplayer"]{display:flex;flex-direction:column;gap:8px;padding:2px 0 2px;}',
            '[data-file-maid="setuphead"]{display:flex;align-items:center;gap:6px;min-width:0;}',
            '[data-file-maid="setupback"]{flex:none;padding:2px 4px;border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--maid-fs-row);line-height:1.4;cursor:pointer;border-radius:4px;}',
            '[data-file-maid="setupback"]:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);}',
            '[data-file-maid="setuptitle"]{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-primary);font-size:var(--maid-fs-row);font-weight:600;line-height:1.35;}',
            '[data-file-maid="setupcount"]{flex:none;color:var(--dsw-alias-label-secondary);font-size:var(--maid-fs-meta);font-variant-numeric:tabular-nums;}',
            '[data-file-maid="setuplead"]{color:var(--dsw-alias-label-primary);font-size:var(--maid-fs-row);line-height:1.45;}',
            '[data-file-maid="setupnote"]{color:var(--dsw-alias-label-secondary);font-size:var(--maid-fs-meta);line-height:1.45;}',
            '[data-file-maid="setupcta"]{flex:1 1 auto;min-height:28px;padding:0 10px;border:0;border-radius:6px;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-1);font:inherit;font-size:11px;line-height:1.3;cursor:pointer;}',
            '[data-file-maid="setupcta"]:disabled{opacity:.5;cursor:default;}',
            '[data-file-maid="setupcta"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}',
            '[data-file-maid="setupsecondary"]{flex:none;min-height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer;}',
            '[data-file-maid="setupsecondary"]:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);}',
            '[data-file-maid="setupsecondary"]:disabled{opacity:.5;cursor:default;}',
            '[data-file-maid="setupactions"]{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:4px;}',
            '[data-file-maid="setuplist"]{display:flex;flex-direction:column;min-width:0;}',
            '[data-file-maid="setuprow"]{display:flex;align-items:center;gap:6px;min-height:34px;border-top:1px solid var(--dsw-alias-border-l1);}',
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
            '[data-file-maid="rowacts"]{display:flex;align-items:center;gap:6px;flex:0 0 auto;}',
            '[data-file-maid="rowact"]{flex:0 0 auto;height:20px;padding:0 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:18px;cursor:pointer;white-space:nowrap;}',
            '[data-file-maid="rowact"]:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);}',
            '[data-file-maid="rowact"][data-tone="danger"]:hover,[data-file-maid="rowact"][data-tone="danger"]:focus-visible{color:var(--dsw-alias-state-error-primary,#e5484d);}',
            '[data-file-maid="rowact"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
            '[data-file-maid="purposetext"]{font-size:var(--maid-fs-row);line-height:1.5;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;}',
            '[data-file-maid="purposetext"][data-clipped="true"]{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;}',
            '[data-file-maid="purposemore"]{align-self:flex-start;padding:0 2px;border:0;background:none;color:var(--dsw-alias-brand-primary);font:inherit;font-size:var(--maid-fs-meta);line-height:1.4;cursor:pointer;border-radius:4px;}',
            '[data-file-maid="purposemore"]:hover{background:var(--dsw-alias-interactive-bg-hover);}',
            '[data-file-maid="purposemore"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
            '[data-file-maid="metastrip"]{display:flex;align-items:center;gap:10px;min-width:0;}',
            '[data-file-maid="metaitem"]{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
            '[data-file-maid="rowflag"]{flex:0 0 auto;color:var(--dsw-alias-state-warn-primary);}',
            '[data-file-maid="ghostbutton"]{flex:0 0 auto;height:22px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;line-height:20px;cursor:pointer;white-space:nowrap;}',
            '[data-file-maid="ghostbutton"]:hover{background:var(--dsw-alias-interactive-bg-hover);}',
            '[data-file-maid="ghostbutton"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
            '[data-file-maid="morebar"]{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;margin-top:4px;padding:4px 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--maid-fs-meta);cursor:pointer;}',
            '[data-file-maid="morebar"]:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);}',
            '[data-file-maid="morebar"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
            '[data-file-maid="tabtoggle"]:hover{background:var(--dsw-alias-bg-layer-1);}',
            '[data-file-maid="tabcount"]{margin-left:auto;flex:none;color:var(--dsw-alias-label-primary);font-size:var(--maid-fs-row);font-variant-numeric:tabular-nums;white-space:nowrap;}',
            '[data-file-maid="tabdetail"]{display:flex;flex-direction:column;gap:3px;padding:0 2px 6px 14px;color:var(--dsw-alias-label-secondary);font-size:var(--maid-fs-meta);line-height:1.45;}',
            '[data-file-maid="tabroot"]{display:flex;align-items:center;gap:6px;min-width:0;}',
            '[data-file-maid="tabroot"] [data-file-maid="select"]{flex:1 1 auto;min-width:0;max-width:none;}',
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
          const [scanNotice, setScanNotice] = React.useState('');
          const [state, setState] = React.useState({ phase: 'loading', status: undefined, message: '', forReader: '' });
          const [openDir, setOpenDir] = React.useState('');
          /** The directory form: `undefined` when closed, otherwise the row being edited. */
          const [manage, setManage] = React.useState(undefined);
          const [manageBusy, setManageBusy] = React.useState(false);
          const [manageError, setManageError] = React.useState('');
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
          const tone =
            catalogState === 'MANAGED'
              ? status?.scan?.degraded === true
                ? 'warn'
                : 'ok'
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
                        : degraded
                          ? t('hint.degraded')
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
          const [clippedDir, setClippedDir] = React.useState('');

          /** The setup layer: undefined while browsing, an object while setting up. */
          const [setup, setSetup] = React.useState(undefined);
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
          if (status?.scan !== undefined) metaParts.push({ text: status.scan.watched === true ? t('label.watch') : t('label.watchOff') });
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
                { key: 'degraded', 'data-file-maid': 'banner', 'data-tone': 'warn', title: degradedTitle },
                h('span', { 'data-file-maid': 'bannertext' }, t('hint.degraded')),
                h(
                  'button',
                  {
                    type: 'button',
                    'data-file-maid': 'bannerclose',
                    'aria-label': t('action.dismiss'),
                    title: t('action.dismiss'),
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
          const emptyState = (title, hint) =>
            h(
              'div',
              { 'data-file-maid': 'emptystate' },
              h('div', null, title),
              h('div', { 'data-file-maid': 'emptyhint' }, hint),
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
              h('th', { 'data-file-maid': 'th', scope: 'col', 'data-align': 'num' }, t('col.size')),
              h('th', { 'data-file-maid': 'th', scope: 'col' }, t('col.about')),
            ),
          );

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
                      onClick: () => {
                      setOpenDir(isOpen ? '' : dir.path);
                      if (isOpen) setPurposeOpen('');
                    },
                    },
                    h('span', { 'aria-hidden': 'true' }, isOpen ? '▾' : '▸'),
                    h('span', { 'data-file-maid': 'cell', title: dir.path }, dir.path),
                    dir.path === catalog?.rootDefault ? h('span', { 'data-file-maid': 'star', title: t('detail.default') }, '★') : null,
                  ),
                ),
                h('td', { 'data-file-maid': 'td', 'data-align': 'num' }, fileCount(dir.files)),
                h('td', { 'data-file-maid': 'td', 'data-align': 'num', title: `${dir.bytes ?? 0} B` }, formatBytes(dir.bytes)),
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
                  { key: `detail-${dir.path}`, 'data-file-maid': 'tr' },
                  h(
                    'td',
                    { 'data-file-maid': 'detail', colSpan: 5 },
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
                        { type: 'button', 'data-file-maid': 'linkbutton', onClick: () => openManage('edit', dir) },
                        t('manage.edit'),
                      ),
                      h(
                        'button',
                        { type: 'button', 'data-file-maid': 'linkbutton', onClick: () => openManage('remove', dir) },
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
            const meta = [];
            if (excludes !== '') meta.push(h('span', { key: 'ex', 'data-file-maid': 'metaitem' }, fill(t('detail.excludesShort'), { terms: excludes })));
            if (into.length > 0) {
              meta.push(
                h(
                  'span',
                  { key: 'landed', 'data-file-maid': 'rowflag', 'data-tone': 'warn' },
                  fill(t('detail.landed'), { n: into.length }),
                ),
              );
            }
            return h(
              'div',
              {
                key: `tab-${dir.path}`,
                'data-file-maid': 'tabrow',
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
                    'aria-label': `${fill(t('dir.row'), { path: dir.path, files: fileCount(dir.files) })}${
                      dir.path === catalog?.rootDefault ? `，${t('detail.default')}` : ''
                    }`,
                    onClick: () => setOpenDir(isOpen ? '' : dir.path),
                  },
                  h('span', { 'aria-hidden': 'true' }, isOpen ? '▾' : '▸'),
                  h('span', { 'data-file-maid': 'rowpath' }, dir.path),
                  dir.path === catalog?.rootDefault
                    ? h('span', { 'data-file-maid': 'defaulttag', 'aria-hidden': 'true' }, '★')
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
                    { 'data-file-maid': 'tabdetail' },
                    h(
                      'div',
                      { 'data-file-maid': 'purposetext', 'data-clipped': expanded ? 'false' : 'true' },
                      purpose === '' ? '—' : purpose,
                    ),
                    clippedDir === dir.path && !expanded
                      ? h(
                          'button',
                          {
                            type: 'button',
                            'data-file-maid': 'purposemore',
                            'aria-expanded': 'false',
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
                            onClick: () => setPurposeOpen(''),
                          },
                          t('detail.purposeLess'),
                        )
                      : null,
                    meta.length === 0 ? null : h('div', { 'data-file-maid': 'metastrip' }, ...meta),
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
          const misplacedRow = (item, index) => {
            const path = typeof item.path === 'string' ? item.path : '';
            const cut = path.lastIndexOf('/');
            const name = cut >= 0 ? path.slice(cut + 1) : path;
            const folder = cut >= 0 ? path.slice(0, cut) : '';
            const age = formatAge(item.at, t, now);
            return h(
              'li',
              { key: `m-${index}-${path}`, 'data-file-maid': 'item' },
              h(
                'div',
                { 'data-file-maid': 'itemhead' },
                h('span', { 'data-file-maid': 'itemname', title: path === '' ? undefined : path }, name === '' ? '—' : name),
                h(
                  'span',
                  { 'data-file-maid': 'itemtarget', title: item.suggested ?? undefined },
                  h('span', { 'data-file-maid': 'sronly' }, `${t('misplaced.into')} `),
                  h('span', { 'aria-hidden': 'true' }, '→ '),
                  item.suggested ?? '—',
                ),
              ),
              h(
                'div',
                { 'data-file-maid': 'itemmeta' },
                folder === '' ? null : h('span', { 'data-file-maid': 'itemwhere', title: folder }, folder),
                age === '' ? null : h('span', { 'data-file-maid': 'itemage' }, age),
              ),
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
              { key, 'data-file-maid': 'scangroup', role: 'group', 'aria-label': title },
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
          const scanAction = h(
            'button',
            {
              type: 'button',
              'data-file-maid': 'scanact',
              'data-tone': 'brand',
              'aria-busy': scanBusy ? 'true' : 'false',
              onClick: () => {
                if (!scanBusy) void runScan();
              },
            },
            scanBusy ? t('scan.running') : t('scan.rerun'),
          );

          /** Time, age and the one state word, on one line: they answer the same question. */
          const scanStatus = h(
            'div',
            { 'data-file-maid': 'scanstatus', 'aria-live': 'polite' },
            h(
              'span',
              { 'data-file-maid': 'scanage' },
              `${scannedAt === '' ? '—' : `${formatClock(scannedAt, now)} · ${formatAge(scannedAt, t, now)}`}${scan?.watched === true ? '' : ` · ${t('label.watchOff')}`}`,
            ),
            h(
              'span',
              { 'data-file-maid': 'scanverdict', 'data-tone': scan?.degraded === true ? 'warn' : undefined },
              scan?.degraded === true ? t('scan.degraded') : t('scan.degradedNone'),
            ),
          );

          /** A grey line under the figures: explains a gap the numbers alone cannot. */
          const scanNote = (key, text) => h('div', { key, 'data-file-maid': 'scannote' }, text);

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

          const missingRows = Array.isArray(reconcile?.missing) ? reconcile.missing.slice(0, 10) : [];
          const missingBody = missingRows.map((item) =>
            h('div', { key: `missing-${item.path}`, 'data-file-maid': 'scanrow' }, h('span', { 'data-file-maid': 'scanval' }, item.path)),
          );
          if (missingRows.length > 0 && reconcile.missing.length > missingRows.length) {
            missingBody.push(
              h(
                'div',
                { key: 'missing-more', 'data-file-maid': 'scanrow' },
                h('span', { 'data-file-maid': 'scanval' }, fill(t('scan.more'), { n: reconcile.missing.length - missingRows.length })),
              ),
            );
          }

          const reconcileBody = baselineOnly
            ? scanNote('fresh', t('scan.freshBaseline'))
            : h(
                React.Fragment,
                null,
                h(
                  'div',
                  { 'data-file-maid': 'scanstat' },
                  scanStat('newFiles', Number.isFinite(reconcile.new_files) ? String(reconcile.new_files) : '—', t('k.newFiles')),
                  scanStat('recorded', Number.isFinite(reconcile.recorded) ? String(reconcile.recorded) : '—', t('k.recorded')),
                  scanStat('ledger', Number.isFinite(reconcile.ledger) ? String(reconcile.ledger) : '—', t('k.ledger')),
                ),
                coverageLost
                  ? scanNote('ledgernote', decisionsGap ? t('scan.recordedNote') : t('scan.ledgerNote'))
                  : null,
                reconcile.residual === null && reconcile.baseline !== true
                  ? scanNote('residual', t('scan.residualUnknown'))
                  : !coverageLost && Number.isFinite(reconcile.residual) && reconcile.residual > 0
                  ? scanNote('residual', fill(t('scan.residual'), { n: reconcile.residual }))
                  : null,
                coverageLost || missingBody.length === 0
                  ? null
                  : h('div', { 'data-file-maid': 'scanrows' }, ...missingBody),
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
              ),
              scanAction,
            ),
            scanGroup('reconcile', t('section.reconcile'), reconcileBody, reconcileAside),
            h(
              'div',
              { 'data-file-maid': 'scanfacts' },
              h('span', { 'data-file-maid': 'scanfactsroot' }, `${t('scan.factRoot')} ${shortRootPath(root)}`),
            ),
          );
          const scanBody = scan === undefined
            ? h(
                'div',
                { 'data-file-maid': 'emptystate' },
                h('div', null, t('scan.empty')),
                h('div', { 'data-file-maid': 'emptyhint' }, t('scan.emptyHint')),
                h(
                  'button',
                  { type: 'button', 'data-file-maid': 'scanact', 'data-tone': 'brand', onClick: () => void runScan() },
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

          /** The question form, the draft it is editing, and the preview being confirmed. */
          const [form, setForm] = React.useState({ phase: 'idle', doc: undefined, error: '', code: '' });
          /** Whether anything actually asked for the form. The browse layer never does. */
          const [formWanted, setFormWanted] = React.useState(false);
          /** Identifies the newest `form` request so a stale reply cannot land. */
          const formRun = React.useRef(0);
          const [draft, setDraft] = React.useState(undefined);
          const [preview, setPreview] = React.useState(undefined);
          const [busy, setBusy] = React.useState(false);
          const [notice, setNotice] = React.useState('');
          const [newDir, setNewDir] = React.useState({ path: '', role: 'autonomous', purpose: '' });
          const [editMode, setEditMode] = React.useState('none');
          const [showAllDirs, setShowAllDirs] = React.useState(false);
          const [confirmDiscard, setConfirmDiscard] = React.useState(false);
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
            const result = await callRemote('scan', root, readerId);
            setScanBusy(false);
            setScanNotice(result?.ok === true ? '' : describeError(result, t('scan.failed')));
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

          React.useEffect(() => {
            // Nothing on the browse layer needs the form: the ledger comes from the
            // projection. Asking for it on mount bought nothing and lost something —
            // the Host answers `E_MAID_NO_ROOT` for any root with no live Agent, which
            // the card then rendered as a red line above tabs the operator never asked
            // about. The fetch now waits for whoever actually wants the form.
            if (formWanted !== true || form.phase !== 'idle') return undefined;
            if (!canRead || readerId === '' || typeof root !== 'string' || root === '') return undefined;
            // The request is guarded by a run counter, never by the effect's own cleanup:
            // putting `form.phase` in the deps means flipping it to `loading` re-runs this
            // effect, and a cleanup-driven `live = false` would then throw away the very
            // reply that flip was waiting for — the card sat on 「正在读取…」 forever.
            const run = (formRun.current += 1);
            setForm({ phase: 'loading', doc: undefined, error: '', code: '' });
            callRemote('form', root, readerId).then(
              (result) => {
                if (formRun.current !== run) return;
                if (result?.ok === true) {
                  setForm({ phase: 'ready', doc: result.value, error: '', code: '' });
                  return;
                }
                const failure = result?.errors?.[0];
                setForm({ phase: 'failed', doc: undefined, error: failure?.message ?? '', code: failure?.code ?? '' });
              },
              // A transport-level throw used to leave the card in `loading` for good.
              (error) => {
                if (formRun.current !== run) return;
                setForm({ phase: 'failed', doc: undefined, error: String(error?.message ?? error), code: String(error?.code ?? '') });
              },
            );
          }, [formWanted, form.phase, canRead, readerId, root, revision]);

          React.useEffect(() => {
            // A different root or Session invalidates the document *and* the layer it was
            // opened for: staying in the editor would silently retarget the next write.
            setForm({ phase: 'idle', doc: undefined, error: '', code: '' });
            setFormWanted(false);
            setEditMode('none');
            setPreview(undefined);
          }, [root, readerId]);

          React.useEffect(() => {
            // A same-root refresh keeps the request intent, so retrying costs one click
            // and not two: the fetch effect runs again once this lands back on idle.
            setForm({ phase: 'idle', doc: undefined, error: '', code: '' });
          }, [revision]);

          React.useEffect(() => {
            if (form.phase === 'ready' && form.doc !== undefined) {
              setDraft(initialDraft(form.doc));
              setPreview(undefined);
              setNotice('');
              // The edit layer is what asked for this document, so arriving must not
              // bounce the operator back to browse.
              setConfirmDiscard(false);
              setShowAllDirs(false);
              setOpenRow('');
            }
          }, [form.phase, form.doc?.root, form.doc?.mode, revision]);

          /**
           * Turn the draft into the wire payload the current mode expects.
           * @param {object} doc - form payload.
           * @param {object} current - draft.
           * @returns {object} the payload.
           */
          const draftPayload = (doc, current) => {
            if (doc.mode === 'initialized') return { output: current.output, ops: current.ops };
            return {
              template: current.template,
              create: current.create === true,
              output: current.output,
              candidates: Object.entries(current.candidates)
                .filter(([, action]) => action !== 'skip')
                .map(([path, action]) => ({ path, action: 'register', role: action === 'register-managed' ? 'managed' : 'autonomous' })),
              custom: current.custom
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line.length > 0),
            };
          };

          /**
           * Validate the draft and mint a credential.
           * @param {string} kind - init, edit or optout.
           * @returns {Promise<void>} fulfillment after the preview state landed.
           */
          const runPreview = async (kind) => {
            if (form.doc === undefined || draft === undefined || busy) return;
            setBusy(true);
            setNotice('');
            try {
              const result = await callRemote('preview', root, readerId, kind, JSON.stringify(draftPayload(form.doc, draft)));
              if (result?.ok === true) setPreview({ kind, doc: result.value });
              else setNotice(result?.errors?.[0]?.message ?? t('init.failed'));
            } catch (error) {
              setNotice(error?.message ?? t('init.failed'));
            } finally {
              setBusy(false);
            }
          };

          /** Confirm the previewed change. */
          const runApply = async () => {
            if (preview === undefined || busy) return;
            setBusy(true);
            setNotice('');
            try {
              const result = await callRemote('apply', root, readerId, preview.doc.interviewId);
              if (result?.ok === true) {
                // The document just became stale and the layer it belonged to is done.
                setPreview(undefined);
                setNotice(t('init.done'));
                setEditMode('none');
                setFormWanted(false);
                setRevision((value) => value + 1);
              } else {
                setNotice(result?.errors?.[0]?.message ?? t('init.failed'));
              }
            } catch (error) {
              setNotice(error?.message ?? t('init.failed'));
            } finally {
              setBusy(false);
            }
          };

          /** Managed paths the output dropdown may offer, given the current draft. */
          const outputOptions = (() => {
            if (form.phase !== 'ready' || form.doc === undefined || draft === undefined) return [];
            const doc = form.doc;
            const set = new Set();
            if (doc.mode === 'initialized') {
              for (const dir of doc.catalog?.dirs ?? []) if (dir.role === 'managed') set.add(dir.path);
            } else {
              for (const path of doc.templateDirs?.[draft.template] ?? []) set.add(path);
              for (const [path, action] of Object.entries(draft.candidates ?? {})) if (action === 'register-managed') set.add(path);
            }
            return [...set].sort((left, right) => left.localeCompare(right, 'en'));
          })();

          /**
           * The card's initialization / editing surface. Rendered above the tab body so the
           * question is the first thing an unmanaged root shows, and stays visible (dimmed)
           * on a managed root for output and maintenance edits.
           */
          const initSection = (() => {
            if (reader === undefined) return null;
            if (form.phase === 'idle' || form.phase === 'loading') {
              return formWanted === true
                ? h('div', { 'data-file-maid': 'initbox' }, h('div', { 'data-file-maid': 'hint' }, t('init.loading')))
                : null;
            }
            if (form.phase === 'failed') {
              return h(
                'div',
                { 'data-file-maid': 'initbox' },
                h(
                  'div',
                  { 'data-file-maid': 'hint', 'data-tone': 'error', title: form.code === '' ? undefined : form.code },
                  formErrorText(form),
                ),
                h(
                  'button',
                  { type: 'button', 'data-file-maid': 'linkbutton', onClick: () => setRevision((value) => value + 1) },
                  t('refresh'),
                ),
              );
            }
            const doc = form.doc;
            if (doc === undefined) return null;
            if (doc.mode === 'broken' || doc.mode === 'opted-out') {
              return h('div', { 'data-file-maid': 'initbox' }, h('div', { 'data-file-maid': 'hint' }, doc.hint ?? t('init.failed')));
            }
            if (preview !== undefined) {
              const value = preview.doc;
              const added = Array.isArray(value.diff?.added) ? value.diff.added : [];
              const removed = Array.isArray(value.diff?.removed) ? value.diff.removed : [];
              return h(
                'div',
                { 'data-file-maid': 'initbox' },
                h('div', { 'data-file-maid': 'section' }, t('init.preview')),
                h(
                  'div',
                  { 'data-file-maid': 'muted' },
                  fill(t('init.previewSummary'), {
                    added: added.length,
                    removed: removed.length,
                    created: Array.isArray(value.createdDirs) ? value.createdDirs.length : 0,
                  }),
                ),
                added.length === 0 ? null : h('div', { 'data-file-maid': 'mono', style: { overflowWrap: 'anywhere' } }, `+ ${added.join(', ')}`),
                removed.length === 0 ? null : h('div', { 'data-file-maid': 'mono', style: { overflowWrap: 'anywhere' } }, `− ${removed.join(', ')}`),
                notice === '' ? null : h('div', { 'data-file-maid': 'hint', 'data-tone': 'error' }, notice),
                h(
                  'div',
                  { 'data-file-maid': 'initrow' },
                  h('button', { type: 'button', 'data-file-maid': 'init', disabled: busy, onClick: () => void runApply() }, busy ? t('init.busy') : t('init.confirm')),
                  h('button', { type: 'button', 'data-file-maid': 'linkbutton', disabled: busy, onClick: () => setPreview(undefined) }, t('init.back')),
                ),
              );
            }
            if (draft === undefined) return null;

            if (doc.mode === 'initialized') {
              const dirs = Array.isArray(doc.catalog?.dirs) ? doc.catalog.dirs : [];
              const roleLabel = (role) => (role === 'autonomous' ? t('role.autonomous') : t('role.managed'));
              const lastOp = (path, kind) => {
                const found = draft.ops.filter((op) => op.path === path && (kind === undefined || op.op === kind));
                return found.length === 0 ? undefined : found[found.length - 1];
              };
              const undoPath = (path) => {
                setDraft({ ...draft, ops: draft.ops.filter((op) => op.path !== path) });
                setOpenRow('');
              };
              const toggleRole = (dir) => {
                const pending = lastOp(dir.path, 'update');
                const next = (pending?.role ?? dir.role) === 'managed' ? 'autonomous' : 'managed';
                setDraft({
                  ...draft,
                  ops: [...draft.ops.filter((op) => !(op.path === dir.path && op.op === 'update')), { op: 'update', path: dir.path, role: next }],
                });
                setOpenRow('');
              };
              const markRemove = (dir) => {
                setDraft({ ...draft, ops: [...draft.ops, { op: 'remove', path: dir.path }] });
                setOpenRow('');
              };
              const addOp = () => {
                const path = newDir.path.trim();
                if (path === '') return;
                setDraft({ ...draft, ops: [...draft.ops, { op: 'add', path, role: newDir.role, purpose: newDir.purpose || path }] });
                setNewDir({ path: '', role: newDir.role, purpose: '' });
              };
              const changeCount = draft.ops.length;
              const dirRows = dirs.map((dir) => {
                const removeOp = lastOp(dir.path, 'remove');
                const updateOp = lastOp(dir.path, 'update');
                const isOpen = openRow === dir.path;
                const removed = removeOp !== undefined;
                return h(
                  'div',
                  {
                    key: `dir-${dir.path}`,
                    'data-file-maid': 'editrow',
                    'data-state': removed ? 'removed' : updateOp === undefined ? 'plain' : 'updated',
                  },
                  h(
                    'div',
                    { 'data-file-maid': 'editline' },
                    h(
                      'button',
                      {
                        type: 'button',
                        'data-file-maid': 'row-toggle',
                        'aria-expanded': isOpen ? 'true' : 'false',
                        onClick: () => setOpenRow(isOpen ? '' : dir.path),
                      },
                      h('span', { 'aria-hidden': 'true' }, isOpen ? '▾' : '▸'),
                      h(
                        'span',
                        {
                          'data-file-maid': 'mono',
                          title: dir.path,
                          style: { textDecoration: removed ? 'line-through' : 'none' },
                        },
                        dir.path,
                      ),
                    ),
                    h(
                      'span',
                      { 'data-file-maid': 'edithint' },
                      updateOp === undefined ? roleLabel(dir.role) : `${roleLabel(dir.role)} → ${roleLabel(updateOp.role)}`,
                    ),
                    removed ? h('span', { 'data-file-maid': 'edithint' }, t('init.pendingRemove')) : null,
                  ),
                  isOpen
                    ? h(
                        'div',
                        { 'data-file-maid': 'editactions' },
                        removed
                          ? h('button', { type: 'button', 'data-file-maid': 'linkbutton', onClick: () => undoPath(dir.path) }, t('init.undo'))
                          : [
                              h('button', { key: 'role', type: 'button', 'data-file-maid': 'linkbutton', onClick: () => toggleRole(dir) }, t('init.switchRole')),
                              h('button', { key: 'remove', type: 'button', 'data-file-maid': 'linkbutton', onClick: () => markRemove(dir) }, t('init.remove')),
                              updateOp === undefined
                                ? null
                                : h('button', { key: 'undo', type: 'button', 'data-file-maid': 'linkbutton', onClick: () => undoPath(dir.path) }, t('init.undo')),
                            ],
                      )
                    : null,
                );
              });
              const addedRows = draft.ops
                .filter((op) => op.op === 'add')
                .map((op) =>
                  h(
                    'div',
                    { key: `add-${op.path}`, 'data-file-maid': 'editrow', 'data-state': 'added' },
                    h(
                      'div',
                      { 'data-file-maid': 'editline' },
                      h('span', { 'data-file-maid': 'mono', title: op.path }, op.path),
                      h('span', { 'data-file-maid': 'edithint' }, `${roleLabel(op.role)} · ${t('init.pendingAdd')}`),
                      h('button', { type: 'button', 'data-file-maid': 'linkbutton', onClick: () => undoPath(op.path) }, t('init.undo')),
                    ),
                  ),
                );
              return h(
                'div',
                { 'data-file-maid': 'initbox' },
                h(
                  'div',
                  { 'data-file-maid': 'initrow' },
                  h('span', { 'data-file-maid': 'muted' }, t('init.output')),
                  h(
                    'select',
                    {
                      'data-file-maid': 'select',
                      style: { flex: '1 1 auto' },
                      value: draft.output,
                      'aria-label': t('init.output'),
                      onChange: (event) => setDraft({ ...draft, output: event.target.value }),
                    },
                    outputOptions.map((path) => h('option', { key: path, value: path }, path)),
                  ),
                ),
                h('div', { 'data-file-maid': 'divider' }),
                dirRows,
                addedRows,
                h(
                  'div',
                  { 'data-file-maid': 'initrow' },
                  h('input', {
                    'data-file-maid': 'input',
                    'aria-label': t('init.path'),
                    placeholder: t('init.path'),
                    value: newDir.path,
                    onChange: (event) => setNewDir({ ...newDir, path: event.target.value }),
                  }),
                ),
                h(
                  'div',
                  { 'data-file-maid': 'initrow' },
                  h(
                    'select',
                    { 'data-file-maid': 'select', value: newDir.role, 'aria-label': t('init.role'), onChange: (event) => setNewDir({ ...newDir, role: event.target.value }) },
                    h('option', { value: 'autonomous' }, t('role.autonomous')),
                    h('option', { value: 'managed' }, t('role.managed')),
                  ),
                  h('input', {
                    'data-file-maid': 'input',
                    'aria-label': t('init.purpose'),
                    placeholder: t('init.purpose'),
                    value: newDir.purpose,
                    onChange: (event) => setNewDir({ ...newDir, purpose: event.target.value }),
                  }),
                  h('button', { type: 'button', 'data-file-maid': 'linkbutton', onClick: addOp }, t('init.add')),
                ),
                h(
                  'div',
                  { 'data-file-maid': 'initrow' },
                  changeCount === 0
                    ? h('span', { 'data-file-maid': 'edithint' }, t('init.noChangesHint'))
                    : h(
                        'button',
                        { type: 'button', 'data-file-maid': 'init', disabled: busy, onClick: () => void runPreview('edit') },
                        busy ? t('init.busy') : fill(t('init.previewCount'), { n: changeCount }),
                      ),
                  h('span', { 'data-file-maid': 'spacer' }),
                  h(
                    'button',
                    { type: 'button', 'data-file-maid': 'linkbutton', disabled: busy, onClick: () => void runPreview('optout') },
                    t('init.stop'),
                  ),
                ),
                h('div', { 'data-file-maid': 'edithint' }, t('init.stopHint')),
                notice === '' ? null : h('div', { 'data-file-maid': 'hint', 'data-tone': 'error' }, notice),
              );
            }

            const candidates = Array.isArray(doc.candidates) ? doc.candidates : [];
            return h(
              'div',
              { 'data-file-maid': 'initbox' },
              h('div', { 'data-file-maid': 'section' }, t('init.title')),
              h(
                'div',
                { 'data-file-maid': 'initrow' },
                h('span', { 'data-file-maid': 'muted' }, t('init.template')),
                h(
                  'select',
                  { 'data-file-maid': 'select', value: draft.template, onChange: (event) => setDraft({ ...draft, template: event.target.value }) },
                  (doc.templates ?? []).map((item) => h('option', { key: item.name, value: item.name }, `${item.name} · ${fill(t('init.dirCount'), { n: item.count })}`)),
                ),
                h(
                  'label',
                  { 'data-file-maid': 'muted', style: { display: 'inline-flex', gap: '4px', alignItems: 'center' } },
                  h('input', { type: 'checkbox', checked: draft.create === true, onChange: (event) => setDraft({ ...draft, create: event.target.checked }) }),
                  t('init.create'),
                ),
              ),
              candidates.length === 0
                ? null
                : h(
                    'div',
                    null,
                    h('div', { 'data-file-maid': 'section' }, t('init.candidates')),
                    candidates.map((item) =>
                      h(
                        'div',
                        { key: item.path, 'data-file-maid': 'draftrow' },
                        h('span', { 'data-file-maid': 'mono', title: `${item.path} · ${item.source}` }, item.path),
                        h(
                          'select',
                          {
                            'data-file-maid': 'select',
                            value: draft.candidates[item.path] ?? 'skip',
                            onChange: (event) => setDraft({ ...draft, candidates: { ...draft.candidates, [item.path]: event.target.value } }),
                          },
                          h('option', { value: 'skip' }, t('init.skip')),
                          h('option', { value: 'register-autonomous' }, t('init.registerAutonomous')),
                          h('option', { value: 'register-managed' }, t('init.registerManaged')),
                        ),
                      ),
                    ),
                  ),
              h(
                'div',
                { 'data-file-maid': 'initrow' },
                h('span', { 'data-file-maid': 'muted' }, t('init.output')),
                h(
                  'select',
                  { 'data-file-maid': 'select', value: draft.output, onChange: (event) => setDraft({ ...draft, output: event.target.value }) },
                  outputOptions.map((path) => h('option', { key: path, value: path }, path)),
                ),
              ),
              h(
                'button',
                { type: 'button', 'data-file-maid': 'linkbutton', onClick: () => setDraft({ ...draft, showMore: draft.showMore !== true }) },
                draft.showMore === true ? t('init.less') : t('init.more'),
              ),
              draft.showMore === true
                ? h('textarea', {
                    'data-file-maid': 'textarea',
                    placeholder: t('init.customPlaceholder'),
                    value: draft.custom,
                    onChange: (event) => setDraft({ ...draft, custom: event.target.value }),
                  })
                : null,
              h(
                'div',
                { 'data-file-maid': 'initrow' },
                h('button', { type: 'button', 'data-file-maid': 'init', disabled: busy, onClick: () => void runPreview('init') }, busy ? t('init.busy') : t('init.previewAction')),
              ),
              notice === '' ? null : h('div', { 'data-file-maid': 'hint', 'data-tone': 'error' }, notice),
            );
          })();

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
                    onClick: () => setShowAllDirs(!showAllDirs),
                  },
                  h('span', { 'data-file-maid': 'morebarlabel' }, showAllDirs ? t('more.hide') : fill(t('more.show'), { n: dirs.length - 5 })),
                  h('span', { 'data-file-maid': 'morebarglyph', 'aria-hidden': 'true' }, showAllDirs ? '▴' : '▾'),
                )
              : null;
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
          const pickDirectory = async () => {
            setManageBusy(true);
            setManageError('');
            const result = await callRemote('pick', root, readerId);
            setManageBusy(false);
            if (result?.ok !== true) {
              setManageError(describeError(result, t('manage.failed')));
              return;
            }
            if (result.value?.cancelled === true || typeof result.value?.path !== 'string') return;
            setManage((current) => (current === undefined ? current : { ...current, path: result.value.path }));
          };

          /**
           * A directory needs a folder and a sentence saying what lands there;
           * refusals are optional. The folder check is the cheap half of the
           * Host's rule, so the button never invites a name that cannot be saved.
           */
          const managePath = manage === undefined ? '' : manage.path.trim();
          const managePathLegal =
            managePath.length > 0 &&
            !managePath.startsWith('.') &&
            !managePath.includes('/') &&
            !managePath.includes('\\') &&
            managePath !== '..';
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
                  h('div', { 'data-file-maid': 'managerow', 'data-file-maid-text': t('manage.confirmRemove') },
                    h('span', { 'data-file-maid': 'muted' }, fill(t('manage.confirmRemove'), { path: manage.path }))),
                  manageError === '' ? null : h('div', { 'data-file-maid': 'manageerror' }, manageError),
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
                  h('span', { 'data-file-maid': 'muted' }, t('manage.path'), h('span', { 'data-file-maid': 'required' }, ' *')),
                  h('input', {
                    'data-file-maid': 'input',
                    'aria-label': t('manage.path'),
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
                  h('span', { 'data-file-maid': 'muted' }, t('manage.purpose'), h('span', { 'data-file-maid': 'required' }, ' *')),
                  h('input', {
                    'data-file-maid': 'input',
                    'aria-label': t('manage.purpose'),
                    'data-invalid': manage.purpose.trim().length === 0 ? 'true' : 'false',
                    value: manage.purpose,
                    placeholder: t('manage.purposeHint'),
                    onChange: (event) => setManage({ ...manage, purpose: event.target.value }),
                  }),
                ),
                h(
                  'div',
                  { 'data-file-maid': 'managerow' },
                  h('span', { 'data-file-maid': 'muted' }, t('manage.excludes')),
                  h('input', {
                    'data-file-maid': 'input',
                    'aria-label': t('manage.excludes'),
                    value: manage.excludes,
                    placeholder: t('manage.termsHint'),
                    onChange: (event) => setManage({ ...manage, excludes: event.target.value }),
                  }),
                ),
                manageError === '' ? null : h('div', { 'data-file-maid': 'manageerror' }, manageError),
                manageHint === '' ? null : h('div', { 'data-file-maid': 'managehint' }, manageHint),
                h(
                  'div',
                  { 'data-file-maid': 'manageactions' },
                  h(
                    'button',
                    { type: 'button', 'data-file-maid': 'button', disabled: manageBusy || !manageReady, onClick: () => submitManage(manage.mode) },
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
                manageBox,
                dirs.length === 0
                  ? hintText === ''
                    ? null
                    : emptyState(t('section.catalog'), hintText)
                  : h('div', { 'data-file-maid': 'tablist' }, visibleRows),
                moreRow,
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
                h('div', { 'data-file-maid': 'setuperror' }, setup.error ?? ''),
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
                missingDefault ? h('div', { 'data-file-maid': 'setuperror' }, t('setup.needDefault')) : null,
                actions(
                  h('button', { type: 'button', 'data-file-maid': 'setupcta', disabled: missingDefault, onClick: () => writeSetup() }, t('setup.write')),
                ),
              );
            }
            if (step === 'form') {
              const field = (key, label, placeholder) =>
                h(
                  'label',
                  { 'data-file-maid': 'setupfield' },
                  h('span', { 'data-file-maid': 'setuplabel' }, label, label.startsWith(t('setup.purpose')) || label.startsWith(t('setup.path')) ? h('span', { 'data-file-maid': 'required' }, ' *') : null),
                  h('input', {
                    type: 'text',
                    'data-file-maid': 'setupinput',
                    'aria-label': label,
                    placeholder,
                    value: setupForm[key],
                    onChange: (event) => setupPatch({ draft: { ...setupForm, [key]: event.target.value } }),
                    onBlur: key === 'path' ? () => void checkSetupPath() : undefined,
                  }),
                );
              return h(
                'div',
                { 'data-file-maid': 'setuplayer' },
                h('div', { 'data-file-maid': 'setuphead' }, back('list'), h('span', { 'data-file-maid': 'setuptitle' }, t('setup.addTitle'))),
                field('path', t('setup.path'), t('setup.pathPh')),
                setup.problem === null
                  ? h('div', { 'data-file-maid': 'setuphint' }, t('setup.pathHint'))
                  : h('div', { 'data-file-maid': 'setupproblem', role: 'status' }, setup.problem),
                setupDuplicate ? h('div', { 'data-file-maid': 'setupproblem' }, t('setup.dup')) : null,
                field('purpose', t('setup.purpose'), t('setup.purposePh')),
                field('excludes', t('setup.excludes'), t('setup.excludesPh')),
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
                    'aria-label': t(`view.${shownView}`),
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

          const openEdit = () => {
            // The editor is retired in v5: the catalog is edited as a file. Keeping
            // the function defined means every existing call site keeps compiling.
            return undefined;
          };
          const openEditRetired = (mode) => {
            setEditMode(mode);
            setConfirmDiscard(false);
            setNotice('');
            setPreview(undefined);
            // Entering the edit layer is the one thing that wants the question form.
            setFormWanted(true);
          };
          const leaveEdit = () => {
            const dirty = (draft?.ops?.length ?? 0) > 0;
            if (dirty && confirmDiscard !== true) {
              setConfirmDiscard(true);
              return;
            }
            setEditMode('none');
            setPreview(undefined);
            setNotice('');
            setConfirmDiscard(false);
            setFormWanted(false);
            // Leaving drops the document: the next visit must read the root again rather
            // than reopen a form that another hand may have changed meanwhile.
            setForm({ phase: 'idle', doc: undefined, error: '', code: '' });
            setDraft(undefined);
          };
          /**
           * The one browse-layer door into the setup layer.
           *
           * It stands on the projection alone, which is all the browse layer is allowed
           * to need: a root either has a catalog or it does not. The question form — the
           * template list, the candidates, the size of the work — is fetched only after
           * this button is pressed, so a root no live Session serves stays quiet instead
           * of showing the Host's `E_MAID_NO_ROOT` to someone who never asked.
           * @returns {object|null} the status line, or null.
           */
          const setupLine = (() => {
            // The editor is retired in v5: the catalog is edited as a file.
            return null;
            if (editMode !== 'none') return null;
            const uninitialized = state.phase === 'absent' || catalogState === 'UNINITIALIZED';
            // The card's ledger already carries its own 编辑 in the section head; the wide
            // page has no such head, so it is the one that needs this door.
            const managed = viewsEnabled && !embedded;
            if ((!uninitialized && !managed) || reader === undefined) return null;
            return h(
              'div',
              { 'data-file-maid': 'statusline', 'data-align': 'center' },
              h(
                'button',
                {
                  type: 'button',
                  'data-file-maid': 'init',
                  onClick: () => openEdit(uninitialized ? 'init' : 'catalog'),
                },
                t(uninitialized ? 'init.start' : 'init.editDirs'),
              ),
            );
          })();
          /**
           * Why the form could not be produced. The Host names the failure in a stable
           * code, so the card maps it to a sentence about the next step instead of
           * echoing the Host's own English text at the operator.
           * @param {object} failed - `{ error, code }` from the failed fetch.
           * @returns {string} the sentence to show.
           */
          const formErrorText = (failed) => {
            if (failed?.code === 'E_MAID_NO_ROOT') return t('init.noRoot');
            if (failed?.code === 'E_MAID_NO_SESSION') return t('init.noSession');
            return typeof failed?.error === 'string' && failed.error !== '' ? failed.error : t('init.failed');
          };
          const editing = editMode !== 'none';
          const editHead =
            editing === true
              ? h(
                  'div',
                  { 'data-file-maid': 'edithead' },
                  h(
                    'button',
                    { type: 'button', 'data-file-maid': 'linkbutton', onClick: leaveEdit },
                    confirmDiscard === true
                      ? fill(t('init.discard'), { n: draft?.ops?.length ?? 0 })
                      : t('init.leave'),
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
            embedded && editing === true
              ? h('div', { 'data-file-maid': 'editlevel' }, editHead, initSection)
              : h(
                  React.Fragment,
                  null,
                  viewslot,
                  // Under the segmented row rather than above it: the row states what the
                  // root will offer, the button is the one thing to press about it.
                  editing === true ? null : setupLine,
                  embedded ? null : initSection,
                  bodyBlock,
                ),
            compact ? null : h('div', { 'data-file-maid': 'muted', style: { marginTop: 'auto', paddingTop: '8px' } }, t('readonly')),
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
                    : h('span', { 'data-file-maid': 'cardsuffix', title: badge.workspacePath }, ` · ${badge.workspace}`),
                ),
              ),
              badge === undefined
                ? null
                : h(
                    StateTip,
                    { tip: badge.detail === undefined || badge.detail === '' ? badge.label : badge.detail },
                    h(
                      'span',
                      { 'data-file-maid': 'badge', 'data-tone': badge.tone, role: 'status' },
                      h('span', { 'data-file-maid': 'badgedot', 'aria-hidden': 'true' }),
                      h('span', { 'data-file-maid': 'badgelabel' }, badge.label),
                    ),
                  ),
              badge === undefined || typeof badge.refresh !== 'function'
                ? null
                : h('button', { type: 'button', 'data-file-maid': 'button', onClick: badge.refresh }, t('refresh')),
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
