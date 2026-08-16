---
name: ai-code-tracker-design
description: opencode AI 代码追踪工具设计文档，通过行级内容匹配识别 AI 新增代码，并在 commit 后自动生成统计提交。
---

# AI 代码追踪工具 — opencode 设计文档

## 问题

开发者想知道仓库里有多少新增代码来自 AI。常见的 `Co-Authored-By` 只能标记 commit 级别的 AI 参与，无法区分同一个 commit 里哪些新增行是 AI 写的、哪些是人写的。

## 目标

- 最终交付物是一个名为 `ai-code-tracker` 的 opencode 项目级 skill，安装位置为 `.opencode/skills/ai-code-tracker/SKILL.md`，并包含脚本、opencode 项目插件和必要参考文档。
- 支持 opencode 使用场景，自动记录 AI 编辑产生的新增行。
- 只在安装过的当前项目生效，不写入全局 opencode 配置，不安装全局命令。
- opencode 写代码前应先加载 `ai-code-tracker` skill 执行 preflight；如果当前项目尚未启用追踪，先询问用户是否安装，用户确认后自动执行项目级安装。
- 用户正常提交代码，不修改用户原始 commit，不依赖 `git commit --amend`。
- 每次代码 commit 成功后，自动创建一个独立的统计 commit。
- 统计数据以 CSV 形式提交到仓库，便于长期追踪和团队共享。
- 提供 `ai-code-stats` 命令读取 CSV 并展示汇总结果。
- 对本地临时状态使用文件锁和原子写入，避免并发编辑导致数据损坏。
- 如果锁文件或临时文件被占用导致写入失败，输出 `.ai-tracking/errors.log`，用户处理锁后可重试同一个 opencode 编辑、`git commit` 或 `git push` 来重新生成对应追踪数据。

## 非目标

- 不追踪删除行。
- 不做完美代码归因，只做基于行内容匹配的估算。
- 不识别 AI 生成后又被人工大幅改写的代码。
- 不把统计 CSV 强行塞进用户的代码 commit。
- 不默认支持 Claude Code、Codex 或其他 AI 工具；后续可用相同数据格式扩展。

## 方案

通过行级内容匹配追踪 AI 编辑。opencode 插件在 AI 编辑文件后记录新增行，git hook 在用户提交时从暂存区 diff 中提取新增行，并与 AI 记录逐行匹配。提交成功后，post-commit hook 使用真实 commit SHA 和原始提交信息生成正式 CSV 记录，并自动创建一个独立的统计提交。

统计提交的提交信息复用用户提交的完整提交信息，并在第一行追加后缀：

```text
<original subject> [ai-tracking]

<original body>
```

## 流程

```text
opencode 编辑文件
  -> 项目 AGENTS.md / opencode instructions 要求先加载 ai-code-tracker skill
  -> skill preflight 检查 .opencode/plugins、.ai-tracking/config.json、git hooks 是否已安装
  -> 如果未安装，询问用户是否安装
  -> 用户确认后运行 .opencode/skills/ai-code-tracker/scripts/install.js
  -> 安装完成后重新执行 preflight
  -> preflight 通过后继续执行用户的代码任务
  -> 如果已安装，继续执行用户的代码任务
  -> 当前项目的 opencode 插件监听文件编辑事件
  -> 提取本次编辑新增行
  -> 写入 .ai-tracking/pending-lines.json
  -> 如果 .lock 或临时文件被占用，写入 .ai-tracking/errors.log 并提示用户释放锁后重试本次编辑

用户执行 git commit
  -> pre-commit hook 触发
     -> 如果 AI_CODE_TRACKER_SKIP=1，直接退出
     -> 获取 staged diff
     -> 提取新增行，按文件分组
     -> 与 pending-lines.json 逐行匹配
     -> 写入 .ai-tracking/pending-commit.json
     -> 不 git add CSV，不修改用户 commit 内容
     -> 如果临时文件写入失败，写入 .ai-tracking/errors.log；用户处理锁/临时文件后重新执行 git commit 即可重新生成 pending-commit.json
  -> 用户 commit 正常完成

post-commit hook 触发
  -> 如果 AI_CODE_TRACKER_SKIP=1，直接退出
  -> 如果 AI_CODE_TRACKER_DEPTH>0，直接退出并报错
  -> 读取 pending-commit.json
  -> 获取刚完成 commit 的 SHA、author、date、完整 message
  -> 追加一行到 .ai-tracking/<author>.csv
  -> git add .ai-tracking/<author>.csv
  -> 校验暂存区只包含 .ai-tracking/ 变更
  -> AI_CODE_TRACKER_SKIP=1 AI_CODE_TRACKER_DEPTH=1 git commit -F <生成的提交信息文件>
  -> 清理 pending-commit.json
  -> 从 pending-lines.json 消费已匹配的 AI 行

用户执行 git push
  -> pre-push hook 触发
  -> 将 pending-lines.json、pending-commit.json、tracking-message.txt 归档到 .ai-tracking/archive/<timestamp>/
  -> 清理 active pending 文件，避免 push 后的旧 AI 行影响下一轮编辑
  -> 如果归档或临时文件操作失败，写入 .ai-tracking/errors.log；用户处理锁/临时文件后重新执行 git push 即可重新归档
```

