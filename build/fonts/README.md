# The fonts the printed documents are laid out in

Liberation Serif 2.1.5, Regular and Bold, under the SIL Open Font License 1.1
(`LICENSE.txt`, which is the upstream licence file verbatim).

`src/main/documents.cjs` names this family in a `@font-face` rule and the offscreen renderer in
`src/main/pdf.cjs` loads it over `file://`. Nothing here is read by the Node side of the app.

## Why these files are in the repository

The two documents used to ask for `"Times New Roman", Georgia, serif`. That chain resolves against
whatever the machine happens to have installed: Times New Roman exists on macOS and on a Windows
image with Office, and on a bare Linux it does not exist at all — Chromium then substitutes a
different serif face with different advance widths, so the same booking breaks its lines
elsewhere and can change page count. `scripts/e2e-documents.mjs` asserts a page count, so that
assertion was really an assertion about the machine's fonts.

Liberation Serif is **metric-compatible with Times New Roman**: same advance widths, same
units-per-em (2048), same ascent/descent, so the pages already produced keep their line breaks and
their page count while no longer depending on an installed font.

## Why only two of the four files

Regular (400) and Bold (700) are the only weights the two templates use — `h1`/`h2` and the
`tfoot` totals are bold, everything else is regular, and nothing in `src/main/documents.cjs` is
italic. Shipping Italic and Bold Italic would add 750 KB to every installer for faces that would
never be embedded in a PDF.

## What the family does not cover

The contract's own text is Russian and Latin, and both are fully covered (Latin including the
Azerbaijani `ə` and the Turkish `ş`, Greek, Cyrillic, Hebrew, the quotation marks, the em dash and
`№`). It is **not** covered for Armenian, Georgian, Arabic or CJK. Times New Roman, the family this
replaced, does have Armenian and Georgian, so a guest whose name is written in those scripts loses
a face it used to have: those glyphs fall back to a system font while the rest of the page does
not, and that one line's metrics become machine-dependent again.

That is a narrower failure than the one this fixes — the whole document used to depend on the
machine — but it is a real one, and a font with those scripts *and* Times metrics does not exist
under a free licence.

## Provenance

Taken from the Debian `fonts-liberation` package, version `2.1.5-3`
(`http://deb.debian.org/debian/pool/main/f/fonts-liberation/fonts-liberation_2.1.5-3_all.deb`),
which packages the upstream 2.1.5 release — the upstream project publishes no binary release
assets of its own, only sources. The `.deb` was unpacked and the two TTFs copied out byte for byte,
with no re-encoding or subsetting.

| File | sha256 |
|---|---|
| `LiberationSerif-Regular.ttf` | `9caef765d2e891c10dd73658894f01e660fe0c1c83e0bda7d6edf561d8f623d4` |
| `LiberationSerif-Bold.ttf` | `443a4dbd694b6e4689925947b456e0532e10b19c90fa32eb39ea6c2cd9db9ebd` |

The licence has to travel with the files, so `LICENSE.txt` is packed alongside them. The OFL's
Reserved Font Name clause is satisfied by not having modified the fonts: these are the published
files, unrenamed.
