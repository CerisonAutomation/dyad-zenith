import { describe, it, expect } from "vitest";
import { extractJson, extractJsonArray, buildSeverityReport } from "./llm_analysis_factory";

describe("llm_analysis_factory", () => {
  describe("extractJson", () => {
    it("extracts a JSON object from text", () => {
      const text = `Here is the analysis:
{
  "summary": "All good",
  "score": 85
}
End of analysis.`;
      const result = extractJson<{ summary: string; score: number }>(text);
      expect(result).toEqual({ summary: "All good", score: 85 });
    });

    it("returns null when no JSON is found", () => {
      const text = "No JSON here, just plain text.";
      expect(extractJson(text)).toBeNull();
    });

    it("returns null for invalid JSON", () => {
      const text = `{ "broken": }`;
      expect(extractJson(text)).toBeNull();
    });

    it("extracts JSON when surrounded by text", () => {
      const text = `Here is the result:
{"a": 1}
End of result.`;
      const result = extractJson<{ a: number }>(text);
      expect(result).toEqual({ a: 1 });
    });
  });

  describe("extractJsonArray", () => {
    it("extracts a JSON array from text", () => {
      const text = `Results:
[
  {"id": 1, "name": "test"},
  {"id": 2, "name": "prod"}
]`;
      const result = extractJsonArray<{ id: number; name: string }>(text);
      expect(result).toEqual([
        { id: 1, name: "test" },
        { id: 2, name: "prod" },
      ]);
    });

    it("returns null when no array is found", () => {
      const text = "Just text, no arrays.";
      expect(extractJsonArray(text)).toBeNull();
    });

    it("returns null for invalid JSON array", () => {
      const text = `[{ "broken": }]`;
      expect(extractJsonArray(text)).toBeNull();
    });
  });

  describe("buildSeverityReport", () => {
    it("groups issues by severity", () => {
      const issues = [
        { severity: "critical", title: "SQL injection", location: "db.ts:10" },
        { severity: "high", title: "XSS risk", location: "ui.ts:5" },
        { severity: "medium", title: "Console log", location: "app.ts:20" },
        { severity: "low", title: "TODO comment", location: "utils.ts:3" },
      ];
      const report = buildSeverityReport(issues, { title: "Security Report" });
      expect(report).toContain("# Security Report");
      expect(report).toContain("🔴 Critical: 1");
      expect(report).toContain("🟠 High: 1");
      expect(report).toContain("🟡 Medium: 1");
      expect(report).toContain("🔵 Low: 1");
      expect(report).toContain("SQL injection");
      expect(report).toContain("XSS risk");
    });

    it("shows 'No issues found' for empty array", () => {
      const report = buildSeverityReport([]);
      expect(report).toContain("No issues found");
    });

    it("includes fix suggestions when showFixes is true", () => {
      const issues = [
        {
          severity: "critical",
          title: "Eval usage",
          location: "eval.ts:1",
          fix: "Remove eval()",
        },
      ];
      const report = buildSeverityReport(issues, { showFixes: true });
      expect(report).toContain("Remove eval()");
    });

    it("hides fix suggestions when showFixes is false", () => {
      const issues = [
        {
          severity: "critical",
          title: "Eval usage",
          location: "eval.ts:1",
          fix: "Remove eval()",
        },
      ];
      const report = buildSeverityReport(issues, { showFixes: false });
      expect(report).not.toContain("Remove eval()");
    });

    it("handles issues with missing optional fields", () => {
      const issues = [
        { severity: "high", title: "Something" },
      ];
      const report = buildSeverityReport(issues);
      expect(report).toContain("Something");
      expect(report).toContain("🟠 High: 1");
    });
  });
});