## 组件

### 1. opencode Skill 入口

**位置：**

```text
.opencode/skills/ai-code-tracker/
├── SKILL.md
├── scripts/
└── references/
```

**职责：**

1. 说明这个 skill 何时触发：opencode 准备修改代码前、用户想安装、启用、修复或查看 AI 代码统计时触发。
2. 指导 agent 使用 bundled scripts，而不是手写安装逻辑。
3. 提供 preflight 工作流：
   - 检查 `.opencode/plugins/ai-code-tracker.js`
   - 检查 `.ai-tracking/config.json`
   - 检查 `.git/hooks/pre-commit` 和 `.git/hooks/post-commit` 中的 tracker hook block
   - 如果缺失，先询问用户是否安装，不直接开始代码修改
   - 用户确认后自动运行 `scripts/install.js`
   - 安装完成后重新检查；仍失败则停止并报告原因
4. 提供最小操作：
   - 安装：运行 `scripts/install.js`
   - 查看统计：运行 `scripts/ai-code-stats.js`
   - 修复：运行 `scripts/install.js --repair`
   - 验证 opencode 事件：运行 `scripts/verify-opencode-plugin.js`
5. 明确限制：统计是基于行内容匹配的估算，不是完美归因。

`SKILL.md` 保持简短；详细设计和实现说明放在 `references/`，可执行逻辑放在 `scripts/`。

### 2. opencode 项目规则

**位置：**

```text
AGENTS.md
opencode.json  # 可选，用 instructions 字段引用 tracker 规则
```

**职责：**

1. 作为 opencode 会话的常驻项目规则，要求 agent 在任何会修改代码的任务前先加载 `ai-code-tracker` skill。
2. 如果 skill preflight 报告未安装或损坏，必须先询问用户是否安装/修复；用户确认后自动执行安装/修复并复查，不应直接继续修改代码。
3. 保持简短，避免把完整设计放进常驻上下文。

### 3. opencode 项目插件

**位置：**

```text
.opencode/skills/ai-code-tracker/scripts/opencode-plugin.js
.opencode/plugins/ai-code-tracker.js  # 安装后复制到当前项目
```

**职责：**

1. 监听当前项目中的 opencode 文件编辑相关事件。
2. 判断当前工作目录是否是已安装 tracker 的 git 仓库。
3. 对比编辑前后的文件内容，提取新增行。
4. 按相对路径写入 `.ai-tracking/pending-lines.json`。
5. 忽略 `.git/`、`.ai-tracking/`、二进制文件和配置中排除的路径。
6. 写入 pending 文件时获取 `.ai-tracking/pending-lines.lock`，写入临时文件后通过 rename 原子替换。
7. 锁或临时文件失败时写入 `.ai-tracking/errors.log`，日志包含动作、路径、错误和重试指引。

**输出文件：**

```json
{
  "src/main.py": [
    "def hello():",
    "    print('world')"
  ],
  "src/utils.py": [
    "import os"
  ]
}
```

**匹配策略：**

- 记录原始行内容，包括缩进。
- 空行默认不计入 AI 行，避免噪声。
- 同一内容出现多次时保留多条记录，后续按 multiset 计数。
- 文件路径统一为 git 仓库相对路径。

### 4. 安装器

**命令：**

```bash
node <skill-dir>/scripts/install.js
```

**职责：**

1. 在当前 git 仓库创建 `.opencode/plugins/` 和 `.ai-tracking/`。
2. 将 `.opencode/skills/ai-code-tracker/scripts/opencode-plugin.js` 复制或链接为 `.opencode/plugins/ai-code-tracker.js`。
3. 写入或更新当前项目的 opencode 配置，使该项目加载 `.opencode/plugins/ai-code-tracker.js`。
4. 安装或包装 `.git/hooks/pre-commit` 和 `.git/hooks/post-commit`。
5. 将临时文件加入 `.gitignore`：

