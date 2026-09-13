# Windows Beta 修复报告

日期：2026-09-13。任务依据：`/Users/z/Downloads/Agent_Windows_Beta_修复任务书.md`。

**当前结论：不建议分发当前产物，等待打包界面启动复核。** F01–F09 的代码修复、针对性回归、Electron 升级和 Windows 验证入口已落地。开发态 Electron、本机资料库测量、实际目录包的原生模块和文档 Worker 检查有通过记录。但是目录包的 GUI 启动测试超时，随后系统工具报告 Mac 锁屏；目前不能确认锁屏是唯一原因，须在解锁后排除启动回归。Windows 安装、升级、真实接口等未执行，不能据此批准普通用户 Beta。

如果解锁后的目录包界面回归通过，可将结论提升为任务书定义的**可生成候选包**。提升为“可受控内测”仍需要 Windows 最终产物的关键链路实测。

## 1. 基线、范围和操作边界

| 项目 | 实际记录 |
| --- | --- |
| 工作区、分支 | `/Users/z/Desktop/agent`，始终在 `main` |
| 开始 commit | `c0d9fe0d72e5de552a21785d9b4c08715aae96af`；工作树干净，领先 `origin/main` 1 个提交 |
| 实现与测试入口截止 commit | `1da28fb06343604137a845740bb70f8c5eaecd31`；本报告在随后的独立文档提交中交付 |
| 保留的已有修改 | 开始 commit 中用户的 `VISION_MODEL_ID = "deepseek-flash"`；未回退或重复计作本轮开发 |
| 实际平台 | macOS 26.2，build 25C56，Darwin 25.2.0，arm64，24 GiB RAM |
| 工具与产品 | Node 26.6.0，pnpm 10.25.0，产品版本保持 `0.1.0-beta.33` |
| Pi | `@earendil-works/pi-coding-agent` / `pi-ai` 保持 0.84.4；未修改 Pi 上游源码 |
| Electron | 37.10.3 → 44.3.0；实际二进制报告 Node 24.20.0、Chromium 152.0.7977.78、modules ABI 149、Node-API 10 |
| 未进行 | 切换分支、重写历史、推送、标签、发布、真实账户 API、真实用户文档处理、Windows 构建和安装实测 |

依赖只通过 pnpm 和标准原生模块构建流程更新，没有手工修改 `node_modules` 源码。所有文档、图片、账号、资料库和升级 profile 都是合成测试数据。用户历史、源文件及既有产物未被清理。

已阅读根目录、desktop、desktop/tests、pi-sdk-driver 的指导文件。先在证据目录的 `PLAN.md` 定义成功标准和针对性验证。`self-test`、`simplify` 技能未在当前环境找到；没有声称调用它们，改用书面验证计划及人工简化审查。未运行完整 core、全 lane 或跨通道全量验收。

原始日志与合成证据目录为：

`/Users/z/Desktop/agent/.codex-tasks/20260913-windows-beta-fixes/`

