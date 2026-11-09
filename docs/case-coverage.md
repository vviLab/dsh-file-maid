# 验收用例 → 测试映射

PLAN v5.0 §11 的判据逐条落到具体测试。用例编号写在测试标题里，因此这张表可以从标题重新生成，不会与代码脱节：

```bash
node --input-type=module -e "
import { readFileSync, readdirSync } from 'node:fs';
const rows = [];
for (const f of readdirSync('packages/maid/test').filter((n) => n.endsWith('.test.js')).sort()) {
  for (const m of readFileSync('packages/maid/test/' + f, 'utf8').matchAll(/^test\('([A-Z]+-\d+[a-z]?)/gmu)) rows.push(m[1]);
}
console.log(rows.length, 'cases');
"
```

一条测试可以锁多条用例，因为一次调用同时说明了几件事。编号在标题里唯一：同一个编号出现两次，说明两条测试声称锁住同一件事，必须重编号。

## AK-*

| 用例 | 锁住它的测试 | 文件 |
| --- | --- | --- |
| AK-01 | AK-01 a missing file is an empty set, not an error | `ack.test.js` |
| AK-02 | AK-02 a corrupt file resurfaces everything and says so | `ack.test.js` |
| AK-03 | AK-03 a write bumps the revision and stays private | `ack.test.js` |
| AK-04 | AK-04 stale and retired entries are pruned on write | `ack.test.js` |
| AK-05 | AK-05 the key carries ctime, so a later write on the same path is seen | `ack.test.js` |

## C-*

| 用例 | 锁住它的测试 | 文件 |
| --- | --- | --- |
| C-01 | C-01 a complete catalog validates and normalizes | `core.test.js` |
| C-02 | C-02 version must be 1 | `core.test.js` |
| C-03 | C-03 dirs must be non-empty and paths unique | `core.test.js` |
| C-03b | C-03b a retired role field is accepted and never written back | `core.test.js` |
| C-04 | C-04 root_default must be one of the declared directories | `core.test.js` |
| C-05 | C-05 an empty purpose loads with a warning | `core.test.js` |
| C-06 | C-06 a retired rules block is ignored and said so | `core.test.js` |
| C-07 | C-07 path traversal and reserved segments are refused | `core.test.js` |
| C-08 | C-08 naming declarations are reported as not implemented | `core.test.js` |
| C-09 | C-09 a purpose or excludes sentence has a length ceiling | `core.test.js` |

## D-*

| 用例 | 锁住它的测试 | 文件 |
| --- | --- | --- |
| D-01 | D-01 the caller directory wins; keyword matching no longer exists | `core.test.js` |
| D-02 | D-02 the caller directory wins over the default | `core.test.js` |
| D-03 | D-03 the default catches everything else | `core.test.js` |
| D-04 | D-04 an undeclared caller directory is refused, not defaulted | `core.test.js` |
| D-05 | D-05 candidates rank accepted purposes above refused ones | `core.test.js` |
| D-06 | D-06 a file name cannot route anything on its own | `core.test.js` |
| D-07 | D-07 names that could escape the directory are refused | `core.test.js` |

## EX-*

| 用例 | 锁住它的测试 | 文件 |
| --- | --- | --- |
| EX-01 | EX-01 an export lands beside the report under the same stem | `tools.test.js` |
| EX-02 | EX-02 a coverage hole exports counts as unknown, not zero | `tools.test.js` |
| EX-03 | EX-03 the export can stand alone, and the budget counts pairs | `tools.test.js` |
| EX-04 | EX-04 pruning drops a pair when the budget turns over | `tools.test.js` |
| EX-05 | EX-05 the CLI writes the same pair as the tool | `tools.test.js` |
| EX-06 | EX-06 a CLI scan only moves the baseline when asked | `tools.test.js` |

## I-*