```gitignore
.ai-tracking/pending-lines.json
.ai-tracking/pending-commit.json
.ai-tracking/tracking-message.txt
.ai-tracking/*.lock
```

6. 确保 `.ai-tracking/*.csv` 不被 gitignore 排除。
7. 写入仓库级配置 `.ai-tracking/config.json`。
8. 写入或更新 `AGENTS.md` 的 tracker preflight 规则，确保后续 opencode 写代码前会先加载 skill 检查安装状态。
9. 检查当前仓库、`.opencode/`、`.git/hooks/`、`.ai-tracking/`、`AGENTS.md` 和 `.gitignore` 是否可写；不可写时中止并给出修复建议。

**hook 兼容策略：**

- 如果目标 hook 不存在，直接创建。
- 如果目标 hook 已存在，追加一个受标记包围的调用块。
- 不覆盖用户已有 hook。
- 重复执行安装器必须幂等。

### 5. commit 统计脚本

**位置：**

```text
.opencode/skills/ai-code-tracker/scripts/commit-stats.js
.ai-tracking/bin/commit-stats.js  # 安装后复制到当前项目
```

**pre-commit 行为：**

1. 遇到 `AI_CODE_TRACKER_SKIP=1` 直接退出。
2. 如果当前 commit 只包含 `.ai-tracking/` 变更，直接退出。
3. 读取 `git diff --cached --numstat` 和 `git diff --cached --unified=0`。
4. 提取新增行，忽略 diff 头部中的 `+++`。
5. 读取 `.ai-tracking/pending-lines.json`。
6. 逐文件、逐行匹配 AI 记录。
7. 生成 `.ai-tracking/pending-commit.json`，不修改暂存区。

**pending-commit.json 格式：**

```json
{
  "ai_lines": 42,
  "total_lines": 58,
  "matched_lines": {
    "src/main.py": [
      "def hello():"
    ]
  }
}
```

**post-commit 行为：**

1. 遇到 `AI_CODE_TRACKER_SKIP=1` 直接退出。
2. 遇到 `AI_CODE_TRACKER_DEPTH>0` 直接退出并报错，避免递归提交链。
3. 如果最近一次 commit message 第一行已经包含 `[ai-tracking]`，直接退出。
4. 如果不存在 `pending-commit.json`，直接退出。
5. 获取真实 commit 信息：

```bash
git rev-parse HEAD
git log -1 --pretty=%an
git log -1 --pretty=%ad --date=short
git log -1 --pretty=%B
```

6. 追加正式 CSV 行到 `.ai-tracking/<safe-author>.csv`。
7. 暂存 CSV 文件。
8. 校验暂存区只包含 `.ai-tracking/` 变更；否则中止并保留 pending 文件。
9. 如果 CSV 没有变化，清理临时文件并退出。
10. 使用原 commit 的完整提交信息创建统计提交，并在第一行追加后缀：

```bash
AI_CODE_TRACKER_SKIP=1 AI_CODE_TRACKER_DEPTH=1 git commit -F .ai-tracking/tracking-message.txt
```

11. 清理 `pending-commit.json` 和 `tracking-message.txt`。
12. 从 `pending-lines.json` 中移除本次已匹配的行。

### 6. ai-code-stats 查看命令

**命令：**

```bash
node .opencode/skills/ai-code-tracker/scripts/ai-code-stats.js
```

**职责：**

1. 读取当前仓库 `.ai-tracking/*.csv`。
2. 汇总 AI 新增行、总新增行、AI 占比、AI 参与 commit 数和已追踪 commit 数。
3. 支持按作者和日期过滤。
4. 默认展示汇总，并列出最近 10 条明细。

**示例：**

```text
AI Code Stats

Total added lines: 1200
AI added lines: 860
AI ratio: 71.7%
AI-assisted commits: 18
Tracked commits: 24

Recent tracked commits:
2026-05-05  cyd  42/58  a1b2c3d  Implement login validation
```

**可选参数：**

```bash
node .ai-tracking/bin/ai-code-stats.js --author cyd
node .ai-tracking/bin/ai-code-stats.js --since 2026-05-01
node .ai-tracking/bin/ai-code-stats.js --last 20
```

## 文件结构

