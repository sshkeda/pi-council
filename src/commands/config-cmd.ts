import * as fs from "node:fs";
import { loadConfig, getConfigPath, getDefaultConfig, saveConfig } from "../core/config.js";

export function configCmd(args: string[], json?: boolean): void {
  const sub = args[0] ?? "show";

  switch (sub) {
    case "show":
    case "": {
      const config = loadConfig();
      if (json) {
        process.stdout.write(JSON.stringify(config, null, 2) + "\n");
        return;
      }
      const configPath = getConfigPath();
      const modelEntries = Object.entries(config.models);
      const profileEntries = Object.entries(config.profiles);
      const maxId = Math.max(8, ...modelEntries.map(([id]) => id.length));

      process.stdout.write(`📋 Config: ${configPath}\n\n`);

      process.stdout.write(`Models (${modelEntries.length}):\n`);
      for (const [id, def] of modelEntries) {
        process.stdout.write(`  ${id.padEnd(maxId)}  ${def.provider} / ${def.model}\n`);
      }

      process.stdout.write(`\nProfiles (${profileEntries.length}):\n`);
      const maxName = Math.max(8, ...profileEntries.map(([n]) => n.length));
      for (const [name, prof] of profileEntries) {
        const star = name === config.defaultProfile ? " ★" : "  ";
        const extra: string[] = [];
        if (prof.systemPrompt) extra.push("custom prompt");
        if (prof.thinking) extra.push(`thinking: ${prof.thinking}`);
        if (prof.memberTimeoutMs) extra.push(`${prof.memberTimeoutMs / 1000}s timeout`);
        const suffix = extra.length > 0 ? `  (${extra.join(", ")})` : "";
        process.stdout.write(
          `  ${name.padEnd(maxName)}${star}  ${prof.models.join(", ")}${suffix}\n`,
        );
      }

      process.stdout.write(`\nDefault: ${config.defaultProfile}\n`);
      break;
    }

    case "path":
      process.stdout.write(getConfigPath() + "\n");
      break;

    case "init": {
      const configPath = getConfigPath();
      if (fs.existsSync(configPath)) {
        process.stderr.write(`Config already exists: ${configPath}\n`);
        process.stderr.write(`Use "pi-council config" to view it.\n`);
        return;
      }
      saveConfig(getDefaultConfig());
      process.stderr.write(`✅ Created default config at ${configPath}\n`);
      break;
    }

    default:
      process.stderr.write(`Unknown config subcommand: ${sub}\n`);
      process.stderr.write(`Usage: pi-council config [show|path|init]\n`);
      process.exitCode = 1;
  }
}