| 用例 | 锁住它的测试 | 文件 |
| --- | --- | --- |
| I-01 | I-01 an absolute .maid path is refused lexically | `policy.test.js` |
| I-02 | I-02 and I-05 a symlinked parent directory is refused by inode | `policy.test.js` |
| I-03 | I-03 a relative write after cd .maid is refused | `policy.test.js` |
| I-04 | I-04 a relative write after the committed directory vanished is still refused | `policy.test.js` |
| I-06 | I-06 a non-protected path continues to the next listener | `policy.test.js` |
| I-07 | I-07 str_replace_editor view is allowed even on .maid | `policy.test.js` |
| I-08 | I-08 str_replace_editor create is refused | `policy.test.js` |
| I-09 | I-09 an agentless call is not served | `policy.test.js` |
| I-10 | I-10 pre-execute returns a deny decision with the fixed prefix | `policy.test.js` |
| I-20 | I-20 a file symlink into .maid is refused by inode | `policy.test.js` |
| I-21 | I-21 a directory symlink into .maid is refused for new files beneath it | `policy.test.js` |
| I-22 | I-22 a host-resolved intent from an unknown tool is still judged | `policy.test.js` |
| I-23 | I-23 a host-resolved intent outside the surface is allowed | `policy.test.js` |
| I-24 | I-24 the Host resolution of the target joins the protection check | `policy.test.js` |
| I-25 | I-25 the refusal keeps the documented prefix and code | `policy.test.js` |
| I-26 | I-26 both resolution bases are judged | `policy.test.js` |
| I-27 | I-27 an unprobeable .maid refuses as UNVERIFIED | `policy.test.js` |
| I-28 | I-28 only write, edit and str_replace_editor are judged | `policy.test.js` |
| I-29 | I-29 a relative .maid path is refused lexically | `policy.test.js` |

## L-*

| 用例 | 锁住它的测试 | 文件 |
| --- | --- | --- |
| L-01 | L-01 a write observation lands in the ledger | `ledger.test.js` |
| L-02 | L-02 and L-03 read observations stay out of the ledger | `ledger.test.js` |
| L-04 | L-04 a read-only session records nothing | `ledger.test.js` |
| L-05 | L-05 a path outside the root is not recorded | `ledger.test.js` |
| L-07 | L-07 the init marker dates the ledger without counting as a write | `ledger.test.js` |

## M-*

| 用例 | 锁住它的测试 | 文件 |
| --- | --- | --- |
| M-01 | M-01 add declares a folder that already exists on disk | `manage.test.js` |
| M-02 | M-02 add refuses a directory that is already declared | `manage.test.js` |
| M-03 | M-03 update rewrites purpose and terms, keeping the path | `manage.test.js` |
| M-04 | M-04 removing the default output is refused | `manage.test.js` |
| M-05 | M-05 removing another directory keeps its files and reprojects | `manage.test.js` |
| M-06 | M-06 a root the session does not own is refused before any read | `manage.test.js` |
| M-07 | M-07 the descriptors name the six endpoints and the service carries them | `manage.test.js` |
| M-08 | M-08 the folder dialog answer is returned as a path inside the root | `manage.test.js` |
| M-09 | M-09 a cancelled dialog and an outside folder are both answered, not thrown | `manage.test.js` |
| M-10 | M-10 the sessions service is found through get() when ctx.sessions is absent | `manage.test.js` |
| M-11 | M-11 an unreachable sessions service answers instead of throwing | `manage.test.js` |
| M-12 | M-12 every platform seeds its dialog with the controlled root | `manage.test.js` |
| M-13 | M-13 an unknown platform reports itself instead of guessing | `manage.test.js` |
| M-14 | M-14 windows quotes a folder name that contains an apostrophe | `manage.test.js` |
| M-15 | M-15 a folder without a purpose is refused | `manage.test.js` |
| M-16 | M-16 clearing a purpose on update is refused | `manage.test.js` |
| M-17 | M-17 a folder that does not exist is refused instead of created | `manage.test.js` |
| M-18 | M-18 an edit payload is accepted as update | `manage.test.js` |
| M-19 | M-19 a directory with an empty purpose can be given one | `manage.test.js` |
| M-20 | M-20 the scan endpoint answers with the reconciliation | `ledger.test.js` |
| M-30 | M-30 draft describes each kind of bad path | `init.test.js` |
| M-31 | M-31 canInit is true only without a table or with a blank one | `init.test.js` |
| M-32 | M-32 draft reports a symlink anywhere on the path | `init.test.js` |
| M-33 | M-33 init refuses an empty list and a list over the cap | `init.test.js` |
| M-34 | M-34 init refuses a folder that is not on disk | `init.test.js` |
| M-35 | M-35 init refuses a row without a purpose | `init.test.js` |
| M-36 | M-36 two spellings of one folder are one row | `init.test.js` |
| M-37 | M-37 the default folder must be one of the listed rows | `init.test.js` |
| M-38 | M-38 init writes the table, scans, reloads and audits | `init.test.js` |
| M-39 | M-39 an existing table is refused and left untouched | `init.test.js` |
| M-40 | M-40 a blank table is replaced and the previous hash is recorded | `init.test.js` |
| M-41 | M-41 an opted-out root refuses setup | `init.test.js` |
| M-42 | M-42 a read-only session writes nothing | `init.test.js` |
| M-43 | M-43 two concurrent setups of one root produce one table | `init.test.js` |
| M-44 | M-44 paths are normalised before they are checked | `init.test.js` |
| M-45 | M-45 a blank table still reads as ERROR, not as a new state | `init.test.js` |
| M-46 | M-46 a row can be made the fallback while it is being edited | `manage.test.js` |
| M-47 | M-47 an edit that does not ask for the fallback leaves it alone | `manage.test.js` |
| M-48 | M-48 a too-long purpose is refused in words the card can show | `manage.test.js` |
| M-49 | M-49 the retired rule operations are refused | `manage.test.js` |

