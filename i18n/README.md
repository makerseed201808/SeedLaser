# i18n

`zh_CN.po` 取自上游 boxes 仓库 master 分支：
https://github.com/florianfesti/boxes/blob/36a0a087ac15d9c762f04aaba7b21937bf3d986f/po/zh_CN.po
（commit `36a0a087ac15d9c762f04aaba7b21937bf3d986f`，2026-01-11）

译者：裘炯涛 <qiujiongtao@163.com> 等上游贡献者，许可证 GPL-3.0（与 boxes 相同）。

为什么要单独放一份：boxes `release-1.2` 自带的 zh_CN 翻译较旧，与 release-1.2 代码中的英文
字符串大量不匹配，实测参数 / 说明的翻译覆盖率只有约 39%；换用这份较新的翻译后约 98%。

运行时由 `backend._load_translation()` 直接解析本文件（优先），找不到的再回退到
boxes 自带的 .mo。更新方法：用上面链接里更新的 commit 替换本文件，重新运行覆盖率检查。
