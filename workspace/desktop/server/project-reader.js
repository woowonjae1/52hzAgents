const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execute = promisify(execFile);
const LIMIT = 1024 * 1024;

async function git(root, args) {
  return (
    await execute(
      "git",
      ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.quotepath=false", "-C", root, ...args],
      {
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 2 * LIMIT,
        encoding: "utf8",
      },
    )
  ).stdout;
}
async function projectRoot(store, channel) {
  const dir = store.getChannel(channel)?.working_dir;
  if (!dir)
    throw Object.assign(new Error("This session has no project folder."), {
      status: 400,
    });
  const root = await fs.realpath(dir);
  if (!(await fs.stat(root)).isDirectory())
    throw Object.assign(new Error("The project folder is unavailable."), {
      status: 404,
    });
  return root;
}
async function contained(root, relative) {
  if (
    typeof relative !== "string" ||
    relative.includes("\0") ||
    path.isAbsolute(relative)
  )
    throw Object.assign(new Error("Choose a file within this project."), {
      status: 400,
    });
  const target = path.resolve(root, relative);
  const resolved = await fs.realpath(target);
  const rel = path.relative(root, resolved);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
    throw Object.assign(new Error("The path is outside this project."), {
      status: 403,
    });
  return resolved;
}
async function repository(store, channel) {
  return (
    await git(await projectRoot(store, channel), [
      "rev-parse",
      "--show-toplevel",
    ])
  ).trim();
}
function parseNumstat(output) {
  const values = output.split("\0"),
    map = new Map();
  for (let i = 0; i < values.length; i++) {
    const match = values[i].match(/^(\d+|-)\t(\d+|-)\t(.*)$/s);
    if (!match) continue;
    let name = match[3];
    if (!name) {
      i++;
      name = values[++i];
    }
    map.set(name, {
      additions: Number(match[1]) || 0,
      deletions: Number(match[2]) || 0,
    });
  }
  return map;
}
async function gitStatus(store, channel) {
  let root;
  try {
    root = await repository(store, channel);
  } catch {
    return {
      available: false,
      reason: "Choose an existing Git project folder for this session.",
      read_only: true,
      files: [],
    };
  }
  const [raw, branch, counts, divergence] = await Promise.all([
    git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    git(root, ["symbolic-ref", "--short", "HEAD"]).catch(() => "HEAD"),
    git(root, ["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z", "HEAD", "--"]).catch(
      async () =>
        (await git(root, ["diff", "--cached", "--numstat", "-z", "--"])) +
        (await git(root, ["diff", "--numstat", "-z", "--"])),
    ),
    git(root, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']).then(text => text.trim().split(/\s+/).map(Number)).catch(() => null),
  ]);
  const stats = parseNumstat(counts),
    records = raw.split("\0"),
    files = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const x = record[0],
      y = record[1],
      name = record.slice(3);
    if (x === "R" || x === "C" || y === "R" || y === "C") i++;
    files.push({
      path: name,
      status: x === "?" ? "?" : y !== " " ? y : x,
      staged: x !== " " && x !== "?",
      ...(stats.get(name) || { additions: 0, deletions: 0 }),
    });
  }
  return {
    available: true,
    read_only: true,
    dir: root,
    dir_name: path.basename(root),
    branch: branch.trim(),
    ahead: divergence?.[0] || 0,
    behind: divergence?.[1] || 0,
    upstream_available: !!divergence,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    files,
  };
}
async function gitDiff(store, channel, file) {
  const root = await repository(store, channel);
  if (
    file &&
    (path.isAbsolute(file) ||
      file.replace(/\\/g, "/").split("/").includes("..") ||
      file.includes("\0"))
  )
    throw Object.assign(new Error("Choose a file within this repository."), {
      status: 400,
    });
  const args = file ? ["--", file] : ["--"];
  let diff = await git(root, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "HEAD",
    ...args,
  ]).catch(
    async () =>
      (await git(root, [
        "diff",
        "--cached",
        "--no-ext-diff",
        "--no-textconv",
        ...args,
      ])) +
      (await git(root, ["diff", "--no-ext-diff", "--no-textconv", ...args])),
  );
  if (file && !diff) {
    const status = await gitStatus(store, channel);
    if (status.files.some((f) => f.path === file && f.status === "?")) {
      const text = await readContent(root, file);
      if (text.is_binary) diff = `Binary file: ${file}`;
      else {
        const lines = text.content.replace(/\n$/, "").split("\n");
        diff = `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`;
      }
    }
  }
  return { status: "ok", diff, path: file || "", base: "HEAD" };
}
async function readContent(root, relative) {
  const target = await contained(root, relative),
    stat = await fs.stat(target);
  if (!stat.isFile())
    throw Object.assign(new Error("Choose a file."), { status: 400 });
  if (stat.size > LIMIT)
    throw Object.assign(new Error("Preview supports files up to 1 MiB."), {
      status: 413,
    });
  const buffer = await fs.readFile(target),
    binary = buffer.includes(0);
  return {
    path: relative,
    name: path.basename(target),
    size: stat.size,
    mod_time: stat.mtime.toISOString(),
    is_binary: binary,
    content: binary ? "" : buffer.toString("utf8"),
    mime_type: binary ? "application/octet-stream" : "text/plain",
  };
}
async function tree(store, channel, subpath = "") {
  const root = await projectRoot(store, channel),
    target = await contained(root, subpath);
  const entries = await fs.readdir(target, { withFileTypes: true });
  const visible = entries
    .filter((e) => ![".git", "node_modules", ".next"].includes(e.name))
    .slice(0, 500);
  return {
    root,
    path: subpath,
    entries: await Promise.all(
      visible.map(async (entry) => {
        const stat = await fs.lstat(path.join(target, entry.name));
        return {
          name: entry.name,
          path: path.join(subpath, entry.name).replace(/\\/g, "/"),
          is_dir: entry.isDirectory(),
          size: stat.size,
          mod_time: stat.mtime.toISOString(),
        };
      }),
    ),
  };
}
module.exports = {
  gitStatus,
  gitDiff,
  tree,
  projectRoot,
  readContent,
  contained,
};