## PL-*

| 用例 | 锁住它的测试 | 文件 |
| --- | --- | --- |
| PL-01 | PL-01 the plugin exports one name and the services it needs | `plugin.test.js` |
| PL-02 | PL-02 apply registers one prompt section, five tools, five hooks and two lifecycle handlers | `plugin.test.js` |
| PL-03 | PL-03 a host without the prompt service fails the mount instead of loading silently | `plugin.test.js` |

## PR-*

| 用例 | 锁住它的测试 | 文件 |
| --- | --- | --- |
| PR-01 | PR-01 the section names every directory and the six rules | `prompt.test.js` |
| PR-02 | PR-02 a missing catalog removes the section entirely | `prompt.test.js` |
| PR-03 | PR-03 the budget is enforced by dropping rows | `prompt.test.js` |
| PR-04 | PR-04 the same catalog renders byte-identically | `prompt.test.js` |
| PR-05 | PR-05 the provider is silent for a root that is not managed | `prompt.test.js` |

## R-*

| 用例 | 锁住它的测试 | 文件 |
| --- | --- | --- |
| R-01 | R-01 the gap is new files minus recorded writes | `core.test.js` |
| R-02 | R-02 the first scan is a baseline and reports no gap | `core.test.js` |
| R-03 | R-03 deletions never produce a negative gap | `core.test.js` |
| R-04 | R-04 a quiet window reports a zero gap | `core.test.js` |
| R-10 | R-10 a root without a catalog is UNINITIALIZED | `runtime.test.js` |
| R-11 | R-11 a broken catalog is ERROR and carries the reason | `runtime.test.js` |
| R-12 | R-12 the first scan is a baseline and the projection says so | `runtime.test.js` |
| R-13 | R-13 a second scan reconciles against the stored baseline | `runtime.test.js` |
| R-14 | R-14 the catalog is re-read on every tool call, never cached across edits | `runtime.test.js` |
| R-15 | R-15 starting a session counts the root once so the card has numbers | `runtime.test.js` |
| R-16 | R-16 a projection with no scan outcome carries no scan block | `runtime.test.js` |
| R-20 | R-20 the four quantities add up | `ledger.test.js` |
| R-21 | R-21 one path written twice is named once | `ledger.test.js` |
| R-22 | R-22 a ledger that starts late marks the window incomplete | `ledger.test.js` |
| R-23 | R-23 a rotation inside the window makes both channels incomplete | `ledger.test.js` |
| R-24 | R-24 a rotation before the window leaves coverage intact | `ledger.test.js` |
| R-25 | R-25 a stream past the byte budget rotates and records when | `ledger.test.js` |
| R-26 | R-26 a window with a coverage hole reports counts but no names | `ledger.test.js` |
| R-27 | R-27 the two channels report files, so the card can add them up | `ledger.test.js` |
| R-28 | R-28 a concurrent walk reports the same tree as a serial one | `scan.test.js` |
| R-29 | R-29 candidate truncation is reproducible | `scan.test.js` |
| R-30 | R-30 the cap follows the measured latency, and the environment can pin it | `scan.test.js` |
| R-31 | R-31 a scan does not stall the event loop | `scan.test.js` |
| R-31b | R-31b mount types only shorten the starting cap | `scan.test.js` |
| R-32 | R-32 the leak entry carries rich fields, and the projection strips them | `runtime.test.js` |
| R-33 | R-33 an accepted leak leaves the list but keeps the arithmetic whole | `ack.test.js` |
| R-34 | R-34 residual is subtracted from missing_total, not the visible list | `ack.test.js` |
| R-35 | R-35 a coverage gap keeps every acknowledgement number unknown | `ack.test.js` |
| R-36 | R-36 accepting hides the leak, undoing brings it back | `ack.test.js` |
| R-37 | R-37 an acceptance after a restart still updates the stored projection | `ack.test.js` |
| R-38 | R-38 an undo brings the row back in the stored projection | `ack.test.js` |
| R-39 | R-39 a name that only works on one platform is refused with a reason | `runtime.test.js` |
| R-40 | R-40 the naming refusal reaches the caller as a list | `runtime.test.js` |
| R-41 | R-41 a rotation names what came after it and counts the rest | `ack.test.js` |
| R-42 | R-42 without a rotation instant the whole window stays a count | `ack.test.js` |
| R-43 | R-43 a file written in the rotation millisecond stays a count | `ack.test.js` |
| R-44 | R-44 a leak carries both clocks, so a rename is distinguishable from a write | `tools.test.js` |
| R-45 | R-45 a scan keeps only files whose ctime is inside the window | `ledger.test.js` |
| R-46 | R-46 the candidate list stops at the limit and says so | `ledger.test.js` |

