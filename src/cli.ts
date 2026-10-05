export async function runCli(argv: string[], input: string): Promise<number> {
  const command = argv[0];
  switch (command) {
    case "version":
      console.log("ai-guard 0.1.0");
      return 0;
    case "check-prompt":
      return (await import("./commands/check-prompt")).checkPrompt(argv.slice(1), input);
    case "check-file":
      return (await import("./commands/check-file")).checkFile(argv.slice(1), input);
    case "allow":
      return (await import("./commands/allow")).allow(argv.slice(1));
    default:
      console.error(
        "ai-guard: unknown or missing command. usage: ai-guard <init|check-prompt|check-file|allow|doctor|self-test|uninstall|version>"
      );
      return 1;
  }
}

if (require.main === module) {
  const chunks: Buffer[] = [];
  process.stdin.on("data", (c) => chunks.push(c));
  process.stdin.on("end", async () => {
    process.exitCode = await runCli(process.argv.slice(2), Buffer.concat(chunks).toString("utf8"));
  });
}
