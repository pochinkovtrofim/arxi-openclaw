# AnyDoc source fixtures

These files are copied without conversion from
[AnyDoc v0.2.4](https://github.com/firecrawl/anydoc/tree/v0.2.4/tests/fixtures),
commit `42bf1c5ecdde9eb0d96d6bd75a9e6698cf93b14c`. Relative paths below this
directory match `tests/fixtures/` upstream. The adjacent MIT license applies.

Fixtures are test inputs, including intentionally hostile documents. Their
presence does not qualify a format for Arxi. Qualification must execute the
bundled extractor and the exact Linux native binding inside the candidate
Runtime, followed by the private Telegram composition.

Expected headings, tables, and speaker-note markers in the tests were inspected
in the upstream snapshots at the same commit. XLS and XLSB use AnyDoc's `xlsx`
binding enum because the Rust Excel parser dispatches those container variants.
PPT table text can be flattened; the test does not claim OOXML table semantics
for that format. Macro-enabled containers are constructed in the test from
these sources; that check alone does not prove execution containment for VBA.