## RD-*

| 用例 | 锁住它的测试 | 文件 |
| --- | --- | --- |
| RD-01 | RD-01 the card mounts and every component body renders without throwing | `render.test.js` |
| RD-02 | RD-02 the renderer runs the directory page, not only the shell | `render.test.js` |
| RD-03 | RD-03 no state is read before its declaration | `render.test.js` |
| RD-04 | RD-04 every setter call has a state behind it | `render.test.js` |
| RD-05 | RD-05 helpers used while building the rows are declared before the rows | `render.test.js` |
| RD-06 | RD-06 the directory rows, the table rows and the ledger all render with data | `render-data.test.js` |
| RD-07 | RD-07 switching to the scan page renders the verdict and the three counts | `render-data.test.js` |
| RD-08 | RD-08 the scan page builds the rich leak rows from the review reply | `render-data.test.js` |
| RD-09 | RD-09 the counts add up to the sentence, and no fact is stated twice | `render-data.test.js` |
| RD-10 | RD-10 the counts carry their own sentence underneath | `render-data.test.js` |

## S-*

| 用例 | 锁住它的测试 | 文件 |
| --- | --- | --- |
| S-01 | S-01 and P-02 enforce 0700 / 0600 | `store.test.js` |
| S-03 | S-03 rotation keeps ten rotated files and starts a new base | `store.test.js` |
| S-04 | S-04 reports are pruned to thirty and the deletion is audited | `store.test.js` |
| S-05 | S-05 a corrupt index.json is quarantined | `store.test.js` |
| S-12 | S-12 a refusal sentence survives the YAML round-trip as one sentence | `store.test.js` |
| S-13 | S-13 an absent .maid reports UNINITIALIZED | `store.test.js` |
| S-14 | S-14 an opt-out marker wins over a valid catalog | `store.test.js` |
| S-15 | S-15 a catalog round-trips through YAML and json | `store.test.js` |
| S-16 | S-16 an unknown catalog key is a warning, not a failure | `store.test.js` |

## T-*

