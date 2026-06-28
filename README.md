# WorkWise

https://4l3xv33.github.io/WORKWISE/

WorkWise is a deterministic, browser-based entity matching MVP for analysts reviewing resume work history against a consolidated restricted-entity list.

Tagline: **Get wise on work history.**

WorkWise is not an adjudication tool. It surfaces candidate matches for human review and runs entirely in the browser without a backend, database, API service, or LLM.

## Run locally

Because the app fetches `entities.json`, open it through a local static server rather than directly from the filesystem.

```powershell
python -m http.server 8080
```

Then visit:

```text
http://localhost:8080
```

## Deploy to GitHub Pages

1. Commit `index.html`, `styles.css`, `app.js`, `README.md`, `entities.json`, and `vendor/`.
2. Push the repository to GitHub.
3. In the repository settings, enable GitHub Pages from the branch containing these files.
4. Keep `entities.json` at the site root beside `index.html`.

## Updating `entities.json`

`entities.json` is the single source of truth. WorkWise does not modify it.

The current supported schema is a top-level JSON array whose records include:

```json
{
  "entity": "Entity name and descriptive text",
  "list": "Source list name",
  "source_letter": "Source letter"
}
```

To update the database, replace `entities.json` with a new file using the same shape. The app detects the schema at startup and builds an internal normalized search index in memory.

## Schema normalization

Each raw record is preserved untouched. WorkWise creates an internal representation:

```javascript
{
  id,
  displayName,
  candidates,
  list,
  sourceLetter,
  raw
}
```

The normalization layer derives candidate names from the raw `entity` string by:

- preserving the original display string
- extracting primary names before alias markers
- extracting aliases from `a.k.a.`, `aka`, `formerly known as`, `f/k/a`, parentheticals, semicolons, and dash-separated fragments
- normalizing punctuation, whitespace, capitalization, accents, and ampersands
- filtering weak, short, digit-heavy, or address-like fragments

## Supported formats

WorkWise supports:

- PDF
- DOCX

DOCX files are extracted with Mammoth.js. PDF files are processed with PDF.js.

## OCR behavior

For PDFs, WorkWise first attempts embedded text extraction. OCR is used only when embedded text is missing or too sparse to be meaningful.

OCR runs locally in the browser through Tesseract.js with local worker, core, and English trained-data assets in `vendor/`. OCR is slower than embedded PDF text extraction.

## Matching behavior

Matching runs in this order:

1. Exact or normalized phrase containment
2. Alias containment
3. Fuzzy token-overlap scoring

Fuzzy matching is enabled by default and compares only against derived candidate names and aliases, not the full raw entity string. The right-side threshold control lets analysts tune sensitivity.

## Current limitations

- The MVP highlights extracted text previews, not geometric PDF text overlays on rendered pages.
- OCR currently uses English trained data.
- Fuzzy matching is intentionally conservative and may miss heavily abbreviated or translated names.
- The app does not adjudicate, rank legal risk, or make decisions.
- Very large `entities.json` files are loaded in memory and may need worker-based indexing in a future version.
