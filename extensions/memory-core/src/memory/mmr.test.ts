// Memory Core tests cover MMR behavior through the production result adapter.
import { describe, expect, it } from "vitest";
import { mergeHybridResults } from "./hybrid.js";
import { applyMMRToHybridResults } from "./mmr.js";
import { jaccardSimilarity, textSimilarity, tokenize } from "./tokenize.js";

describe("memory MMR", () => {
  it.each([{ text: "中文🙂今天", expected: ["中文", "今天", "中", "文", "今", "天"] }])(
    "tokenizes $text in stable term order",
    ({ text, expected }) => {
      expect([...tokenize(text)]).toEqual(expected);
    },
  );

  it("compares token sets and falls back to literal equality for empty token sets", () => {
    expect(jaccardSimilarity(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(1 / 3);
    expect(textSimilarity("Привет мир", "Доброе утро")).toBe(0);
    expect(textSimilarity("🦞🦞", "🦞🦞")).toBe(1);
  });

  it.each([
    {
      name: "diversifies NFC-equivalent kana",
      results: [
        ["/primary.md", 1, "が"],
        ["/duplicate.md", 0.98, "\u304b\u3099"],
        ["/diverse.md", 0.94, "な"],
        ["/tail.md", 0.4, "garden compost schedule"],
      ],
      expected: ["/primary.md", "/diverse.md", "/duplicate.md", "/tail.md"],
    },
    {
      name: "keeps input order as the tie breaker for equal relevance and diversity",
      results: [
        ["/first.md", 1, "alpha"],
        ["/second.md", 1, "beta"],
        ["/third.md", 1, "gamma"],
      ],
      expected: ["/first.md", "/second.md", "/third.md"],
    },
  ])("$name", ({ results, expected }) => {
    const candidates = results.map(([path, score, snippet]) => ({
      path: String(path),
      startLine: 1,
      endLine: 1,
      score: Number(score),
      snippet: String(snippet),
    }));
    const scores = new Map(candidates.map((result) => [result.path, result.score]));

    const reranked = applyMMRToHybridResults(candidates, 0.7);

    expect(reranked.map((result) => result.path)).toEqual(expected);
    expect(reranked.map((result) => result.score)).toEqual(
      expected.map((path) => scores.get(path)),
    );
    for (const result of reranked) {
      expect(result).toBe(candidates.find((candidate) => candidate.path === result.path));
    }
  });

  it.each([["server Москва резервная копия", "server Берлин погода сегодня"]])(
    "retains distinct mixed-script memories sharing an ASCII term: %s",
    (primary, distinct) => {
      const results = [
        { path: "/primary.md", startLine: 1, score: 1, snippet: primary },
        { path: "/distinct.md", startLine: 1, score: 0.98, snippet: distinct },
        { path: "/weak.md", startLine: 1, score: 0.9, snippet: "database connection pool" },
        { path: "/tail.md", startLine: 1, score: 0.1, snippet: "garden compost schedule" },
      ];

      expect(applyMMRToHybridResults(results, 0.7).map((entry) => entry.path)).toEqual([
        "/primary.md",
        "/distinct.md",
        "/weak.md",
        "/tail.md",
      ]);
    },
  );

  it.each([{ mmr: { enabled: true }, paths: ["/a", "/c", "/b", "/d"] }])(
    "applies hybrid MMR defaults for $mmr",
    async ({ mmr, paths }) => {
      const results = [
        { path: "/a", startLine: 1, endLine: 1, score: 1, snippet: "same", source: "memory" },
        { path: "/b", startLine: 1, endLine: 1, score: 0.9, snippet: "same", source: "memory" },
        {
          path: "/c",
          startLine: 1,
          endLine: 1,
          score: 0.85,
          snippet: "different",
          source: "memory",
        },
        { path: "/d", startLine: 1, endLine: 1, score: 0.1, snippet: "tail", source: "memory" },
      ];

      const merged = await mergeHybridResults({
        vector: results.map((result) => ({
          ...result,
          id: result.path,
          vectorScore: result.score,
        })),
        keyword: [],
        vectorWeight: 1,
        textWeight: 0,
        mmr,
      });
      expect(merged).toEqual(
        paths.map((path) =>
          expect.objectContaining(results.find((result) => result.path === path)!),
        ),
      );
    },
  );

  it("orders like the string-set Jaccard reference", () => {
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
    const words = ["смета", "дом", "крыша", "окно", "meeting", "budget", "roof", "и", "в", "план"];
    const items = Array.from({ length: 60 }, (_, index) => ({
      path: `memory/${index}.md`,
      score: Math.round(next() * 20) / 20,
      snippet: Array.from(
        { length: 1 + Math.floor(next() * 8) },
        () => words[Math.floor(next() * words.length)],
      ).join(" "),
    }));
    // The pre-optimization greedy order over Set<string> tokens.
    const reference = (lambda: number) => {
      const relevance = (score: number) => {
        const scores = items.map((item) => item.score);
        const [min, max] = [Math.min(...scores), Math.max(...scores)];
        return max === min ? 1 : (score - min) / (max - min);
      };
      const remaining = new Set(items);
      const maxSimilarity = new Map(items.map((item) => [item, 0]));
      const order: string[] = [];
      while (remaining.size > 0) {
        let best: (typeof items)[number] | undefined;
        let bestScore = -Infinity;
        for (const item of remaining) {
          const value =
            lambda * relevance(item.score) - (1 - lambda) * (maxSimilarity.get(item) ?? 0);
          if (value > bestScore || (value === bestScore && item.score > (best?.score ?? -1))) {
            bestScore = value;
            best = item;
          }
        }
        if (!best) {
          break;
        }
        order.push(best.path);
        remaining.delete(best);
        for (const item of remaining) {
          const similarity = jaccardSimilarity(tokenize(item.snippet), tokenize(best.snippet));
          maxSimilarity.set(item, Math.max(maxSimilarity.get(item) ?? 0, similarity));
        }
      }
      return order;
    };
    for (const lambda of [0, 0.3, 0.7]) {
      expect(applyMMRToHybridResults(items, lambda).map((item) => item.path)).toEqual(
        reference(lambda),
      );
    }
  });
});