| 用例 | 锁住它的测试 | 文件 |
| --- | --- | --- |
| T-01 | T-01 the five tools register with the shared envelope schema | `tools.test.js` |
| T-02 | T-02 an uninitialized root answers UNINITIALIZED and writes nothing | `tools.test.js` |
| T-03 | T-03 maid_put writes into the declared directory and records the decision | `tools.test.js` |
| T-04 | T-04 the caller directory is honoured, and a retired rules block does not override it | `tools.test.js` |
| T-05 | T-05 an existing target is refused unless overwrite is set | `tools.test.js` |
| T-06 | T-06 an undeclared directory is refused and nothing is written | `tools.test.js` |
| T-07 | T-07 a read-only session persists nothing | `tools.test.js` |
| T-08 | T-08 intent falls back to the session tail | `tools.test.js` |
| T-09 | T-09 reconciliation counts files written outside the channel | `tools.test.js` |
| T-10 | T-10 maid_init refuses to initialize from the tool | `tools.test.js` |
| T-11 | T-11 the name check refuses separators before touching the disk | `tools.test.js` |
| T-12 | T-12 every envelope survives a JSON round-trip unchanged | `tools.test.js` |
| T-13 | T-13 a successful put republishes the projection the card reads | `tools.test.js` |
| T-14 | T-14 a scan names the files it cannot account for | `tools.test.js` |
| T-15 | T-15 maid_review lists every leak with its size and change time | `tools.test.js` |
| T-16 | T-16 maid_review never advances the baseline | `tools.test.js` |
| T-17 | T-17 maid_review reports the catalog state instead of an empty list | `tools.test.js` |
| T-18 | T-18 maid_review works in a read-only session and writes nothing | `tools.test.js` |

## UI-*

