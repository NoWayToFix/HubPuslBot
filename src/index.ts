import { Context, Schema, h, Session } from "koishi";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

export const name = "hub-pusl";

export interface Config {
  commandPrefix: string;
  githubToken: string;
  githubRepo: string;
  baseBranch: string;
  allowedGroups: string[];
  adminUsers: string[];
  imageDir: string;
  maxFileSize: number;
  historyPath: string;
}

export const Config: Schema<Config> = Schema.object({
  commandPrefix: Schema.string().default("nwtf").description("命令前缀"),
  githubToken: Schema.string()
    .description("GitHub Personal Access Token")
    .required(),
  githubRepo: Schema.string()
    .description("GitHub 仓库，格式：owner/repo")
    .required(),
  baseBranch: Schema.string().default("main").description("PR 目标分支"),
  allowedGroups: Schema.array(Schema.string())
    .default([])
    .description("允许的群号列表，为空则允许所有群"),
  adminUsers: Schema.array(Schema.string())
    .default([])
    .description("允许 push 的用户 QQ 号，为空则允许所有人"),
  imageDir: Schema.string().default("images").description("图片在仓库中的目录"),
  maxFileSize: Schema.number()
    .default(20)
    .description("最大允许图片大小（MB）"),
  historyPath: Schema.string()
    .default("./hub-pusl-history.json")
    .description("群拉取记录文件路径"),
});

interface FetchedImage {
  buffer: Buffer;
  extension: string;
  mimeType: string;
}

interface PullHistory {
  [groupId: string]: string[];
}

interface GitHubContentItem {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "submodule";
  download_url: string | null;
}

interface GitHubRef {
  object: {
    sha: string;
  };
}

interface GitHubContentResponse {
  sha: string;
}

const SUPPORTED_EXTENSIONS = /\.(png|jpe?g|webp|gif|bmp)$/i;

