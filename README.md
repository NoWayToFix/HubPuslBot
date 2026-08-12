# HubPuslBot

> Pusl = Push 和 Pull 在一个晚上喝醉了。

`koishi-plugin-hub-pusl` 是一个 Koishi 插件，用于在 QQ 群内与 GitHub 图片仓库互动：

- **Push**：把群里发送的图片推送到 GitHub 仓库，并自动创建 Pull Request。
- **Pull**：从 GitHub 仓库拉取图片到群里，可随机抽取，也可按文件名精确拉取。

全程通过 GitHub API 完成，无需在本地 `git clone` 仓库。

## 安装

```bash
npm install koishi-plugin-hub-pusl
```

然后在 Koishi 控制台启用并配置本插件。

## 配置

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `commandPrefix` | `string` | `nwtf` | 命令前缀，例如 `nwtf` 会生成 `nwtf-push` 和 `nwtf-pull`。 |
| `githubToken` | `string` | 必填 | GitHub Personal Access Token，需具备 `repo` 权限。 |
| `githubRepo` | `string` | 必填 | 上游仓库，格式为 `owner/repo`。 |
| `baseBranch` | `string` | `main` | PR 的目标分支。 |
| `githubMirror` | `string` | 空 | 图片下载镜像前缀，例如 `https://gh-proxy.org/`，留空则直连 GitHub。 |
| `allowedGroups` | `string[]` | `[]` | 允许使用的群号列表，为空则允许所有群。 |
| `adminUsers` | `string[]` | `[]` | 允许执行 push 的用户 QQ 号，为空则允许所有人。 |
| `imageDir` | `string` | `images` | 图片在上游仓库中的目录。 |
| `maxFileSize` | `number` | `20` | 允许推送的最大图片大小，单位 MB。 |
| `historyPath` | `string` | `./hub-pusl-history.json` | 群拉取记录文件路径，用于随机拉取时去重。 |

## 命令

### `nwtf-push <标题>`

将随消息发送的图片（或引用消息中的图片）推送到上游仓库，并创建一个 Pull Request。

```
nwtf-push 可爱小猫
```

注意事项：

- 标题会作为图片文件名，非法字符会被替换为下划线。
- 如果仓库中已存在同名文件，会提示更换标题。
- 插件会先 fork 上游仓库到自己的账号下，再创建分支、上传文件、提交 PR。

### `nwtf-pull [图片名]`

从上游仓库拉取一张图片到群里。

```
# 随机拉取一张图片
nwtf-pull

# 按文件名（不含扩展名）精确拉取
nwtf-pull 可爱小猫
```

随机拉取时会记录每个群的已发送图片，尽量做到不重复；当所有图片都发送过后会自动重置记录。

## 使用例

下图展示了在 QQ 群中使用 `nwtf-push` 推送图片并创建 PR，以及使用 `nwtf-pull` 随机拉取图片的效果：

![使用例](resources/使用例.jpg)

## 使用前提

1. 准备一个 GitHub 仓库用于存放图片，并在仓库中创建配置的 `imageDir` 目录（例如 `images`）。
2. 生成一个具有 `repo` 权限的 [GitHub Personal Access Token](https://github.com/settings/tokens)。
3. 将 Token 填入插件配置，并设置正确的上游仓库 `owner/repo`。

## 许可证

GPL-3.0
