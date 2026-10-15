# 百度网盘 Skill 与夸克 Skill 并存

本公开仓库仅存代码和可审计的官方 Skill 副本。百度授权与夸克授权**相互独立**。
本次引入了官方 baidu-drive v1.7.5 的未改动源码和 3.8.4 安装器脚本。

## 安装与验证

路径：skills/baidu-drive/SKILL.md。
在开发环境可以执行 python3 scripts/check-baidu-skill.py 验证官方 Git blob 指纹，
GitHub Actions 的 verify-baidu-drive.yml 在临时 runner 安装官方 bdpan CLI 并调用 bdpan version。
该临时安装不包含 OAuth 授权；不是长期可用的跨对话百度下载服务。

## 账号授权

必须在用户**自己控制的可信终端**使用官方交互式脚本。

    bash skills/baidu-drive/scripts/install.sh
    bash skills/baidu-drive/scripts/login.sh

授权时只打开官方生成的 OAuth 链接，不在公开 GitHub、PR、Actions 日志或聊天中提供密码、授权码、cookies、Token 或配置文件。
官方脚本是交互式的，不能在每次全新 GitHub runner 启动后直接复用之前的登录态。
需要另外开发有权限边界的加密状态保存、授权回调、独立 BAIDU_STATE_KEY、加密任务传输及教材文件私有存储，
才能把现有夸克项目的跨对话云端调用模式扩展到百度。

## 教材入库（用户已授权提供的共享资料）

百度官方 CLI 已文档化分享链接转存、下载、文件夹列表能力。实际操作先以只读列表确认教材文件的完整性，
再核对 1—6 年级语文/数学的册次、修订版次、ISBN、版权页和正文来源。文件未经授权不得保存或再分发。
如果核验通过，教材原件只进入用户授权的私有存储；私有 Kejian 仓库仅保留来源、文件哈希、版本、课时索引和审核状态。
不要把百度提取码嵌入 GitHub workflow_dispatch 参数、公开 branch、commit 或日志。

用户给出的两份分享已作为待读取来源登记在私有 Kejian PR #7：
https://github.com/chenyang-99/Kejian/pull/7
**截至目前未发生实际百度文件下载、OAuth 绑定或教材正文入库。**

## 供应链与隐私

- 官方来源 https://github.com/baidu-netdisk/bdpan-storage；原始文件逐个 Git blob 哈希固定。
- 下载/执行前校验官方 installer 的 SHA-256（官方 install.sh 中内置 Linux 等平台哈希）。
- 使用前核对上游 SKILL.md 的安全限制。仅允许 bdpan 应用目录访问范围内的网盘操作。
- 原始聊天中可能包含提取码，不应把整句原始消息作为第三方 CLI 遥测参数 --session-input 传输。
- 公开 quark-skill 仓库绝不存储教材 PDF、私密目录清单或账号授权状态明文。
- 同一 repo 的 Quark 入口、请求分支与 QUARK_STATE_KEY 不因加入百度 Skill 而改变。
