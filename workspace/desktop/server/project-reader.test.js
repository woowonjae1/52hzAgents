const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { Store } = require("./store");
const { gitStatus, gitDiff, tree, contained } = require("./project-reader");
const { startServer } = require("./index");

test("project readers report real tracked/untracked diffs and reject escaping paths", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "52hz-git-test-"));
  t.after(async () => {
    assert.ok(directory.startsWith(path.join(os.tmpdir(), "52hz-git-test-")));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const root = path.join(directory, "project");
  await fs.mkdir(root);
  const git = (args) =>
    execFileSync("git", ["-C", root, ...args], {
      windowsHide: true,
      stdio: "pipe",
    });
  git(["init"]);
  await fs.writeFile(path.join(root, "中文 name.txt"), "before\n");
  git(["add", "--", "."]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@invalid",
    "commit",
    "-m",
    "Fixture",
  ]);
  await fs.writeFile(path.join(root, "中文 name.txt"), "after\n");
  await fs.writeFile(path.join(root, "untracked.txt"), "new file\n");
  await fs.writeFile(path.join(directory, "outside.txt"), "outside");
  const store = new Store(directory);
  store.updateChannel("general", { working_dir: root });
  const status = await gitStatus(store, "general");
  assert.equal(status.available, true);
  assert.equal(status.read_only, true);
  assert.equal(
    status.files.find((f) => f.path === "中文 name.txt").status,
    "M",
  );
  assert.equal(
    status.files.find((f) => f.path === "untracked.txt").status,
    "?",
  );
  assert.match(
    (await gitDiff(store, "general", "中文 name.txt")).diff,
    /\+after/,
  );
  assert.match(
    (await gitDiff(store, "general", "untracked.txt")).diff,
    /\+new file/,
  );
  assert.equal(
    (await tree(store, "general")).entries.some((e) => e.name === ".git"),
    false,
  );
  await assert.rejects(contained(root, "../outside.txt"), /outside/);
  await assert.rejects(gitDiff(store, "general", "../outside.txt"), /within/);
  await fs
    .symlink(path.join(directory, "outside.txt"), path.join(root, "link.txt"))
    .catch(() => {});
  if ((await fs.readdir(root)).includes("link.txt"))
    await assert.rejects(contained(root, "link.txt"), /outside/);
  const { server, port } = await startServer({
    port: 0,
    userDataPath: directory,
    staticDir: directory,
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  assert.equal(
    (
      await fetch(
        `http://127.0.0.1:${port}/v1/fs/content?channel=general&path=untracked.txt`,
        { headers: { Origin: "https://untrusted.invalid" } },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(
        `http://127.0.0.1:${port}/v1/fs/content?channel=general&path=untracked.txt`,
      )
    ).status,
    200,
  );
});