const parseRepo = (repo: string): [string, string] => {
  const parts = repo.split("/").filter(Boolean);
  if (parts.length !== 2) {
    throw new Error(`githubRepo 格式错误：${repo}，应为 owner/repo`);
  }
  return [parts[0], parts[1]];
};

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger("hub-pusl");
  logger.info(
    "插件已加载，仓库：%s，目标分支：%s",
    config.githubRepo,
    config.baseBranch,
  );

  const historyPath = resolve(config.historyPath);
  const [owner, repo] = parseRepo(config.githubRepo);
  const apiBase = `https://api.github.com/repos/${owner}/${repo}`;
  const rawBase = `https://raw.githubusercontent.com/${owner}/${repo}/${config.baseBranch}`;

  const githubHeaders = {
    Authorization: `Bearer ${config.githubToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const loadHistory = (): PullHistory => {
    if (!existsSync(historyPath)) return {};
    try {
      return JSON.parse(readFileSync(historyPath, "utf-8")) as PullHistory;
    } catch {
      return {};
    }
  };

  const saveHistory = (history: PullHistory): void => {
    mkdirSync(dirname(historyPath), { recursive: true });
    writeFileSync(historyPath, JSON.stringify(history, null, 2));
  };

  const isGroupAllowed = (session: Session): boolean => {
    if (session.subtype !== "group") return true;
    if (config.allowedGroups.length === 0) return true;
    const allowed = config.allowedGroups.includes(String(session.guildId));
    if (!allowed) {
      logger.warn("群 %s 不在允许列表中", session.guildId);
    }
    return allowed;
  };

  const isUserAllowed = (session: Session): boolean => {
    if (config.adminUsers.length === 0) return true;
    const allowed = config.adminUsers.includes(String(session.userId));
    if (!allowed) {
      logger.warn("用户 %s 没有 push 权限", session.userId);
    }
    return allowed;
  };

  const fetchImage = async (url: string): Promise<FetchedImage> => {
    const response = await ctx.http.get<ArrayBuffer>(url, {
      responseType: "arraybuffer",
    });
    const buffer = Buffer.from(response);
    const extension = inferExtension(buffer);
    return {
      buffer,
      extension,
      mimeType: extensionToMimeType(extension),
    };
  };

  const inferExtension = (buffer: Buffer): string => {
    if (buffer[0] === 0x89 && buffer[1] === 0x50) return "png";
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return "jpg";
    if (buffer.slice(0, 4).toString("hex") === "52494646") return "webp";
    if (buffer.slice(0, 3).toString("ascii") === "GIF") return "gif";
    if (buffer[0] === 0x42 && buffer[1] === 0x4d) return "bmp";
    return "png";
  };

  const extensionToMimeType = (extension: string): string => {
    const map: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
      bmp: "image/bmp",
    };
    return map[extension] ?? "image/png";
  };

  const findImageUrl = (session: Session): string | undefined => {
    const images = h.select(session.elements ?? [], "img");
    if (images.length > 0) return images[0].attrs.src ?? images[0].attrs.url;
    if (session.quote) {
      const quotedImages = h.select(session.quote.elements ?? [], "img");
      if (quotedImages.length > 0)
        return quotedImages[0].attrs.src ?? quotedImages[0].attrs.url;
    }
    return undefined;
  };

  const sanitizeFilename = (title: string): string => {
    return title.replace(/[^\w\u4e00-\u9fa5\-]/g, "_").slice(0, 64);
  };

  const checkFileExists = async (path: string): Promise<boolean> => {
    try {
      await ctx.http.get<GitHubContentResponse>(
        `${apiBase}/contents/${path}?ref=${config.baseBranch}`,
        { headers: githubHeaders },
      );
      return true;
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response
        ?.status;
      if (status === 404) return false;
      throw error;
    }
  };

  const getBaseSha = async (): Promise<string> => {
    const ref = await ctx.http.get<GitHubRef>(
      `${apiBase}/git/ref/heads/${config.baseBranch}`,
      { headers: githubHeaders },
    );
    return ref.object.sha;
  };

  const createBranch = async (branch: string): Promise<void> => {
    const sha = await getBaseSha();
    await ctx.http.post(
      `${apiBase}/git/refs`,
      {
        ref: `refs/heads/${branch}`,
        sha,
      },
      { headers: githubHeaders },
    );
  };

  const createFile = async (
    path: string,
    branch: string,
    buffer: Buffer,
  ): Promise<void> => {
    await ctx.http.put(
      `${apiBase}/contents/${path}`,
      {
        message: `[HubPusl] add image ${path.split("/").pop()}`,
        content: buffer.toString("base64"),
        branch,
      },
      { headers: githubHeaders },
    );
  };

  const createPullRequest = async (
    title: string,
    branch: string,
  ): Promise<string> => {
    const response = await ctx.http.post<{
      html_url: string;
    }>(
      `${apiBase}/pulls`,
      {
        title: `[HubPusl] ${title}`,
        head: branch,
        base: config.baseBranch,
        body: `Submitted by HubPusl bot for image \`${title}\`.`,
      },
      { headers: githubHeaders },
    );
    return response.html_url;
  };

  const pushImage = async (
    session: Session,
    title: string,
  ): Promise<string> => {
    logger.debug(
      "收到 push 请求，标题：%s，用户：%s，群：%s",
      title,
      session.userId,
      session.guildId,
    );
    if (!isGroupAllowed(session)) return "当前群不在允许列表中。";
    if (!isUserAllowed(session)) return "你没有权限执行 push 操作。";

    const imageUrl = findImageUrl(session);
    if (!imageUrl) {
      logger.warn("未找到图片，用户：%s", session.userId);
      return "未检测到图片，请随命令发送图片或引用带图片的消息。";
    }
    logger.debug("检测到图片 URL：%s", imageUrl);

    const { buffer, extension } = await fetchImage(imageUrl);
    const sizeMb = buffer.length / 1024 / 1024;
    logger.debug("图片下载完成，大小：%.2f MB，扩展名：%s", sizeMb, extension);
    if (sizeMb > config.maxFileSize) {
      logger.warn("图片 %.2f MB 超过限制 %d MB", sizeMb, config.maxFileSize);
      return `图片大小 ${sizeMb.toFixed(2)} MB 超过限制 ${config.maxFileSize} MB。`;
    }

    const safeTitle = sanitizeFilename(title);
    if (!safeTitle) {
      logger.warn("标题无效：%s", title);
      return "标题无效，无法生成文件名。";
    }

    const filename = `${safeTitle}.${extension}`;
    const path = `${config.imageDir}/${filename}`;
    logger.debug("准备上传文件：%s", path);

    if (await checkFileExists(path)) {
      logger.warn("文件已存在：%s", filename);
      return `文件 \`${filename}\` 已存在，请更换标题后再试。`;
    }

    const branch = `hub-pusl/${safeTitle}-${Date.now()}`;
    logger.debug("创建分支：%s", branch);
    await createBranch(branch);
    logger.debug("上传文件到分支：%s", branch);
    await createFile(path, branch, buffer);
    logger.debug("创建 PR，分支：%s", branch);
    const prUrl = await createPullRequest(title, branch);
    logger.info("push 成功，PR：%s", prUrl);
    return `图片已推送，PR：${prUrl}`;
  };

  const listRemoteImages = async (): Promise<GitHubContentItem[]> => {
    try {
      logger.debug("列出远程图片目录：%s", config.imageDir);
      const items = await ctx.http.get<GitHubContentItem[]>(
        `${apiBase}/contents/${config.imageDir}?ref=${config.baseBranch}`,
        { headers: githubHeaders },
      );
      const images = items.filter(
        (item) => item.type === "file" && SUPPORTED_EXTENSIONS.test(item.name),
      );
      logger.debug("远程图片数量：%d", images.length);
      return images;
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response
        ?.status;
      if (status === 404) {
        logger.debug("远程图片目录不存在");
        return [];
      }
      throw error;
    }
  };

  const pullImage = async (session: Session): Promise<string | h[]> => {
    logger.debug(
      "收到 pull 请求，群：%s，用户：%s",
      session.guildId,
      session.userId,
    );
    if (!isGroupAllowed(session)) return "当前群不在允许列表中。";

    const images = await listRemoteImages();
    if (images.length === 0) {
      logger.warn("仓库中没有图片");
      return "仓库中暂无图片。";
    }

    const groupId = String(session.guildId ?? session.userId);
    const history = loadHistory();
    const historySet = new Set(history[groupId] ?? []);
    logger.debug("群 %s 历史记录数量：%d", groupId, historySet.size);

    let candidates = images.filter((image) => !historySet.has(image.name));
    if (candidates.length === 0) {
      logger.info("群 %s 所有图片都已发送过，重置历史记录", groupId);
      history[groupId] = [];
      candidates = images;
    }

    const selected = candidates[Math.floor(Math.random() * candidates.length)];
    logger.info("群 %s 选中图片：%s", groupId, selected.name);
    history[groupId] = [...(history[groupId] ?? []), selected.name];
    saveHistory(history);

    const buffer = await ctx.http.get<ArrayBuffer>(
      `${rawBase}/${selected.path}`,
      { responseType: "arraybuffer" },
    );
    const extension = extname(selected.name).slice(1) || "png";
    const mimeType = extensionToMimeType(extension);
    const base64 = Buffer.from(buffer).toString("base64");
    logger.debug("图片下载完成，大小：%d bytes", buffer.byteLength);

    return [h.image(`data:${mimeType};base64,${base64}`)];
  };

  ctx
    .command(
      `${config.commandPrefix}-push <title:text>`,
      "推送图片到 Hub 仓库并创建 PR",
    )
    .action(async ({ session }, title) => {
      if (!session) {
        logger.warn("push 命令缺少会话信息");
        return "会话信息缺失。";
      }
      if (!title || !title.trim()) {
        logger.warn("push 命令缺少标题，用户：%s", session.userId);
        return "请提供图片标题，例如：nwtf-push 可爱小猫";
      }
      try {
        return await pushImage(session, title.trim());
      } catch (error) {
        logger.error("push 命令执行失败：%o", error);
        return `推送失败：${error instanceof Error ? error.message : String(error)}`;
      }
    });

  ctx
    .command(`${config.commandPrefix}-pull`, "从 Hub 仓库随机拉取一张图片")
    .action(async ({ session }) => {
      if (!session) {
        logger.warn("pull 命令缺少会话信息");
        return "会话信息缺失。";
      }
      try {
        return await pullImage(session);
      } catch (error) {
        logger.error("pull 命令执行失败：%o", error);
        return `拉取失败：${error instanceof Error ? error.message : String(error)}`;
      }
    });
}
