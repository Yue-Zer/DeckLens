# host-node：两个宿主共用的本机能力

状态：职责占位，本轮没有package入口、依赖或实现。后续由 `apps/server` 与 `apps/electron` 引用；Web不能引用。

提供操作系统用户目录定位、受控资源文件存储、SecretStore、当前用户权限、目录实例锁、后台worker调度、固定凭据编辑器入口与脱敏日志。纯Node实现，不import Electron，不包含解析、检索、探索树或SQL业务。

Core定义端口，宿主注入实现；Electron特有的系统对话框和窗口生命周期仍在Electron壳。本模块不能成为任意文件读写/命令执行的renderer桥梁，也不能维护第二套数据库或Provider逻辑。

具体目录、权限、启动与通道限制见 `docs/architecture/core-and-platform.md`。本目录不创建真实配置、密钥或用户数据库。
