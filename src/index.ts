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
    .description("GitHub 上游仓库，格式：owner/repo")
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

interface GitHubUser {
  login: string;
}

interface GitHubRepo {
  fork: boolean;
  parent?: {
    full_name: string;
  };
  default_branch: string;
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

  const [upstreamOwner, upstreamRepo] = parseRepo(config.githubRepo);
  const upstreamApiBase = `https://api.github.com/repos/${upstreamOwner}/${upstreamRepo}`;
  const upstreamRawBase = `https://raw.githubusercontent.com/${upstreamOwner}/${upstreamRepo}/${config.baseBranch}`;

  const githubHeaders = {
    Authorization: `Bearer ${config.githubToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  // 在启动时获取 Token 用户名，用于 fork 操作
  let forkOwner = "";
  ctx.on("ready", async () => {
    try {
      const user = await ctx.http.get<GitHubUser>(
        "https://api.github.com/user",
        {
          headers: githubHeaders,
        },
      );
      forkOwner = user.login;
      logger.info(
        "插件已加载，上游仓库：%s，Token 用户：%s，目标分支：%s",
        config.githubRepo,
        forkOwner,
        config.baseBranch,
      );
    } catch (error) {
      logger.error("获取 GitHub 用户信息失败，请检查 Token：%o", error);
    }
  });

  const getForkApiBase = (): string => {
    return `https://api.github.com/repos/${forkOwner}/${upstreamRepo}`;
  };

  const loadHistory = (): PullHistory => {
    const historyPath = resolve(config.historyPath);
    if (!existsSync(historyPath)) return {};
    try {
      return JSON.parse(readFileSync(historyPath, "utf-8")) as PullHistory;
    } catch {
      return {};
    }
  };

