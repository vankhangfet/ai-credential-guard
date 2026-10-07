#!/usr/bin/env node
// Shebang BẮT BUỘC: npm chỉ sinh shim (.cmd/.ps1/sh) gọi `node <bin>` khi file bin có shebang.
// Thiếu nó, Windows shim chạy cli.js trực tiếp (im lặng exit 0 — hook không bao giờ chạy),
// còn POSIX shim exec file thô → sh parse JS → exit 2 (chặn mọi prompt).

export async function runCli(argv: string[], input: string): Promise<number> {
  const command = argv[0];
  switch (command) {
    case "version":
      console.log("ai-guard 1.0.0");
      return 0;
    case "check-prompt":
      return (await import("./commands/check-prompt")).checkPrompt(argv.slice(1), input);
    case "check-file":
      return (await import("./commands/check-file")).checkFile(argv.slice(1), input);
    case "allow":
      return (await import("./commands/allow")).allow(argv.slice(1));
    case "init":
      return (await import("./commands/init")).init(argv.slice(1), input);
    case "doctor":
      return (await import("./commands/doctor")).doctor(argv.slice(1));
    case "uninstall":
      return (await import("./commands/uninstall")).uninstall(argv.slice(1));
    case "self-test": {
      const { selfTest, printSelfTest } = await import("./commands/self-test");
      const r = selfTest();
      printSelfTest(r);
      return r.failures.length ? 1 : 0;
    }
    default:
      console.error(
        "ai-guard: unknown or missing command. usage: ai-guard <init|check-prompt|check-file|allow|doctor|self-test|uninstall|version>"
      );
      return 1;
  }
}

// chỉ các lệnh này đọc stdin; các lệnh khác (allow, version, ...) phải dispatch ngay
// nếu không sẽ treo ở TTY chờ EOF
export const STDIN_COMMANDS = new Set(["check-prompt", "check-file"]);

if (require.main === module) {
  const command = process.argv[2];
  const dispatch = (input: string) => {
    runCli(process.argv.slice(2), input).then((code) => { process.exitCode = code; });
  };
  if (!STDIN_COMMANDS.has(command)) {
    dispatch("");
  } else {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => dispatch(Buffer.concat(chunks).toString("utf8")));
  }
}
