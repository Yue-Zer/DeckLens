# 配置示例可入库，真实凭据留在用户目录

本目录只保存公开结构与示例。`providers.example.json` 是待确认架构预置，不由当前应用自动加载，不含API Key，默认不启用任何模型。

- 公开供应商、模型、活动选择：后续由Core写入用户SQLite。
- 真实凭据：`<userData>/credentials/<providerId>.json`，仅宿主SecretStore访问。结构为providerId与apiKey，由本机编辑器录入；文件不应创建在此目录。
- 运行配置：`<userData>/config/runtime.json` 或启动环境变量，必须在源码目录外。
- `.env.example` 仅解释非敏感的目录/端口字段；不要加入 `VITE_*_KEY`、Key或私人资料路径。
- 根目录 `config.example.json` 是旧单供应商示例；新版模型以本目录及架构文档为准，确认后再执行受控升级。

API Key不得进入renderer、通道DTO、SQLite、snapshot、日志、测试fixture、命令行参数或仓库文件。不要把带认证信息的URL保存为baseUrl。清空本地数据与清除凭据是两个独立操作。

本轮示例中modelName为空、enabled=false，表示未配置。下一阶段提供配置schema校验与受控导入，不把示例当可直接连接的用户配置。
