#!/usr/bin/env bun
import { gitEvidence, importGraph, resolveRepo, scanRisks, searchRepo, sourceDigest, summarizeRepo, verifyRepo } from "./core.mjs";
const args = process.argv.slice(2);
const command = args[0] || "summary";
const pathArg = args.find((a, i) => i > 0 && !a.startsWith("--")) || ".";
const root = resolveRepo(pathArg);
const json = (value) => console.log(JSON.stringify(value, null, 2));
switch (command) {
    case "summary":
        json({ ...summarizeRepo(root), git: gitEvidence(root), sourceDigest: sourceDigest(root) });
        break;
    case "scan":
        json(scanRisks(root));
        break;
    case "graph":
        json(importGraph(root));
        break;
    case "search": {
        const query = args[1];
        if (!query)
            throw new Error("Usage: repo:intel -- search <regex> [path]");
        json(searchRepo(resolveRepo(args[2] || "."), query));
        break;
    }
    case "verify": {
        const execute = args.includes("--exec") || /^(1|true|yes|on)$/i.test(process.env.REPO_INTEL_ALLOW_EXEC || "");
        const result = verifyRepo(root, execute);
        json(result);
        if (result.status === "BLOCKED")
            process.exitCode = 1;
        break;
    }
    case "serve": {
        const { createRepoIntelServer } = await import("./mcp.mjs");
        await createRepoIntelServer();
        break;
    }
    default: throw new Error(`Unknown command: ${command}`);
}
