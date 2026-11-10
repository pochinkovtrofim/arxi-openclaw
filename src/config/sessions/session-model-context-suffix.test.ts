import { describe, expect, it } from "vitest";
import { selectSessionContextSuffix } from "./session-model-context-suffix.js";

type Row = Record<string, unknown> & { seq: number };

function chain(types: Array<string | Record<string, unknown>>): Row[] {
  return types.map((spec, seq) => ({
    ...(typeof spec === "string" ? { type: spec } : spec),
    id: `e${seq}`,
    parentId: seq === 0 ? null : `e${seq - 1}`,
    seq,
  }));
}

function select(
  rows: Row[],
  stateBefore?: (seq: number, wanted: { model: boolean; thinking: boolean }) => Row[] | undefined,
) {
  let read = 0;
  const result = selectSessionContextSuffix<Row>({
    *newestRows(limit) {
      for (const row of rows.toReversed().slice(0, limit)) {
        read += 1;
        yield row;
      }
    },
    ...(stateBefore ? { stateBefore } : {}),
  });
  return { result, read };
}

const assistant = { type: "message", message: { role: "assistant" } };
const user = { type: "message", message: { role: "user" } };

describe("selectSessionContextSuffix", () => {
  it("starts at the newest reset and reads nothing older", () => {
    const rows = chain([user, assistant, "reset", user, "reset", "model_change", user]);
    const { result, read } = select(rows);
    expect(result).toEqual({ state: [], rows: rows.slice(4) });
    expect(read).toBe(3);
  });

  it("starts at the first entry the newest boundary keeps", () => {
    const rows = chain([user, "reset", user, assistant, user, "compaction", user]);
    rows[5]!.firstKeptEntryId = "e3";
    expect(select(rows).result).toEqual({ state: [], rows: rows.slice(3) });
    rows[5]!.firstKeptEntryId = "e0";
    expect(select(rows).result).toEqual({ state: [], rows });
  });

  it("leaves the whole session to the caller when no bounded suffix is certain", () => {
    expect(select(chain([user, assistant, user])).result).toBeUndefined();
    const missingKeep = chain([user, "compaction", user]);
    missingKeep[1]!.firstKeptEntryId = "gone";
    expect(select(missingKeep).result).toBeUndefined();
    const long = chain(["reset", ...Array.from({ length: 5000 }, () => user)]);
    expect(select(long).result).toBeUndefined();
  });

  it.each([
    ["a row that continues another row", (rows: Row[]) => (rows[4]!.parentId = "e1")],
    ["a leaf control", (rows: Row[]) => (rows[4]!.type = "leaf")],
    ["a side append", (rows: Row[]) => (rows[4]!.appendMode = "side")],
    ["an opaque row", (rows: Row[]) => (rows[4]!.type = "plugin-note")],
    [
      "a repeated id",
      (rows: Row[]) => {
        rows[4]!.id = "e3";
        rows[5]!.parentId = "e3";
      },
    ],
    [
      "a row without an id",
      (rows: Row[]) => {
        delete rows[3]!.id;
        rows[4]!.parentId = undefined;
      },
    ],
    ["a boundary with a malformed parent", (rows: Row[]) => (rows[2]!.parentId = 7)],
  ])("leaves the whole session to the caller for %s", (_name, change) => {
    const rows = chain([user, assistant, "reset", user, assistant, user]);
    change(rows);
    expect(select(rows).result).toBeUndefined();
  });

  it("starts at a boundary that names itself as the entry it keeps", () => {
    const rows = chain([user, assistant, "reset", user]);
    rows[2]!.firstKeptEntryId = "e2";
    expect(select(rows).result).toEqual({ state: [], rows: rows.slice(2) });
  });

  it("asks only for the state its rows do not carry", () => {
    const rows = chain(["thinking_level_change", assistant, "reset", user]);
    const asked: unknown[] = [];
    const stateBefore = (seq: number, wanted: { model: boolean; thinking: boolean }) => {
      asked.push([seq, wanted]);
      return [rows[0]!, rows[1]!];
    };
    expect(select(rows, stateBefore).result).toEqual({
      state: [rows[0], rows[1]],
      rows: rows.slice(2),
    });
    expect(asked).toEqual([[2, { model: true, thinking: true }]]);
    const partial = chain([assistant, "reset", "model_change", user]);
    select(partial, stateBefore);
    expect(asked[1]).toEqual([1, { model: false, thinking: true }]);
    const complete = chain([assistant, "reset", "model_change", "thinking_level_change"]);
    expect(
      select(complete, () => {
        throw new Error("state already in the suffix");
      }).result,
    ).toEqual({ state: [], rows: complete.slice(1) });
  });

  it("leaves the whole session to the caller when earlier state is uncertain", () => {
    const rows = chain([user, "reset", user]);
    expect(select(rows, () => undefined).result).toBeUndefined();
    expect(select(rows, () => []).result).toEqual({ state: [], rows: rows.slice(1) });
  });
});
