# midnight-shell 中文本地化包

此项目是 [midnight-shell](https://github.com/dim-ghub/midnight-shell) 的**非官方汉化包**。  
使用**Deepseek V4.1 Flash**模型进行编写  
建议搭配 [Caelestia-zh-cn](https://github.com/u0n0u/caelestia-zh-cn) 使用  
~~ai真的太好用了你们知道吗（逃~~

---

## 这个汉化做了什么

midnight-shell 里有**两套互不相通的翻译机制**，本汉化把两套都覆盖了：

| 机制 | 调用形态 | 目录 | 运行时读取方式 |
|---|---|---|---|
| 项目自研 | `Tr.tr()` / `Tr.trCtx()` / `Tr.trN()` / `Tr.trMarked()` | `zh_CN.po` → `.mo` | `translator.cpp` 里手写的 `.mo` 解析器 |
| Qt 标准 | `qsTr()` | `zh_CN.ts` → `.qm` | 一个 `QTranslator`（由本汉化新增） |

- 自研那套共 **702 条**（92 个 context），Qt 那套共 **717 条**（75 个 context），
  两套**都是 100% 翻译**。
- 词典 `zh_CN.json` 共 **1194 条**（两套的并集，其中 61 条共用）。

**关键限制**：翻译目录必须编译进 `Caelestia.I18n` 模块的 Qt 资源里
（`Translator::resourceDir()` 硬编码为 `:/qt/qml/Caelestia/I18n/`），
所以**没有任何"免编译"的外部加载方式**。要么重新构建，要么用本包里的预编译 `.so`。

---

## 目录结构

```
hanhua-bundle/
├── MANIFEST.txt         生成信息 + 每个文件的 sha256
├── README.md            本文件
├── apply.sh             把汉化应用到一份 midnight-shell 源码树
├── install-prebuilt.sh  直接安装预编译 .so（不用编译）
├── files/               新增文件（保持仓库内相对路径，可直接覆盖）
│   ├── scripts/hanhua.mjs              主 CLI（extract/merge/build/check/status/install/uninstall）
│   ├── scripts/hanhua/lib.mjs          共享库：.po/.ts 解析与生成、qsTr 扫描器、占位符校验
│   ├── scripts/hanhua/extract-qsTr.mjs 独立调用 qsTr 扫描器
│   ├── scripts/hanhua/README.md        工具链英文说明
│   ├── scripts/hanhua/i18n/zh_CN.json  ★ 词典，译文的唯一权威来源
│   ├── plugin/src/Caelestia/I18n/trs/zh_CN.po   自研 Tr 目录（702 条）
│   └── plugin/src/Caelestia/I18n/trs/zh_CN.ts   Qt qsTr 目录（717 条）
├── patches/             对 5 个既有文件的改动（相对 278f5ebc）
│   ├── 01-i18n-cmakelists.patch   注册 .po/.ts 编译并把 .mo/.qm 编进资源（必需）
│   ├── 02-translator-hpp.patch    新增 QTranslator 成员（必需）
│   ├── 03-translator-cpp.patch    安装 QTranslator，让 qsTr 生效（必需）
│   ├── 04-envrc.patch             clazy 改为按需传入（强烈建议，见下）
│   └── 05-gitignore.patch         忽略 raw.pot / .hanhua-work（可选）
├── catalogues/          编译产物，便于直接检视或复用到别处
│   ├── zh_CN.mo   (43,853 字节)
│   └── zh_CN.qm   (53,187 字节)
└── prebuilt/            已编译好的插件（已 strip）
    ├── libcaelestia-i18n.so         899 KB，目录资源在它里面
    └── libcaelestia-i18nplugin.so    18 KB
```

---

## 用法 A：应用源码改造并重新编译（推荐，可长期维护）

```sh
# 1. 准备一份 midnight-shell 源码树
git clone https://github.com/dim-ghub/midnight-shell.git
cd midnight-shell

# 2. 应用汉化
/path/to/hanhua-bundle/apply.sh .        # 参数省略时默认当前目录

# 3. 构建并安装
cmake -B build -G Ninja -DCMAKE_INSTALL_PREFIX=/ -DCMAKE_BUILD_TYPE=RelWithDebInfo
ninja -C build caelestia-i18n
node scripts/hanhua.mjs check            # 应输出 check passed
node scripts/hanhua.mjs install          # 会提示输入 sudo 密码
qs -c caelestia                          # 重启 shell
```

`apply.sh` 是幂等的：重复运行只会覆盖 `files/` 里的文件，已经打过的补丁会被跳过。

后续想改译文，只编辑 `scripts/hanhua/i18n/zh_CN.json`，然后：

```sh
node scripts/hanhua.mjs merge
node scripts/hanhua.mjs check
node scripts/hanhua.mjs install
```

如果 shell 上游更新、新增了字符串，用 `node scripts/hanhua.mjs extract` 把新条目并进
`.po`/`.ts`（**已有译文不会丢**），再补上新增条目的译文即可。

---

## 用法 B：直接装预编译库（最快，不用编译）

```sh
/path/to/hanhua-bundle/install-prebuilt.sh
qs -c caelestia
```

回滚：

```sh
/path/to/hanhua-bundle/install-prebuilt.sh --restore
```

⚠️ **预编译库只适用于 `278f5ebc` 这个源码版本 + Qt 6.11.2**（见 `MANIFEST.txt`）。
shell 一旦更新，插件 ABI/资源可能不匹配，此时请改用法 A。

---

## 注意事项

- **不需要改配置**。语言由 `general.language` 驱动；留空时会用
  `QLocale::system().uiLanguages()` 自动匹配。你的 `LANG=zh_CN.UTF-8`，
  而且 `~/.config/caelestia/shell.json` 里 `general.language` 已经是 `"zh_CN"`。
- **语言名用下划线**：`zh_CN`，不是 `zh-CN`。`Translator::langForLocale()` 做的是精确字符串比较。
- **构建需要 `fish`**：`.po` 由 `scripts/trs.fish compile` 调用 `msgfmt` 编译。
  用法 B 不需要 fish。
- **`qsTr` 提取器是手写的**：`lupdate` 解析不了这个代码库
  （不支持 `v: var` 类型标注、可选链、`??`、模板字面量），全量运行会报 228 个
  `Expected token`，只能捞回 769 条中的 221 条。`lrelease` 不受影响。
- **`.envrc` 的 clazy 问题**：原版 `.envrc` 无条件传 `-DCMAKE_CXX_COMPILER=clazy`。
  没装 clazy 时 configure 会失败，并让 `build/` 停留在"半配置"状态
  （`CMakeFiles/rules.ninja` 丢失，但旧的 `build.ninja` 还在），
  之后任何 `ninja` 都会报
  `build.ninja:35: loading 'CMakeFiles/rules.ninja': No such file or directory`。
  补丁 04 把它改成按需传入。**如果你不打这个补丁，请确保装了 clazy，
  或者先 `direnv deny`。**
- **`scripts/trs-check.py` 需要 python3**：`check` 会尝试调用它，跑不起来只是警告，不影响结果。
- 以 root 身份运行 `install` 会**跳过构建**（避免在 `build/` 里留下 root 属主文件），
  只做拷贝。所以请用普通用户运行，让它自己提权。

---

## 上游同步时怎么复用

```sh
cd midnight-shell
git pull                       # 上游更新
/path/to/hanhua-bundle/apply.sh .   # 重新应用（新文件覆盖 + 补丁尽量打）
```

如果上游改了 `translator.cpp` / `CMakeLists.txt`，对应补丁会显示
`SKIPPED ... (already applied, or the target file differs)` —— 这时需要手动合并。
改动很小，两个文件的 diff 加起来不到 120 行，可直接看 `patches/` 里的内容照抄。
