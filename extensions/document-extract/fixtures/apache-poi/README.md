# Embedded VBA fixture

`SimpleMacro.docm` and its exported `SimpleMacro.vba` come unchanged from Apache
POI commit `3e24e7d6f4151b993232ee67faae650ade533712`, directory
[`test-data/document`](https://github.com/apache/poi/tree/3e24e7d6f4151b993232ee67faae650ade533712/test-data/document).
The adjacent LICENSE and NOTICE come from the same repository commit.

The VBA procedure changes the first paragraph to a known sentence. Extraction
must read existing document text without producing that macro effect. This
fixture contains a real VBA project; the other OOXML fixtures test macro-enabled
container variants. The separate EPUB script test observes file/process/network
side effects from an embedded executable payload.
