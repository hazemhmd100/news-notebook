import { spawn } from "node:child_process";
const children = [
  spawn(process.execPath, ["server/local.mjs"], { stdio: "inherit" }),
  spawn(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1"],
    { stdio: "inherit" },
  ),
];
let closing = false;
function stop() {
  if (closing) return;
  closing = true;
  for (const child of children) child.kill();
}
for (const child of children)
  child.on("exit", () => {
    stop();
  });
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