| 用例 | 锁住它的测试 | 文件 |
| --- | --- | --- |
| UI-01 | UI-01 a managed scan writes the v2 status document the panel reads | `ui.test.js` |
| UI-02 | UI-02 an uninitialized root still projects its state | `ui.test.js` |
| UI-03 | UI-03 the decision ledger reaches the panel, newest last | `ui.test.js` |
| UI-04 | UI-04 the status file is owner-only data | `ui.test.js` |
| UI-05 | UI-05 the client bundle registers one sidebar panel under the package id | `ui.test.js` |
| UI-06 | UI-06 the card reads the v2 projection and maps it onto its own fields | `ui.test.js` |
| UI-07 | UI-07 the card mounts the management endpoints | `ui.test.js` |
| UI-08 | UI-08 the three pages are 目录 / 日志 / 扫描 in both locales | `ui.test.js` |
| UI-09 | UI-09 the tablist and its panel stay adjacent in the card | `ui.test.js` |
| UI-10 | UI-10 no hook selector uses prefix or substring matching | `ui.test.js` |
| UI-11 | UI-11 the scan page leads with a verdict and keeps the jargon out | `ledger.test.js` |
| UI-32 | UI-32 a directory row keeps its actions inside the head line | `ui.test.js` |
| UI-33 | UI-33 the purpose only offers "expand" when it really overflows | `ui.test.js` |
| UI-34 | UI-34 the count and the actions share the right edge | `ui.test.js` |
| UI-35 | UI-35 opening the form closes the expanded row | `ui.test.js` |
| UI-36 | UI-36 the directory page has no native title tooltips | `ui.test.js` |
| UI-37 | UI-37 every t() key is present in both dictionaries | `ui.test.js` |
| UI-40 | UI-40 an unset root renders the setup entry instead of an empty body | `ui.test.js` |
| UI-41 | UI-41 the add button waits for a path, a purpose and a clean check | `ui.test.js` |
| UI-42 | UI-42 a duplicate row is refused before any request | `ui.test.js` |
| UI-43 | UI-43 the confirm screen lists the rows and states the promise | `ui.test.js` |
| UI-44 | UI-44 an existing table counts as success on the second attempt | `ui.test.js` |
| UI-45 | UI-45 the setup layer closes back into the directory view | `ui.test.js` |
| UI-46 | UI-46 every setup hook in the renderer is also styled | `ui.test.js` |
| UI-47 | UI-47 the panel only uses host colour tokens | `ui.test.js` |
| UI-48 | UI-48 the card carries no native title on the tab strip | `ui.test.js` |
| UI-49 | UI-49 disabled tabs leave the tab order | `ui.test.js` |
| UI-50 | UI-50 every styled hook is rendered and every rendered hook is styled | `ui.test.js` |
| UI-51 | UI-51 the metrics come from the five size tiers, not from literals | `ui.test.js` |
| UI-52 | UI-52 every disclosure controls the node it opens, and errors announce themselves | `ui.test.js` |
| UI-53 | UI-53 a long workspace name truncates instead of running under the badge | `ui.test.js` |
| UI-54 | UI-54 the rescan control looks pressable, not like a caption | `ui.test.js` |
| UI-55 | UI-55 every interactive control shares one hit height | `ui.test.js` |
| UI-56 | UI-56 every page keeps the same rhythm under its section head | `ui.test.js` |
| UI-57 | UI-57 a long folder name truncates, and expanding the row reveals it | `ui.test.js` |
| UI-58 | UI-58 a long file or folder name in the log truncates on each axis | `ui.test.js` |
| UI-59 | UI-59 a log row expands to name its full path | `ui.test.js` |
| UI-60 | UI-60 the expanded log row labels its facts and prints a stable local stamp | `ui.test.js` |
| UI-61 | UI-61 the expanded directory block labels its facts and drops the duplicate path | `ui.test.js` |
| UI-62 | UI-62 the landed figure names its window, not just a bare number | `ui.test.js` |
| UI-63 | UI-63 the fallback is chosen inside the edit form, in words a user can act on | `ui.test.js` |
| UI-64 | UI-64 the card keeps itself current without a refresh button | `ui.test.js` |
| UI-65 | UI-65 the badge bubble only appears when it says something new | `ui.test.js` |
| UI-66 | UI-66 a slow scan is reported as speed, and the card carries no footnote | `ui.test.js` |
| UI-67 | UI-67 scan speed never touches the state badge or its tooltip | `ui.test.js` |
| UI-68 | UI-68 the fallback row is a star with the meaning on hover | `ui.test.js` |
| UI-69 | UI-69 the setup path can be typed or picked from the folder dialog | `ui.test.js` |
| UI-70 | UI-70 long sentences are stopped in the form and the table warns when it grows | `ui.test.js` |
| UI-71 | UI-71 the two dictionaries agree, and the card stopped promising what it does not do | `ui.test.js` |
| UI-72 | UI-72 one colour language: primary actions are branded, everything else is neutral | `ui.test.js` |
| UI-73 | UI-73 the leak row is two lines and hides the confirmation behind a disclosure | `ui.test.js` |
| UI-74 | UI-74 a read-only session disables accepting and exporting, with a reason | `ui.test.js` |
| UI-75 | UI-75 the review is lazy, cached per snapshot, and behind three phases | `ui.test.js` |
| UI-76 | UI-76 the export choice is remembered per root and only applies to the next scan | `ui.test.js` |
| UI-77 | UI-77 a rescan asks for a second click while unrecorded changes are open | `ui.test.js` |
| UI-78 | UI-78 the card explains when the net change and the leak count disagree | `ui.test.js` |
| UI-79 | UI-79 the directory page carries no keyword rules | `ui.test.js` |
| UI-80 | UI-80 the card says how many files it could not name | `ui.test.js` |
| UI-81 | UI-81 no dictionary key outlives the feature that showed it | `ui.test.js` |

## V-*

| 用例 | 锁住它的测试 | 文件 |
| --- | --- | --- |
| V-06 | V-06 invalid YAML reports E_MAID_YAML with a position | `store.test.js` |

## X-*

| 用例 | 锁住它的测试 | 文件 |
| --- | --- | --- |
| X-01 | X-01 the session tail keeps the newest text within one fence | `core.test.js` |
| RD-11 | RD-11 the log page separates what File Maid placed from what arrived on its own | `render-data.test.js` |
| RD-12 | RD-12 the scan page offers a way into the log without hunting for the tab | `render-data.test.js` |
