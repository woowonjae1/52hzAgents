# A1 工作包：SQLite 驱动选型与环境验证报告

- **验证时间**：2026-10-30
- **验证环境**：Windows 11 x64 (Build 22621)
- **关联架构**：M1 数据可靠性里程碑 / A 工作包（SQLite 数据层与旧数据迁移）

---

## 1. 实际运行版本

| 运行环境 | Node.js 版本 | Electron 版本 | 内置 SQLite 版本 | 运行形态 |
| :--- | :--- | :--- | :--- | :--- |
| **开发测试宿主** | `v22.22.0` | N/A (CLI) | `3.50.4` | `node workspace/desktop/...` |
| **Electron 开发态** | `v24.22.1` | `45.1.0` | `3.53.4` | `electron .` |
| **打包交付态** | `v24.22.1` | `45.1.0` | `3.53.4` | `release-dist/win-unpacked/52hzAgents.exe` |

---

## 2. 驱动选型结论

### 选型推荐：Node.js 原生内置驱动 `node:sqlite` (`DatabaseSync` + `backup`)

**核心理由**：
1. **零原生构建负担**：无需引入 `better-sqlite3`，彻底告别 Windows 下的 `node-gyp`、Visual Studio C++ 依赖、Python 构建脚本以及 Electron 大版本升级时的 `electron-rebuild` 二进制 ABI 失配问题。
2. **三态 100% 统一**：在 Standalone Node.js、Electron Dev 以及打包后的发布程序 `52hzAgents.exe` 中均原生具备 `DatabaseSync`、`StatementSync`、`Session`、`backup` 等全部接口。
3. **关键数据库能力完备**：经测试脚本实机验证，外键、WAL 模式、事务原子性、FTS5 全文搜索、锁等待机制、在线热备份 API 全部通过。

---

## 3. 必要能力实机验证结果矩阵

基于实测验证脚本 [`workspace/desktop/server/storage/sqlite-eval.js`](./sqlite-eval.js)，在三种运行态下的实测结果完全一致：

| 验证能力项 | 验证指标与方法 | 实测表现 | 结论 |
| :--- | :--- | :--- | :--- |
| **外键约束** | 执行 `PRAGMA foreign_keys = ON;`，插入孤立子表记录 | 抛出 `FOREIGN KEY constraint failed`，阻断非法写入 | ✅ 通过 |
| **事务与回滚** | `BEGIN` 插入数据后 `ROLLBACK`，查询统计行数 | 计数严格归 0，数据完整回退无脏数据 | ✅ 通过 |
| **大整数精度** | 读取超过 $2^{53}-1$ 边界整数 (`9007199254740993`) | 通过 `stmt.setReadBigInts(true)` 正确读出 `9007199254740993n` | ✅ 通过 |
| **FTS5 中文全文搜索** | 创建 `fts5(title, content, tokenize="trigram")` 并检索中文 | 准确匹配并高亮“存储层”，未出现乱码或分词失真 | ✅ 通过 |
| **WAL 预写日志模式** | 在磁盘数据库执行 `PRAGMA journal_mode = WAL;` | 成功切换至 `wal` 模式，生成 `-wal` 与 `-shm` 支撑并发读写 | ✅ 通过 |
| **锁等待机制** | 执行 `PRAGMA busy_timeout = 5000;` | 成功设置 5000ms 忙等待，防范并发写入锁争用 | ✅ 通过 |
| **在线热备份** | 调用内置 `backup(sourceDb, destFilePath)` Promise 接口 | 在数据库打开状态下成功复制出一致的备份数据库文件并可验证 | ✅ 通过 |

**实测原始输出（来自打包态 `52hzAgents.exe`）**：
```json
{
  "runtime": {
    "node": "24.22.1",
    "electron": "45.1.0",
    "platform": "win32",
    "arch": "x64"
  },
  "sqlite": {
    "version": "3.53.4"
  },
  "tests": {
    "foreign_keys": true,
    "transaction_rollback": true,
    "bigint": true,
    "fts5_trigram_chinese": true,
    "wal_mode": true,
    "busy_timeout": true,
    "online_backup": true
  }
}
```

---

## 4. 备选方案与已知限制

### 备选方案（备忘）
- **`better-sqlite3`**：若后续出现必须依赖极高性能自定义 C 扩展、用户自定义 SQLite 函数（C 层实现）或特定分词动态库加载的极端场景，可作为备选驱动评估；但当前阶段 `node:sqlite` 已完全满足 A1—A8 及 B、C 工作包的全部数据与事务要求，无需引入额外依赖。

### 已知限制与工程规避准则
1. **同步阻塞调用（Sync I/O）**：
   - `node:sqlite` 的设计是同步 API（`DatabaseSync`），其执行性能极高（微秒级），但**严禁在前端渲染线程或 Electron 主进程 UI 循环中执行密集 SQL**。必须集中封装在后端数据访问层（Storage Layer），并配合后续 D 工作包的 Worker/UtilityProcess 进行进程级隔离。
2. **大整数（BigInt）读取声明**：
   - 默认情况下若查询返回超出 JS 安全整数（$> 9007199254740991$）的整数值，Node.js 会抛出 `ERR_OUT_OF_RANGE`。
   - **规避约定**：时间戳建议统一以毫秒级数值存储（在安全整数范围内）；在存储雪花 ID 或极高精度计数时，必须对语句句柄显式调用 `stmt.setReadBigInts(true)`。
3. **中文分词方案选择**：
   - SQLite 默认分词器主要面向空格分隔语言，对中文单字/词组搜索不敏感；
   - **工程落地**：实测内置的 `tokenize="trigram"`（三元分词）对中文子串匹配支持极好，无需外挂第三方分词二进制。
4. **WAL 模式下的文件备份准则**：
   - 启用 WAL 模式后，直接在文件管理器中复制主 `.db` 文件可能丢失尚未 checkpoint 的最新数据；
   - **工程落地**：完整备份必须统一调用 `backup(db, backupPath)` 原生备份 API。