下文用 **E/** 表示该绝对目录，用 **D/** 表示 `apps/desktop/`。测试目录与日志均保留；根 `docs/` 被忽略，因此报告放在当前可跟踪路径。

## 2. 逐项状态

表中的“验证”只指实际列出的平台和测试层级，不代表 Windows 或真实接口通过。

| ID | 当前状态 | 原因与修改文件 | 实际测试命令 / 用例 | 未完成验证与风险 |
| --- | --- | --- | --- | --- |
| F01 | 已修复，部分验证待执行 | 会话级适配器继续保留主模型；集中处理原生/辅助路由、完整序列化请求预算、历史/当前/队列/重试图片。新增共享 `image-budget.ts`；修改 provider store、image-input、vision-router、stream adapter、session supervisor、main/composer；新增 `vision-settings.ts` 幂等迁移 | U4/U5；E3/E4/E5；真实 Pi 序列化、原生辅助请求数为 0、禁用保留草稿、内置/自定义官方能力、第三方隔离、队列/重启/取消 | 真实 DeepSeek 未执行；新 packaged Flash/Pro GUI 用例尚未完成。内置 Pi 目录只有旧 Flash 别名，未擅自创建或切换主模型 |
| F02 | 已修复并验证 | `permission-mode.ts` 增加跨线程发送限制；`app-store-orchestration.ts` 在真实派发入口检查调用方权限、会话及运行模式；未知调用方按 Plan 拒绝。main bridge、store internals 同步收口 | U1 14 个；E1 3 个实际 Electron 用例，包含 Plan → Auto、直接 Store 绕过和正常 Auto 派发 | 本机合成服务验证，不是 Windows shell 实机证明 |
| F03 | 已修复，部分验证待执行 | 新增 `document-access.ts`、`document-file.ts`；真实路径和显式附件授权；读取前后核对版本/文件身份；接入文档 runtime 和资料库 | U2 的真实 symlink/越界/缺失路径，Windows drive/UNC 词法边界；E2 的实际 runtime 拒绝；Windows junction 用例已进入候选工作流 | Windows junction 实际分支未执行；这是应用授权层，不是抵御恶意本地进程替换的 OS 沙箱 |
| F04 | 已修复，部分验证待执行 | 新增有界 `document-worker-client.ts`；一个可复用 Worker、16 个任务上限、30 秒含排队超时、同版本合并、独立订阅取消、失败重建、192 MiB V8 heap；删除主进程重解析回退 | U2 的真实 Worker/超时/取消/崩溃/exit 0/队列；E2/E4 界面；P3 实际 `app.asar` Worker 读取四种格式 | Windows 和目录包 GUI 故障恢复待执行；Node 模式 Worker 通过不能替代完整窗口交互 |
| F05 | 已修复并验证 | 预览 400k 与完整分块 4M 分离；`complete/charLimit/sourceVersion/nextPart` 贯穿 cache/runtime/附件提示；Excel 保留 sheet/row 范围；修改文档模块、合同类型和附件预处理 | U2、U3、E2/E4；TXT/DOCX/XLSX 的 >400k 尾部可检索/分页；P3 实际包内 Worker；P0 三档资料库实测 | 超过 4M 字符明确标记不完整，不能宣称整本读完；不含 Windows 最终安装验收 |
| F06 | 已修复并验证 | `document-cache.ts`、`library-index.ts` 区分成功、临时失败、永久失败和容量失败；临时退避 1–60 秒，永久失败 24 小时，明确重试跳过失败复用，容量重新评估 | U2/U3：相同文件版本失败后恢复、显式重试、释放容量、旧失败缓存迁移 | 真实共享盘/杀毒软件锁文件行为待 Windows 验证 |
| F07 | 已修复并验证 | `library-index.ts` / `library-runtime.ts` 保留仍授权的已提交快照；离线/部分扫描带状态和旧时间；撤权立即生效；generation 校验、串行原子保存和清空 tombstone 避免旧任务复活 | U2/U3：重建中查询、首次离线未就绪、撤权、删除、换根目录、保存失败、清空竞态；E2；P0 | 部分扫描不能证明文件删除，会保守保留旧片段；真实网络共享目录和长期使用未测 |
| F08 | 已修复并验证 | 新增 `document-zip.ts`，按受限 ZIP 目录和内容类型识别；4096 entries、32 MiB/entry、64 MiB 总展开、压缩比 1000；禁止任意磁盘释放 | U2 合法 OOXML 的关键部件排在 12k padding 后、普通 ZIP/损坏/超限；E2；P3 包内 DOCX/XLSX | 覆盖合成及仓库夹具，不代表所有 Office 版本和加密变种 |
| F09 | 已修复并验证 | `update-checker.ts` 用 SemVer 选择最高适配版本；stable/同预发布通道策略；校验已上传且非空的平台架构资产和同仓库 URL；最多 5×30 条，覆盖不足显式报错；UI/i18n 同步 | U6 18 个 Node/夹具用例；E3 的实际设置界面/IPC/main；乱序、beta.9/10、缺包、分页、鉴权、超时 | 未验证真实 GitHub 分发源的权限/可用性，仍是打开发布页，不自动安装 |
| R01 | 已修复，部分验证待执行 | Electron/package/builder/lock 同步为 44.3.0；必要的 node-abi 4.35.0 scoped override；异步剪贴板适配；密文不可读时禁止覆盖、凭据文件原子替换；实际运行时/原生探针脚本 | E4 12 通过/1 Windows 条件跳过；E5 4 次真实剪贴板通过；E6 当前源码在 37→44 的合成 profile 升级通过；U7；P1/P2/P3 | 目录包 GUI 启动超时尚待解锁排除回归；Windows `.node`、DPAPI、真正旧安装包升级未执行；37→44 开发二进制测试不是安装升级 |
| R02 | 环境受阻 | 两条 Windows 工作流增加原生 Flash、权限/junction/凭据、包内文档/终端、实际 Electron 元数据和日志入口；新增 production specs、native probe、资料库测量；README 更新 | 静态 YAML/路径检查、9 个 production 用例发现；P1–P3、P0 本机已执行 | 未触发 Actions；没有 Windows EXE/NSIS/portable 产物或安装证据；Mac GUI 批次 3 超时、2 未运行，单例诊断也超时 |

## 3. 关键实现和迁移

### 图片与模型

共享预算用于文件选择、拖拽、粘贴、Store 合并附件、driver 提交、队列、重试，以及 SDK 最后 `onPayload` 变换后的实际请求。默认 8 图/消息、10 MiB/图、20 MiB/消息、32 MiB 序列化请求、8192 边长、20MP。完整请求计入历史图片、Base64、文本和 JSON，不通过删图或外部上传绕过限制。

支持 image 的主模型保持原图和原始流，不走辅助服务、不产生辅助费用；辅助开关只影响文本模型辅助路线。全局禁图限制两条路线。拒绝时保留草稿/附件。会话模型配置只在安全时点刷新，正在运行的请求保持原配置。

旧辅助模型名称迁移为 `deepseek-flash`，显式 `enabled: false` 保留，写入失败保留原文件并在下次启动重试。历史 evidence 的旧模型名称、来源和费用不改写。官方自定义 endpoint 的缺失能力可补齐，明确 `input: ["text"]` 不覆盖；第三方同名模型不继承官方默认。内置 `deepseek-v4-flash` 通过 Pi 支持的 `models.json.modelOverrides` 补能力，尊重 endpoint/API/input 显式覆盖。Pi 0.84.4 未提供的内置 `deepseek-flash` 没有被虚构进目录。

本轮重新核对 [DeepSeek 模型文档](https://api-docs.deepseek.com/quick_start/pricing/) 与 [视觉协议](https://api-docs.deepseek.com/guides/vision/)，保存于 E/deepseek-models.txt、E/deepseek-vision.txt。官方文档的 48 MiB 内联上限高于应用的 32 MiB 保守限制；文档核对不是一次真实 API 成功记录。

### 文档与资料库

单输入 64 MiB，完整正文最多 4M 字符，附件预览最多 400k，分块约 4k；文档内存缓存 4.5M 字符/128 条。资料库默认最多 8M 字符，Light 4M；扫描限制 2048 文件、10000 条目录项、32 层，单扫描 I/O 5 秒超时。达到容量时列明原因，允许释放空间后重试。

索引版本升级为 2。旧成功记录若没有完整性信息则重新构建；旧失败记录进入可重试分类。大于当前安全读取预算的旧索引不一次性读入主进程。旧文件/备份保留，新快照采用现有原子写入与备份机制。只有仍授权的快照可被检索；离线内容带原索引时间，不能冒称刚读过源文件。清空写空 tombstone，防止备份或迟到任务恢复已撤销内容。

`sourceVersion` 使旧分页定位在源文件变化后明确失败。扫描不可靠时保留旧快照；可靠扫描确认删除后移除。失败、重建、撤权及清空竞态均有针对性回归。

### Electron 与凭据

[Electron 官方支持时间表](https://releases.electronjs.org/schedule)（E/electron-schedule.txt）记录：37 系列已于 2026-01-13 EOL；44 于 2026-08-25 稳定，EOL 2027-03-02。本轮安装并实际运行 44.3.0，没有全项目依赖升级。

44 的 clipboard API 改为异步。删除 main/preload/renderer 三处重复图片快捷键路径，改走 Chromium paste → 共享文件预算；终端文本改为异步 IPC，并在返回后核对仍是同一终端。真实测试发现虚拟剪贴板的 `items`、`files` 两个视图可能有不同 `lastModified`；现在优先使用一个完整文件视图，保留 fallback，避免重复附件。

凭据写入前要求现有密文全部可读，锁定/损坏/解密失败时拒绝替换，保留原密文和待迁移来源；写入采用同目录 staging + flush + rename，失败保留旧目的文件及诊断 stage。启动迁移失败给出错误，不自动清空。U7 使用模拟密码服务验证故障分支；E6 才是实际 macOS safeStorage 的合成密钥验证。

第一次目录打包暴露 node-abi 4.28.0 不识别 Electron 44，采用 `@electron/rebuild>node-abi: 4.35.0` 的窄 override。映射和实际二进制均报告 ABI 149，随后标准原生重建成功。Windows `npmRebuild=false` 保留：node-pty 1.1 使用 Node-API 并附带 Windows prebuild；新增检查要求 ConPTY/WinPTY `.node` 和伴随 DLL/EXE 齐全，并在同 OS 上调用实际包内运行时探针。**本轮只执行了 macOS 分支。**

## 4. 实际验证记录

### 4.1 命令记法

以下缩写仅用于排版，不表示创建了新的测试 lane：

- `PW` = `pnpm exec playwright test -c apps/desktop/playwright.config.ts`。
- `UNIT(name…)` = `PW apps/desktop/tests/unit/<name>.spec.ts …`。
- `CORE(name…)` = 同样指定 `apps/desktop/tests/core/<name>.spec.ts`，不是整套 core。
- `PROD(name…)` = 同样指定 `apps/desktop/tests/production/<name>.spec.ts`。
- `DRIVER(name…)` = `pnpm --filter @pi-gui/pi-sdk-driver exec node --test test/<name>.test.mts …`。
- 所有 Playwright 结果使用 E/ 下独立 `--output` 目录，名称与相应日志前缀一致；早期目录在 E/evidence/ 下。原始日志中的完整 runner 参数、用例标题及 trace 路径优先于缩写。

后续运行均记录到新的目录。通过数包含重跑，**不相加为独立用例总数**。下面“通过”仅表示相应命令的结果。

### 4.2 逻辑、请求夹具与开发 Electron

| 编号 | 实际命令 / 用例集合 | 结果、退出码 | 原始日志（E/） |
| --- | --- | --- | --- |
| U1 | `UNIT(permission, orchestration-permission)` | 14 通过；0 | permission-unit-v2.log |
| U2a | `UNIT(document-access)` | 2 通过；0；已包含于 U2 | document-access.log |
| U2 | `UNIT(document-access, document-cache, document-extract, document-long, document-worker, library-index, library-search, xlsx-reader)` | 42 通过；0；实际 built Worker + 合成容器 | document-library-unit-v2.log |
| U3 | `UNIT(attachment-preamble, library-index, library-search)` | 20 通过；0；与 U2 有重叠 | library-boundaries.log |
| U4 | `DRIVER(custom-provider-images, image-budget, image-input, vision-client, vision-router, vision-stream-adapter)` | 39 通过；0；本地真实 SDK 序列化，不是真实 API | images-driver-initial.log |
| U4b | `DRIVER(image-budget, vision-stream-adapter)` | 10 通过；0；最终适配器小改后的重跑 | images-driver-final.log |
| U5 | `UNIT(vision-store, vision-image, vision-settings)` | 8 通过；0 | images-unit-initial.log |
| U5b | `UNIT(vision-settings)` | 2 通过；0；增加写失败恢复，含重叠 | images-settings-final.log |
| U6 | `PW apps/desktop/tests/unit/update-checker.spec.ts apps/desktop/tests/core/update-checker.spec.ts` | 18 通过；0；后一个文件也是 Node 单元测试，不能算 Electron | update-unit.log |
| U7a | `UNIT(composer-clipboard)` | 2 通过；0；不同时间戳的双视图去重、items fallback | clipboard-unit.log |
| U7b | `UNIT(secure-auth-recovery)` | 3 通过；0；不可解密/损坏/加密失败/恢复/正常删除 | secure-auth-recovery.log |
| E1 | `pnpm --filter @pi-gui/desktop run test:e2e:runner -- apps/desktop/tests/core/orchestration-runtime-tools.spec.ts apps/desktop/tests/core/permission-mode.spec.ts --output=…` | 3 通过；0；实际 Electron + 本地服务 | permission-electron.log |
| E2 | 指定 `CORE(attach-document, library-runtime, document-regressions)`，经现有 runner 先构建 | 6 通过；0 | document-electron.log |
| E3a | 指定 `CORE(custom-model-images, image-budgets, vision-routing)` | 17 通过、1 失败；1；失败及修正见 4.5 | images-electron-initial.log |
| E3b | custom-model-images 中内置 Flash 单例重跑 | 1 通过；0 | images-builtin-electron.log |
| E3c | `CORE(custom-model-images, update-settings)` | 6 通过；0；覆盖修正后的 5 个图片能力用例 | images-update-electron.log |
| E4 | `PI_APP_TEST_MODE=background CORE(custom-model-images, document-regressions, integrated-terminal)` | 12 通过、1 跳过；0；仅跳过 macOS 上不适用的 Windows Control 键用例 | electron44-core.log |
| E5 | `PI_APP_TEST_MODE=foreground PW apps/desktop/tests/native/paste.spec.ts --repeat-each=2 --retries=0 --output=…/electron44-native-paste-v4` | 4 次通过；0；2 个不同用例各执行 2 次，真实 OS 剪贴板 | electron44-native-paste-v4.log |
| E6 | `PI_APP_TEST_MODE=background PI_APP_TEST_OLD_ELECTRON=E/electron37-runtime/Electron.app/Contents/MacOS/Electron PROD(runtime-upgrade) --output=…/runtime-upgrade-v4` | 1 通过；0；实际 37/44、safeStorage、两窗口、草稿、2 次本地 HTTP | runtime-upgrade-v4.log |

E6 在两个 Electron 二进制上使用**当前源码**和同一合成 profile，不是运行上一正式安装包，也不证明不同签名身份之间的 Keychain 或 Windows DPAPI 升级。E4 后共享 PNG 夹具已修正，并完成 E5；终端聚焦时的图片剪贴板分支没有在该夹具修正后再单独重跑。

### 4.3 构建、版本、静态与产物检查

| 命令 | 结果、退出码 | 日志（E/） |
| --- | --- | --- |
| `pnpm --filter @pi-gui/desktop build` | 通过；0；包含 shared packages、notification helper、main/preload/renderer | document-build.log、document-build-v2.log、electron44-build-v2.log、electron44-build-v3.log、package-desktop-build.log |
| `pnpm --filter @pi-gui/session-driver --filter @pi-gui/pi-sdk-driver build`；后续 `pnpm --filter @pi-gui/pi-sdk-driver build` | 通过；0 | images-build-initial.log、images-build-v2.log、images-build-final.log |
| `pnpm --filter @pi-gui/desktop typecheck` | 最终通过；0 | permission-typecheck.log、document-typecheck-v2.log、document-library-typecheck-final.log、images-typecheck-v2.log、images-update-typecheck.log、electron-upgrade-typecheck-v2.log、electron44-typecheck-v3.log、electron44-typecheck-v4.log |
| pnpm 更新 @types/semver 7.7.1、Electron 44.3.0 | 安装日志完成；0；原调用参数未随日志保留，不猜测重构 | update-semver-install.log、electron-upgrade-install.log |
| `pnpm install --ignore-scripts`（新增 ABI override 后） | 通过；0 | electron-abi-install.log |
| `pnpm install --frozen-lockfile --ignore-scripts` | 通过；0；只证明锁文件安装一致性；实际原生重建另见 P1 | frozen-lock-install.log |
| `node apps/desktop/scripts/inspect-electron-runtime.mjs --output E/electron-runtime-v2.json` | 通过；0；实际本地二进制 44.3.0 / ABI 149 | electron-runtime-v2.log；早期 electron-runtime.log |
| Node 调用 `node-abi.getAbi("44.3.0", "electron")` | 返回 149；0，与二进制一致 | electron-abi-verification.log |
| `pnpm verify:pi-version` | 通过；0，仍为 0.84.4 | pi-version-consistency.log |
| `pnpm --dir apps/desktop run verify:launcher-contract` | 4 条检查通过；0；当前 macOS 的 argv/PATH/shim 合同 | launcher-contract.log |
| Node/YAML 解析两条修改后的 workflow，并核对引用的 spec/script 存在 | 通过；0；没有执行 PowerShell、Actions 或 Windows | workflow-static-check.log、workflow-static-check-final.log |
| `PW` 指定六个 production 文件并加 `--list` | 发现 9 个用例；执行 0；退出 0 | production-entry-discovery.log |
| `git diff --check`；`node --check` 检查修改后的 runtime/packaging/probe 脚本 | 通过；0；静态检查，无功能用例数 | 工具执行记录 |
| Python 核对报告文件清单、状态行、日志存在性、用户模型常量和产物 SHA-256；`git diff --check c0d9fe0 HEAD`、`git diff --cached --check` | 通过；0；仅检查交付记录一致性，没有新增应用通过数 | report-audit.log |

### 4.4 目录包与测量命令

**P0**：

```bash
PI_APP_TEST_MODE=background PI_APP_TEST_LIBRARY_PROFILE=1 pnpm exec playwright test -c apps/desktop/playwright.config.ts apps/desktop/tests/production/library-capacity-profile.spec.ts --output=.codex-tasks/20260913-windows-beta-fixes/library-capacity-profile-v3
```

3 通过，退出 0；E/library-capacity-profile-v3.log 和每档 `measurement.json` / screenshot。v2 也是 3 通过，v3 增加全进程 working-set 采样并把最终样本计入 peak；这两轮不是 6 个独立场景。

**P1**：

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --dir apps/desktop exec electron-builder --mac --dir --publish never -c.mac.identity=- -c.mac.notarize=false -c.directories.output=/Users/z/Desktop/agent/.codex-tasks/20260913-windows-beta-fixes/mac-package-3b5864e
```

通过，退出 0，E/mac-package-v2.log；执行了标准 node-pty 重建。旧 ABI 下的首次尝试退出 1，E/mac-package.log，旧输出目录 `mac-package-c95dd76` 保留。构建出现 pnpm hoisting 的 dependency-not-found 提示；随后独立 imports 和实际 native/Worker 检查通过，未把提示直接当作功能通过或失败。

**P2**：

```bash
PI_APP_TEST_RELEASE_DIR=/Users/z/Desktop/agent/.codex-tasks/20260913-windows-beta-fixes/mac-package-3b5864e PI_APP_KEEP_PACKAGE_DIAGNOSTICS=1 pnpm --dir apps/desktop run verify:packaged-runtime-deps
node apps/desktop/scripts/inspect-electron-runtime.mjs --executable /Users/z/Desktop/agent/.codex-tasks/20260913-windows-beta-fixes/mac-package-3b5864e/mac-arm64/Agent.app/Contents/MacOS/Agent --output .codex-tasks/20260913-windows-beta-fixes/mac-package-3b5864e/electron-runtime.json
codesign --verify --deep --strict --verbose=2 /Users/z/Desktop/agent/.codex-tasks/20260913-windows-beta-fixes/mac-package-3b5864e/mac-arm64/Agent.app
codesign -dv --verbose=4 /Users/z/Desktop/agent/.codex-tasks/20260913-windows-beta-fixes/mac-package-3b5864e/mac-arm64/Agent.app
```

均退出 0。日志为 E/mac-packaged-dependencies-v2.log、E/mac-packaged-runtime.log、E/mac-signature-verify.log、E/mac-signature-details.log。dependencies-v2 实际启动目录包 Electron 的 Node 模式，验证 Photon 8×8 PNG 解码，以及从 `app.asar` 加载 node-pty、输出、退出；初版 mac-packaged-dependencies.log 仅有静态/import 检查。诊断解包目录保留，路径在日志中。

**P3**：

```bash
ELECTRON_RUN_AS_NODE=1 /Users/z/Desktop/agent/.codex-tasks/20260913-windows-beta-fixes/mac-package-3b5864e/mac-arm64/Agent.app/Contents/MacOS/Agent .codex-tasks/20260913-windows-beta-fixes/packaged-document-node.cjs
```

退出 0，E/mac-document-node-v4.log。实际 `app.asar/out/main/document-worker.mjs` 在真实 Worker 线程中处理合成 buffer：TXT 528,033、DOCX 528,034、XLSX 535,367 个正文字符，预览各 400,000，尾部 marker 可达；PDF 2 页、93 个正文字符。四种格式 `complete: true`。这是**包内 Worker / ESM / parser 路径证据**，不包含 main 调用方授权、GUI 和文件选择操作。v3 先通过前三种，v4 加 PDF；不是 7 种格式。

探针和合成数据均在 E/ 下。新数据通过已有 `tests/helpers/long-documents.ts` 的 `makeLongDocuments()`（由本地 jiti 加载）生成，不复用已被负例测试改写的文件。独立 PTY 调查命令使用 E/packaged-native-node.cjs，修正后的 E/mac-native-node-v2.log 退出 0；可复用的最终 native 探针已纳入源码和 P2。

**P4（未通过）**：

```bash
PI_APP_TEST_RELEASE_DIR=/Users/z/Desktop/agent/.codex-tasks/20260913-windows-beta-fixes/mac-package-3b5864e PI_APP_TEST_MODE=background PI_APP_TEST_PACKAGED_DOCUMENTS=1 PI_APP_TEST_PACKAGED_NATIVE_VISION=1 PI_APP_TEST_PACKAGED_VISION=1 pnpm exec playwright test -c apps/desktop/playwright.config.ts apps/desktop/tests/production/document-packaged.spec.ts apps/desktop/tests/production/vision-native-packaged.spec.ts apps/desktop/tests/production/vision-routing-packaged.spec.ts apps/desktop/tests/production/packaged-terminal.spec.ts --output=.codex-tasks/20260913-windows-beta-fixes/mac-packaged-targeted
```

3 个用例在 launch 阶段各超时 60 秒，2 个视觉用例未运行；为调查共同启动问题发 SIGINT，退出 **130**。E/mac-packaged-targeted.log 保留实际失败、trace。随后加 `DEBUG=pw:browser`，只选文档首例、`--timeout=20000`，再次超时，退出 1，E/mac-launch-diagnostic.log。日志显示 Node inspector 已连接，但 browser debugging WebSocket 未完成连接。

系统工具 `cua.getState()` 报告 Mac 锁定且无法自动解锁。已异步请用户手动解锁，没有索取密码或绕过保护。详见 E/desktop-environment-blocker.txt。**锁屏是已确认的环境状态，但不能仅凭它断言包没有启动问题。** 解锁后的重跑仍是关闭该问题的条件。后续为文档用例增加的 PDF 断言、终端行级输出断言也尚未通过 GUI 执行。

### 4.5 失败与修正保留记录

| 日志（E/） | 当次结果 | 原因和后续证据 |
| --- | --- | --- |
| permission-unit.log | 加载失败；1，无完成用例 | 直接导入 Store 遇 Pi ESM/CJS exports；抽取共享权限 guard 做单元测试，Store 真实入口改由 E1 验证；U1 14 通过 |
| document-typecheck-initial.log | 失败；2 | PDF destroy API、参数命名/调用、LibraryStatus 合同类型；修正后 typecheck-v2 通过 |
| document-unit-initial.log | 22 通过、3 失败；1 | PDF 清理调用错误；改为 `document.loadingTask.destroy()`，U2 42 通过 |
| document-library-typecheck.log | 失败；2 | `typeof this` 类型位置错误；document-library-typecheck-final 通过 |
| images-typecheck-initial.log | 失败；2 | 未 await 的 Store state；修正后通过 |
| images-electron-initial.log | 17 通过、1 失败；1 | 内置-only 夹具未符合桌面“app-managed endpoint”可见性约定，Start 不可用；修正夹具只标记 endpoint，不提供模型定义，仍要求真实 Pi 内置模型；E3b/E3c 通过 |
| electron-upgrade-typecheck.log | 失败；2 | 44 已移除同步 `clipboard.readImage`；适配后通过 |
| electron44-native-paste.log、clipboard-diagnostic.log、electron44-native-paste-v2.log | 分别 2、1、2 失败；均 1 | 原夹具图片路径不存在，随后旧 1px PNG 不能被原生剪贴板解码；换用 Photon 已验证的 8×8 PNG，并断言系统剪贴板确有 image/png |
| electron44-native-paste-v3.log | 1 flaky、1 passed；0 | 真实暴露双视图不同时间戳造成两附件，重试偶然通过不作稳定验收；修改单一文件视图后 E5 4 次均通过、无重试，U7a 通过 |
| runtime-upgrade.log | 1 失败；1 | 自动标题请求影响夹具请求数；使用已有 deferred-title hook |
| runtime-upgrade-v2.log | 1 失败；1 | hook 在窗口初始化前调用；移动到 firstWindow 后 |
| runtime-upgrade-v3.log | 1 失败；1 | 后台窗口快捷键未创建第二窗口；改用现有共享 application-menu helper；v4 通过 |
| library-capacity-profile.log | 3 失败；1 | 异步受控开关的 `.check()` 立即断言；等待文件夹保存，再点击并等待 checked；v2/v3 各 3 通过 |
| mac-package.log | 构建失败；1 | node-abi 4.28 不识别 Electron 44；窄依赖更新后 P1 通过 |
| mac-packaged-targeted.log、mac-launch-diagnostic.log | 3 超时/2 未运行；130，单例超时；1 | 尚未关闭，见 P4；不改成跳过获取绿色结果 |
| mac-native-node.log | 失败；1 | 调查脚本从 `.asar.unpacked` 直接加载 JS，node-pty 再替换路径产生双 unpacked；改为真实应用使用的 `.asar` 入口，v2 和 P2 通过 |
| mac-document-node.log、mac-document-node-v2.log | 失败；均 1 | 误复用先前 stale-version 负例已经改成 20 字节的合成文件；未放宽断言，使用共享生成器重新生成数据，v3/v4 通过 |
| report-audit-initial.log | 报告核对脚本失败；1 | 脚本误将 `git diff --no-index --check` 对新增文件返回的差异码 1 当成空白错误；命令无诊断输出。暂存明确指定的报告后改用 `git diff --cached --check`，report-audit.log 通过；不是应用测试失败 |

## 5. 三档合成资料库测量

以下为 P0 v3 的实际一次测量，不是性能承诺。全程合成 TXT，8 文件/档；接近上限一档额外加入 560,000 字符文件以触发容量拒绝，峰值包含这次尝试。

| 档位 | 文件总 bytes | 实际收录正文字符 | parts | 启动至可用 ms | 首次重建 ms | 主进程峰值 RSS MiB | 全进程 working-set 总和峰值 MiB | 5 次搜索范围 ms | main/renderer 最大额外计时延迟 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 小 | 10,432 | 8,000 | 8 | 910.3 | 292.7 | 272.0 | 585.1 | 0.83–2.36 | 2.18 / 13.50 |
| 中 | 1,046,144 | 800,000 | 200 | 864.4 | 310.2 | 303.8 | 615.0 | 1.90–3.19 | 2.60 / 8.90 |
| 近上限 | 10,330,720 | 7,900,000 | 1,976 | 867.2 | 353.2 | 584.2 | 896.9 | 6.27–9.48 | 24.04 / 13.20 |

字符数来自实际落盘完整 searchable parts 的 UTF-16 code units，不把输入文件大小冒充提取量。主进程 RSS 包含 Worker 线程；heapUsed 是主 V8 isolate。main/renderer 定时器约每 20ms 采样，Electron 全进程 working set 每 100ms 采样，求和可能重复计入共享页，不能当作独占内存。启动数字是隔离 profile 的启动至可用，并非清空 OS 文件缓存后的冷启动。

状态 IPC 最大耗时分别约 1.81/1.89/3.39ms。内存和 UI 数值仅属于当前 24 GiB Mac；没有 Windows 4/8 GB 机器、换页卡顿、长期运行或真实网络盘性能结论。取消的有界行为由 U2 验证，不把单元测试的时间冒充 Windows 人机响应。

## 6. 产物、哈希与签名

唯一新生成的可运行包是 macOS **目录包**：

`E/mac-package-3b5864e/mac-arm64/Agent.app`

对应源码/依赖 commit 为 `3b5864e`，后续 `1da28fb` 只添加验证脚本、测试和说明，不改变打入包内的产品代码。`E/mac-package-3b5864e/build-info.json`、`electron-runtime.json`、`SHA256SUMS.txt` 已生成。

| 文件（相对该 .app） | SHA-256 |
| --- | --- |
| Contents/MacOS/Agent | `a6a2e7c938c4ed2b25f59bd293aec39dc53825569ce6cb4daee39629c489f0c1` |
| Contents/Resources/app.asar | `cb141c95d398ee7c459eccb9848a6324e82108eafa83571c6a77851c979a9da4` |
| node-pty build/Release/pty.node（app.asar.unpacked） | `7f3979e2bd2a49358c079188eab29b1ef18b5b0a9f79a7e6a9fa53f991d66b86` |
| node-pty build/Release/spawn-helper（app.asar.unpacked） | `5c6d6926902f1c5be0ad5991f3514e81931acadc57022a1b453e6774f376b7a9` |
| photon_rs_bg.wasm（app.asar.unpacked） | `10468181565c56004c867f3a4af96f89a0ef5a63a72f2b5fb12c1f1992a3615c` |

`codesign --verify --deep --strict` 退出 0，但签名实际是 **ad-hoc**，TeamIdentifier 未设置，明确关闭了 notarization。不是 Developer ID 签名或公证产物，不是安装或 Gatekeeper 验收。

本轮**没有生成** Windows setup.exe、portable.exe、它们的 SHA256SUMS 或 Windows build-info；没有可以提供的对应下载链接。工作流中原本就有区分两种文件名、哈希和 Authenticode 查询，这些不是本轮新实现。本轮新增的是实际运行时版本、针对性验证及日志入口。

## 7. 未执行项目与后续入口

| 未执行 / 未完成项 | 原因与可重放入口 |
| --- | --- |
| 当前 macOS 目录包 GUI | 先手动解锁，再重放 P4；必须实际看到五个用例结果，不能以 P2/P3 替代 |
| Windows 开发/目录 EXE | 本机是 Mac；两条 workflow 仅完成静态检查，没有触发；可在已授权的 Windows runner 运行新增入口 |
| Windows 构建、NSIS、portable 启动器 | 按用户“Windows 打包暂不用实测”约束未执行；后续分别执行 `pnpm package:win`、依赖验证、目录 EXE、setup 和 portable 运行验收 |
| Win10/Win11、标准用户、中文/空格用户名、Git/Git Bash/WSL、junction、共享盘 | 尚无相应 Windows OS build 和环境证据；不能用词法单元测试或 macOS symlink 代替 |
| 旧候选安装升级、重装、卸载、用户数据保留 | 未执行最终安装包操作；E6 只验证当前源码的开发运行时和合成 profile |
| DeepSeek 真实 API | 无本轮真实账户授权/专用凭据，未调用；后续单独 opt-in `PI_APP_TEST_LIVE_VISION=1` 与专用测试 key，再运行 `packages/pi-sdk-driver/test/vision-live.test.mts` |
| 实际 GitHub 更新源 | 本轮仅本地 release 响应夹具；未验证真实私有仓库权限、正式签名资产和下载 |
| 4 GB / 8 GB、长期内存、应用退出全进程残留 | 未在目标 Windows 机器测量；P0 只是当前 Mac 的短时合成测量；native probe 自身已正常退出 |
| 完整 core / 跨 lane 全量验收 | 未获当前请求的明确授权，未执行 |

Windows 入口已使用本地 synthetic HTTP，包含 native Flash 图片/历史/队列/Stop/503 重试/重启以及 Pro 辅助证据/取消/重试。fixture 通过只能证明对应协议及客户端行为，不能写成服务商接口或安装包实机通过。

## 8. 提交与简化审查

| commit | 聚焦范围 |
| --- | --- |
| 2317932 | F02，实际派发入口权限 |
| 22728eb | F03–F08，文档授权、Worker、完整性、索引 |
| 32882db | F01，图片预算与官方能力/设置兼容 |
| f1b4a43 | F09，更新候选和分页 |
| c95dd76 | R01，Electron 44、剪贴板、凭据保护 |
| 3b5864e | R01 打包发现的 ABI registry 依赖补充 |
| 1da28fb | R02，Windows 验证入口、实际原生探针、容量测量 |

人工简化审查去掉重复图片快捷键/IPC 路径，收敛剪贴板文件视图、统一预算和授权入口，复用测试 harness 与文件生成器，移除陈旧注释/无效依赖。没有为获得绿色结果禁用权限、sandbox、contextIsolation，或放宽失败用例的关键断言。仍需复核的 GUI 启动问题保留为未关闭项。

## 9. 完整修改文件列表

以下列表由 `git diff --name-status c0d9fe0 1da28fb` 生成：92 个文件，25 个新增、67 个修改；A 为新增，M 为修改。另新增本报告 `apps/desktop/windows-beta-fix-report.md`，共 93 个文件。路径相对 `/Users/z/Desktop/agent`。

```text
M	.github/workflows/deepseek-vision-windows.yml
M	.github/workflows/windows-beta-candidate.yml
M	apps/desktop/README.md
M	apps/desktop/electron-builder.yml
M	apps/desktop/electron/app-store-composer.ts
M	apps/desktop/electron/app-store-internals.ts
M	apps/desktop/electron/app-store-orchestration.ts
M	apps/desktop/electron/app-store-utils.ts
A	apps/desktop/electron/document-access.ts
M	apps/desktop/electron/document-attachments.ts
M	apps/desktop/electron/document-cache.ts
M	apps/desktop/electron/document-extract.ts
A	apps/desktop/electron/document-file.ts
A	apps/desktop/electron/document-limits.ts
M	apps/desktop/electron/document-runtime.ts
A	apps/desktop/electron/document-worker-client.ts
M	apps/desktop/electron/document-worker.ts
A	apps/desktop/electron/document-zip.ts
M	apps/desktop/electron/library-index.ts
M	apps/desktop/electron/library-runtime.ts
M	apps/desktop/electron/main.ts
M	apps/desktop/electron/permission-mode.ts
M	apps/desktop/electron/preload.ts
M	apps/desktop/electron/secure-auth-backend.ts
M	apps/desktop/electron/update-checker.ts
M	apps/desktop/electron/vision-image-worker.ts
M	apps/desktop/electron/vision-image.ts
M	apps/desktop/electron/vision-service.ts
A	apps/desktop/electron/vision-settings.ts
M	apps/desktop/electron/xlsx-reader.ts
M	apps/desktop/package.json
M	apps/desktop/scripts/assert-packaged-runtime-deps.mjs
M	apps/desktop/scripts/assert-runtime-model-registry.mjs
A	apps/desktop/scripts/inspect-electron-runtime.mjs
A	apps/desktop/scripts/probe-packaged-native.cjs
M	apps/desktop/src/App.tsx
M	apps/desktop/src/composer-attachment-status.ts
M	apps/desktop/src/composer-attachments.ts
M	apps/desktop/src/hooks/use-new-thread-controller.tsx
M	apps/desktop/src/hooks/use-session-composer.tsx
M	apps/desktop/src/i18n/en.ts
M	apps/desktop/src/i18n/zh.ts
M	apps/desktop/src/ipc.ts
M	apps/desktop/src/settings-updates-row.tsx
M	apps/desktop/src/terminal-panel.tsx
M	apps/desktop/src/update-state.ts
M	apps/desktop/tests/core/custom-model-images.spec.ts
A	apps/desktop/tests/core/document-regressions.spec.ts
A	apps/desktop/tests/core/image-budgets.spec.ts
M	apps/desktop/tests/core/integrated-terminal.spec.ts
M	apps/desktop/tests/core/orchestration-runtime-tools.spec.ts
M	apps/desktop/tests/core/update-settings.spec.ts
M	apps/desktop/tests/core/vision-routing.spec.ts
A	apps/desktop/tests/helpers/document-worker.ts
M	apps/desktop/tests/helpers/electron-app.ts
A	apps/desktop/tests/helpers/long-documents.ts
M	apps/desktop/tests/helpers/vision-fixture.ts
A	apps/desktop/tests/production/document-packaged.spec.ts
A	apps/desktop/tests/production/library-capacity-profile.spec.ts
M	apps/desktop/tests/production/packaged-terminal.spec.ts
A	apps/desktop/tests/production/runtime-upgrade.spec.ts
A	apps/desktop/tests/production/vision-native-packaged.spec.ts
M	apps/desktop/tests/production/vision-routing-packaged.spec.ts
M	apps/desktop/tests/unit/attachment-preamble.spec.ts
A	apps/desktop/tests/unit/composer-clipboard.spec.ts
A	apps/desktop/tests/unit/document-access.spec.ts
M	apps/desktop/tests/unit/document-cache.spec.ts
A	apps/desktop/tests/unit/document-long.spec.ts
A	apps/desktop/tests/unit/document-worker.spec.ts
M	apps/desktop/tests/unit/library-index.spec.ts
A	apps/desktop/tests/unit/orchestration-permission.spec.ts
M	apps/desktop/tests/unit/permission.spec.ts
A	apps/desktop/tests/unit/secure-auth-recovery.spec.ts
M	apps/desktop/tests/unit/update-checker.spec.ts
A	apps/desktop/tests/unit/vision-settings.spec.ts
M	packages/pi-sdk-driver/src/custom-provider-store.ts
M	packages/pi-sdk-driver/src/custom-provider-types.ts
M	packages/pi-sdk-driver/src/image-input.ts
M	packages/pi-sdk-driver/src/pi-compat/vision-stream-adapter.ts
M	packages/pi-sdk-driver/src/session-supervisor-utils.ts
M	packages/pi-sdk-driver/src/session-supervisor.ts
M	packages/pi-sdk-driver/src/vendor/session-driver.d.ts
M	packages/pi-sdk-driver/src/vision-errors.ts
M	packages/pi-sdk-driver/src/vision-router.ts
M	packages/pi-sdk-driver/test/custom-provider-images.test.mts
A	packages/pi-sdk-driver/test/image-budget.test.mts
M	packages/pi-sdk-driver/test/image-input.test.mts
M	packages/session-driver/package.json
A	packages/session-driver/src/image-budget.ts
M	packages/session-driver/src/types.ts
M	pnpm-lock.yaml
M	pnpm-workspace.yaml
```
