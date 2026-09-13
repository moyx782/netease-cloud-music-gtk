# 浏览器 Server

浏览器版由仓库自身的 Rust `NcmClient` 提供数据，不引入 `ncm-cli` 或另一套网易云 API 客户端。前端资源会在编译时嵌入程序。

在仓库根目录先按项目的 Meson 流程构建，再启动 Server 模式：

```bash
meson setup _build
meson compile -C _build
./_build/src/netease-cloud-music-gtk4 --server
```

也可以运行编译后的程序：

```bash
netease-cloud-music-gtk4 --server
```

然后打开 <http://127.0.0.1:3000>。`HOST` 和 `PORT` 可用于修改监听地址与端口；服务会复用桌面版保存的登录 Cookie。

登录弹窗支持二维码和账号密码登录；二维码登录成功后会自动保存 Cookie。播放栏的“歌词”按钮通过 Rust 客户端获取歌词，按 LRC 时间戳高亮当前行并支持点击跳转；登录状态可用时还会显示账号收藏的歌单。