  const saveHistory = (history: PullHistory): void => {
    const historyPath = resolve(config.historyPath);
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

  const extractPlainText = (elements: h[]): string => {
    return elements
      .map((el) => {
        if (typeof el === "string") return el;
        if (el.type === "text") return el.attrs?.content ?? el.toString();
        if (el.type === "img" || el.type === "image") return "";
        if (el.children?.length) return extractPlainText(el.children);
        return "";
      })
      .join("")
      .trim();
  };

  const sanitizeFilename = (title: string): string => {
    return title.replace(/[^\w\u4e00-\u9fa5\-]/g, "_").slice(0, 64);
  };

  // 检查上游仓库中文件是否已存在
  const checkFileExists = async (path: string): Promise<boolean> => {
    try {
      await ctx.http.get<GitHubContentResponse>(
        `${upstreamApiBase}/contents/${path}?ref=${config.baseBranch}`,
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

  // 确保 Token 用户下有上游仓库的 fork，没有则创建
  const ensureFork = async (): Promise<string> => {
    if (!forkOwner) {
      throw new Error("Token 用户信息未获取，请检查 Token 配置后重启插件。");
    }

    // 检查 fork 是否已存在
    try {
      const repoInfo = await ctx.http.get<GitHubRepo>(`${getForkApiBase()}`, {
        headers: githubHeaders,
      });
      if (repoInfo.fork && repoInfo.parent?.full_name === config.githubRepo) {
        logger.debug("Fork 已存在：%s/%s", forkOwner, upstreamRepo);
        return repoInfo.default_branch;
      }
      // 同名仓库存在但不是上游的 fork，报错
      if (!repoInfo.fork || repoInfo.parent?.full_name !== config.githubRepo) {
        throw new Error(
          `用户 ${forkOwner} 下已存在 ${upstreamRepo} 仓库但不是上游的 fork，请手动处理。`,
        );
      }
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response
        ?.status;
      if (status !== 404) throw error;
    }

    // Fork 不存在，创建 fork
    logger.info(
      "Fork 不存在，正在创建：%s/%s → %s/%s",
      upstreamOwner,
      upstreamRepo,
      forkOwner,
      upstreamRepo,
    );
    await ctx.http.post(
      `${upstreamApiBase}/forks`,
      {},
      { headers: githubHeaders },
    );

    // GitHub fork 操作是异步的，等待 fork 就绪
    logger.debug("等待 fork 创建完成...");
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const repoInfo = await ctx.http.get<GitHubRepo>(`${getForkApiBase()}`, {
          headers: githubHeaders,
        });
        if (repoInfo.fork) {
          logger.info(
            "Fork 创建完成：%s/%s，默认分支：%s",
            forkOwner,
            upstreamRepo,
            repoInfo.default_branch,
          );
          return repoInfo.default_branch;
        }
      } catch {
        // fork 还没就绪，继续等待
      }
    }
    throw new Error("Fork 创建超时，请稍后重试。");
  };

  // 同步 fork 的分支到上游最新
  const syncForkBranch = async (forkDefaultBranch: string): Promise<string> => {
    // 获取上游分支的 SHA
    const upstreamRef = await ctx.http.get<GitHubRef>(
      `${upstreamApiBase}/git/ref/heads/${config.baseBranch}`,
      { headers: githubHeaders },
    );
    const upstreamSha = upstreamRef.object.sha;
    logger.debug("上游分支 %s SHA：%s", config.baseBranch, upstreamSha);

    // 更新 fork 的默认分支指向上游
    try {
      await ctx.http.patch(
        `${getForkApiBase()}/git/refs/heads/${forkDefaultBranch}`,
        { sha: upstreamSha, force: true },
        { headers: githubHeaders },
      );
      logger.debug(
        "Fork 分支 %s 已同步到上游 %s",
        forkDefaultBranch,
        upstreamSha,
      );
    } catch (error) {
      logger.warn("同步 fork 分支失败，继续使用当前状态：%o", error);
    }

    return upstreamSha;
  };

  // 在 fork 上创建新分支
  const createBranchOnFork = async (
    branch: string,
    sha: string,
  ): Promise<void> => {
    await ctx.http.post(
      `${getForkApiBase()}/git/refs`,
      {
        ref: `refs/heads/${branch}`,
        sha,
      },
      { headers: githubHeaders },
    );
    logger.debug("在 fork 上创建分支：%s", branch);
  };

  // 在 fork 上创建文件
  const createFileOnFork = async (
    path: string,
    branch: string,
    buffer: Buffer,
  ): Promise<void> => {
    await ctx.http.put(
      `${getForkApiBase()}/contents/${path}`,
      {
        message: `[HubPusl] add image ${path.split("/").pop()}`,
        content: buffer.toString("base64"),
        branch,
      },
      { headers: githubHeaders },
    );
  };

  // 从 fork 向上游创建跨仓库 PR
  const createCrossRepoPullRequest = async (
    title: string,
    branch: string,
  ): Promise<string> => {
    const response = await ctx.http.post<{
      html_url: string;
    }>(
      `${upstreamApiBase}/pulls`,
      {
        title: `[HubPusl] ${title}`,
        head: `${forkOwner}:${branch}`,
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
    logger.debug(
      "图片下载完成，大小：%s MB，扩展名：%s",
      sizeMb.toFixed(2),
      extension,
    );
    if (sizeMb > config.maxFileSize) {
      logger.warn(
        "图片 %s MB 超过限制 %d MB",
        sizeMb.toFixed(2),
        config.maxFileSize,
      );
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

    // 确保 fork 存在
    const forkDefaultBranch = await ensureFork();

    // 同步 fork 并获取最新 SHA
    const latestSha = await syncForkBranch(forkDefaultBranch);

    // 在 fork 上创建新分支
    const branch = `hub-pusl/${safeTitle}-${Date.now()}`;
    await createBranchOnFork(branch, latestSha);

    // 在 fork 上上传文件
    logger.debug("上传文件到 fork 分支：%s", branch);
    await createFileOnFork(path, branch, buffer);

    // 创建跨仓库 PR
    logger.debug(
      "创建跨仓库 PR：%s:%s → %s:%s",
      forkOwner,
      branch,
      upstreamOwner,
      config.baseBranch,
    );
    const prUrl = await createCrossRepoPullRequest(title, branch);
    logger.info("push 成功，PR：%s", prUrl);
    return `图片已推送，PR：${prUrl}`;
  };

  const listRemoteImages = async (): Promise<GitHubContentItem[]> => {
    try {
      logger.debug("列出上游图片目录：%s", config.imageDir);
      const items = await ctx.http.get<GitHubContentItem[]>(
        `${upstreamApiBase}/contents/${config.imageDir}?ref=${config.baseBranch}`,
        { headers: githubHeaders },
      );
      const images = items.filter(
        (item) => item.type === "file" && SUPPORTED_EXTENSIONS.test(item.name),
      );
      logger.debug("上游图片数量：%d", images.length);
      return images;
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response
        ?.status;
      if (status === 404) {
        logger.debug("上游图片目录不存在");
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
      `${upstreamRawBase}/${selected.path}`,
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
      const cleanTitle = extractPlainText(session.elements ?? []);
      if (!cleanTitle) {
        logger.warn("push 命令标题解析后为空，用户：%s", session.userId);
        return "请提供图片标题，例如：nwtf-push 可爱小猫";
      }
      try {
        return await pushImage(session, cleanTitle.trim());
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
