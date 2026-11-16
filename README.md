# @local/dsh-mermaid

在 DSH 对话里把 ```` ```mermaid ```` 围栏渲染成实时 SVG 图，并跟随 DSH 的浅色 / 深色主题。

## 为什么需要它

DSH 桌面端原生不渲染 mermaid 围栏——带语言的围栏走 Chat 的
`conversation.chat.markdown.fence` 槽位，默认只显示成代码块。Typora 能渲染，
是因为它内置了 mermaid 引擎。这个插件补上同一能力：注册一个 `mermaid` 层的
fence 层，把围栏换成图形。

## 工作原理

- **客户端**（`client.js`）向 `conversation.chat.markdown.fence` 注册
  `key: 'mermaid'` 的层。流式生成期间保留源码（`children`），文档落定后交给
  渲染器，避免半截图闪解析错误——与 Chat 自带的 `math` 层契约一致。
- **渲染**：mermaid 从本插件目录内的 `mermaid.min.js` 加载（由 Host 的
  `/dsh-mermaid` 前缀路由提供），不依赖 CDN 或插件目录之外的任何文件。
- **主题适配**：颜色取自 DSH 主题 token（`--dsw-alias-*`，由 ThemePresenter
  写在 `body` 上），所以图会跟随浅色 / 深色与已注册的调色板，而不是 mermaid
  写死的颜色。监听 `body` 属性 / 内联变量变化与系统 `prefers-color-scheme`，
  主题切换后自动重绘。
- **失败回退**：语法错误或渲染失败时回退成普通代码块，源码一定可见。

## 文件

| 文件 | 作用 |
| --- | --- |
| `client.js` | 客户端：注册 fence 层、加载 mermaid、按主题渲染 |
| `index.js` | 宿主端：提供 `/dsh-mermaid/mermaid.min.js` 静态路由 |
| `mermaid.min.js` | 内嵌的 mermaid 11 UMD 构建（自包含，无网络依赖） |
| `cordis.patch.yml` | 组合补丁：插入插件条目 |
| `package.json` | 包清单与 `dsh.client` 声明 |

## 安装

本插件是本地包，用插件管理器从绝对目录安装：

```
plugin_manager install_bundle，target = 本目录绝对路径
```

装后在设置 → 插件里可见。渲染发生在客户端，无需重启宿主。

## 许可

插件代码 MIT。内嵌的 `mermaid.min.js` 遵循 mermaid.js 的 MIT 许可。
