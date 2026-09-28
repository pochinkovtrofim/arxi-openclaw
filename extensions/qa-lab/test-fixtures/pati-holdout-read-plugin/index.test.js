import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("Gmail sender headers appear after exact read, not in current metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "pati-qa-gmail-direction-"));
  const previousFixture = process.env.PATI_QA_READ_FIXTURE_PATH;
  const previousEvents = process.env.PATI_QA_READ_EVENTS_PATH;
  try {
    const fixturePath = join(root, "fixture.json");
    const eventsPath = join(root, "events.jsonl");
    const headers = [
      { name: "From", value: "qa-owner@example.invalid" },
      { name: "To", value: "qa-contact@example.invalid" },
    ];
    writeFileSync(
      fixturePath,
      JSON.stringify({
        sessions: {
          "qa-session": {
            google: [
              {
                ref: "e1",
                connectionId: "qa-google-source",
                generation: 1,
                source: "gmail",
                resourceId: "e1",
                revision: "r1",
                text: "Я пришлю договор.",
                headers,
                senderRole: "owner_outgoing",
              },
            ],
            business: [],
          },
        },
      }),
    );
    writeFileSync(eventsPath, "");
    process.env.PATI_QA_READ_FIXTURE_PATH = fixturePath;
    process.env.PATI_QA_READ_EVENTS_PATH = eventsPath;
    const { default: plugin } = await import(`./index.js?test=${Date.now()}`);
    const factories = new Map();
    plugin.register({ registerTool: (factory, { name }) => factories.set(name, factory) });
    const google = factories.get("arxi_google_observation")({
      agentId: "qa",
      sessionKey: "qa-session",
    });
    assert.equal(
      factories.get("arxi_google_observation")({
        agentId: "other",
        sessionKey: "qa-session",
      }),
      null,
    );
    const current = (await google.execute("current", { action: "current" })).details;
    assert.equal(current.observations[0].text, undefined);
    assert.equal(current.observations[0].headers, undefined);
    assert.equal(current.observations[0].senderRole, undefined);
    assert.equal(readFileSync(eventsPath, "utf8"), "");
    const read = (
      await google.execute("read", {
        action: "read",
        connectionId: "qa-google-source",
        generation: 1,
        source: "gmail",
        resourceId: "e1",
        revision: "r1",
      })
    ).details;
    assert.deepEqual(read.data.payload.headers, headers);
    assert.equal(read.senderRole, "owner_outgoing");
    assert.equal(read.observation.senderRole, undefined);
    assert.equal(read.data.snippet, "Я пришлю договор.");
    assert.equal(readFileSync(eventsPath, "utf8").trim().split("\n").length, 1);
  } finally {
    if (previousFixture === undefined) delete process.env.PATI_QA_READ_FIXTURE_PATH;
    else process.env.PATI_QA_READ_FIXTURE_PATH = previousFixture;
    if (previousEvents === undefined) delete process.env.PATI_QA_READ_EVENTS_PATH;
    else process.env.PATI_QA_READ_EVENTS_PATH = previousEvents;
    rmSync(root, { recursive: true, force: true });
  }
});