```text
<repo>/
├── AGENTS.md
├── .opencode/
│   ├── skills/
│   │   └── ai-code-tracker/
│   │       ├── SKILL.md
│   │       ├── scripts/
│   │       │   ├── install.js
│   │       │   ├── commit-stats.js
│   │       │   ├── ai-code-stats.js
│   │       │   ├── verify-opencode-plugin.js
│   │       │   └── opencode-plugin.js
│   │       └── references/
│   │           ├── design.md
│   │           └── opencode-integration.md
│   └── plugins/
│       └── ai-code-tracker.js
├── .ai-tracking/
│   ├── config.json
│   ├── bin/
│   │   ├── commit-stats.js
│   │   └── ai-code-stats.js
│   ├── pending-lines.json
│   ├── pending-commit.json
│   ├── tracking-message.txt
│   ├── cyd.csv
│   └── other-dev.csv
└── .git/hooks/
    ├── pre-commit
    └── post-commit
```

## CSV 结构

```csv
author,ai_tool,ai_lines,total_lines,commit_id,date,message
cyd,42,58,a1b2c3d,2026-05-05,Implement login validation
```

| 列名 | 类型 | 说明 |
|------|------|------|
| author | string | commit 作者名称 |
| ai_tool | string | 首次参与本批 AI 修改的 agent |
| ai_lines | integer | 匹配到 AI 记录的新增行数 |
| total_lines | integer | 本次代码 commit 的新增总行数 |
| commit_id | string | 被统计的代码 commit SHA |
| date | string | commit 日期，格式 YYYY-MM-DD |
| message | string | 被统计代码 commit 的第一行提交信息 |

## 仓库配置

`.ai-tracking/config.json`：

```json
{
  "enabled": true,
  "ignore": [
    ".ai-tracking/**",
    ".git/**",
    "node_modules/**",
    "dist/**",
    "build/**"
  ],
  "count_blank_lines": false,
  "tracking_commit_suffix": "[ai-tracking]",
  "auto_tracking_commit": true,
  "tracking_commit_ci_skip": false
}
```

## 边界情况

- **AI 编辑后人又改了同一行：** 最终暂存区新增行内容与 AI 记录不同，不匹配，计为人工代码。
- **AI 编辑后格式化工具改了缩进或引号：** 内容变化后可能不匹配，计为人工代码。这是行内容匹配方案的已知限制。
- **重复行：** pending lines 按多重集合处理，有多少条记录最多匹配多少条。
- **并发编辑：** 对 pending files 使用 lock file 和原子 rename，避免多个 opencode 事件同时写入时互相覆盖。
- **纯删除 commit：** total_lines 为 0，不生成 pending commit，不创建统计提交。
- **只有 `.ai-tracking/` 变化：** hook 跳过，避免统计提交统计自己。
- **用户已有 git hooks：** 安装器追加受标记包围的调用块，不覆盖已有逻辑。
- **统计提交失败：** 保留 pending 文件并输出错误，用户可修复后运行 `node .opencode/skills/ai-code-tracker/scripts/install.js --repair` 或重新提交。
- **递归提交风险：** 通过 `AI_CODE_TRACKER_SKIP=1`、`AI_CODE_TRACKER_DEPTH=1`、message suffix 检测、暂存区路径校验四层保护避免递归链。
- **CI/CD 噪音：** 默认统计提交不加 `[skip ci]`，但配置允许打开 `tracking_commit_ci_skip` 追加 CI skip 标记。
- **pending-lines 丢失：** 只影响丢失期间 AI 编辑的识别，不影响 git commit。
- **CSV 合并冲突：** 每个 author 独立 CSV，冲突概率较低；冲突时按普通文本冲突处理。

## 约束

- 必须产出项目级 opencode skill：`.opencode/skills/ai-code-tracker/SKILL.md` 是 opencode agent 的 preflight、安装、修复和查看统计入口。
- 当前目标平台是 opencode，且只做项目级安装。
- 追踪依赖 opencode 插件事件和 git hooks。
- 不写入 `~/.config/opencode/`、`~/.local/bin/` 或其他全局位置。
- 统计 commit 自动创建，但不 amend 用户代码 commit。
- 自动创建统计提交时必须设置 `AI_CODE_TRACKER_SKIP=1` 和 `AI_CODE_TRACKER_DEPTH=1`。
- CSV 文件提交到仓库作为永久记录。
- `pending-lines.json`、`pending-commit.json`、`tracking-message.txt` 和 lock files 是本地临时状态，必须 gitignore。
- 脚本应支持 Linux 和 macOS。
- 实现优先使用 Node.js 或 POSIX shell；如果需要 JSON 处理，优先使用 Node.js，避免强依赖 jq。

## 待确认

- opencode 插件监听的最佳事件：优先验证 `file.edited` 是否能拿到编辑前后内容；如果不能，则退回 `tool.execute.after` 并自行读取文件快照。
- 是否需要把 `ai-code-stats` 做成 opencode custom tool。当前设计先提供 CLI，后续可加 opencode tool 包装。
