import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";

const problems = [];
if (process.platform !== "darwin") problems.push("macOS is required. Windows and Linux are not supported by Apple Vision.");
if (Number(process.versions.node.split(".")[0]) < 22) problems.push("Install Node.js 22 or later from https://nodejs.org/.");
if (process.platform === "darwin") {
  const version = execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" }).trim();
  if (Number(version.split(".")[0]) < 15) problems.push("macOS 15 or later is required for Trash support via /usr/bin/trash.");
  for (const binary of ["/usr/bin/sips", "/usr/bin/trash", "/usr/bin/open"]) {
    try { accessSync(binary, constants.X_OK); } catch { problems.push(`Missing ${binary}.`); }
  }
  try {
    execFileSync("/usr/bin/xcrun", ["--find", "swiftc"], { stdio: "pipe" });
  } catch {
    problems.push("Install Command Line Tools with: xcode-select --install. The full Xcode app is not required.");
  }
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Requirements available: Node.js, macOS, Swift, and system tools.");
}
