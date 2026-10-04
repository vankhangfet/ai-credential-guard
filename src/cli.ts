export async function runCli(argv: string[], input: string): Promise<number> {
  const command = argv[0] ?? "help";
  switch (command) {
    case "version":
      console.log("ai-guard 0.1.0");
      return 0;
    default:
      console.error("ai-guard: unknown or unimplemented command: " + command);
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
