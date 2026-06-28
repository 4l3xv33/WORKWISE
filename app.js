/* global pdfjsLib, mammoth, Tesseract */

const state = {
  rawEntities: [],
  normalizedEntities: [],
  candidateIndex: [],
  resumeText: "",
  normalizedResume: "",
  resumeFile: null,
  findings: [],
  pdfDocument: null
};

const dom = {
  resumeInput: document.getElementById("resumeInput"),
  clearButton: document.getElementById("clearButton"),
  preview: document.getElementById("preview"),
  previewMeta: document.getElementById("previewMeta"),
  findingsMeta: document.getElementById("findingsMeta"),
  results: document.getElementById("results"),
  terminalLog: document.getElementById("terminalLog"),
  entityCount: document.getElementById("entityCount"),
  candidateCount: document.getElementById("candidateCount"),
  findingCount: document.getElementById("findingCount"),
  fuzzyToggle: document.getElementById("fuzzyToggle"),
  thresholdInput: document.getElementById("thresholdInput"),
  thresholdValue: document.getElementById("thresholdValue")
};

const highlightClasses = ["hit-0", "hit-1", "hit-2", "hit-3", "hit-4", "hit-5"];
const addressWords = new Set(["street", "st", "road", "rd", "avenue", "ave", "floor", "room", "building", "district", "province", "oblast", "city", "russia", "china", "hong", "kong", "moscow", "belarus"]);
const weakWords = new Set(["the", "and", "of", "for", "to", "in", "on", "at", "a", "an", "company", "limited", "ltd", "inc", "llc", "co", "corp", "corporation"]);

pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";

document.addEventListener("DOMContentLoaded", initialize);
dom.resumeInput.addEventListener("change", handleResumeUpload);
dom.clearButton.addEventListener("click", clearResume);
dom.thresholdInput.addEventListener("input", () => {
  dom.thresholdValue.value = dom.thresholdInput.value;
});
dom.fuzzyToggle.addEventListener("change", rerunScanIfReady);
dom.thresholdInput.addEventListener("change", rerunScanIfReady);

async function initialize() {
  logStep("Initializing WorkWise...");
  try {
    state.rawEntities = await loadEntities();
    const schema = detectEntitySchema(state.rawEntities);
    logStep(`Detected entity schema: ${schema.join(", ")}`);
    state.normalizedEntities = await normalizeEntities(state.rawEntities);
    state.candidateIndex = buildCandidateIndex(state.normalizedEntities);
    dom.entityCount.textContent = state.normalizedEntities.length.toLocaleString();
    dom.candidateCount.textContent = state.candidateIndex.length.toLocaleString();
    dom.findingsMeta.textContent = "Ready for resume review.";
    logStep(`Normalized ${state.normalizedEntities.length.toLocaleString()} entities into ${state.candidateIndex.length.toLocaleString()} searchable names.`);
    logStep("Complete.");
  } catch (error) {
    logStep(`Initialization failed: ${error.message}`);
    dom.findingsMeta.textContent = "Could not load entities.json.";
  }
}

async function loadEntities() {
  logStep("Loading entity database...");
  const response = await fetch("entities.json");
  if (!response.ok) throw new Error(`entities.json returned ${response.status}`);
  const entities = await response.json();
  if (!Array.isArray(entities)) throw new Error("entities.json must contain a top-level array");
  return entities;
}

function detectEntitySchema(records) {
  const first = records.find((record) => record && typeof record === "object") || {};
  return Object.keys(first);
}

async function normalizeEntities(records) {
  logStep("Normalizing entity database...");
  const normalized = [];
  for (let i = 0; i < records.length; i += 1) {
    const raw = records[i];
    const displayName = String(raw.entity || "").trim();
    const candidates = deriveCandidates(displayName);
    normalized.push({
      id: i,
      displayName,
      candidates,
      list: raw.list || "",
      sourceLetter: raw.source_letter || "",
      raw
    });
    if (i > 0 && i % 1200 === 0) {
      logStep(`Normalized ${i.toLocaleString()} entity records...`);
      await yieldToBrowser();
    }
  }
  return normalized;
}

function deriveCandidates(entityText) {
  const fixed = repairMojibake(entityText);
  const candidates = new Map();
  const add = (value, type = "candidate") => {
    const cleaned = cleanCandidate(value);
    const normalized = normalizeName(cleaned);
    if (!isStrongCandidate(cleaned, normalized)) return;
    candidates.set(normalized, { text: cleaned, normalized, type, tokens: tokenize(normalized) });
  };

  const beforeAlias = fixed.split(/\b(?:a\.k\.a\.|aka|also known as|formerly known as|f\/k\/a)\b/i)[0];
  add(beforeAlias.split(/[.;]/)[0], "primary");

  for (const match of fixed.matchAll(/\(([^)]{3,120})\)/g)) {
    add(match[1], "alias");
  }

  const aliasSplit = fixed.split(/\b(?:a\.k\.a\.|aka|also known as|formerly known as|f\/k\/a)\b/i);
  if (aliasSplit.length > 1) {
    aliasSplit.slice(1).join(" ").split(/;|—|--|\band\b/i).forEach((part) => add(part, "alias"));
  }

  fixed.split(/;|—|--/).forEach((part) => {
    if (/\b(?:company|corporation|corp|limited|ltd|inc|jsc|llc|institute|university|bank|group|plant|factory|trading|technology|systems?)\b/i.test(part)) {
      add(part, "candidate");
    }
  });

  return Array.from(candidates.values()).slice(0, 12);
}

function repairMojibake(value) {
  return value
    .replaceAll("â€”", "—")
    .replaceAll("â€œ", "\"")
    .replaceAll("â€", "\"")
    .replaceAll("â€™", "'")
    .replaceAll("â€˜", "'");
}

function cleanCandidate(value) {
  return String(value)
    .replace(/\bthe following\s+\w+\s+aliases?:/gi, " ")
    .replace(/\bthe following\s+\w+\s+alias:/gi, " ")
    .replace(/\bformerly known as\b/gi, " ")
    .replace(/\ba\.k\.a\.\b/gi, " ")
    .replace(/\baka\b/gi, " ")
    .replace(/\bf\/k\/a\b/gi, " ")
    .replace(/\b(?:ul\.|st\.|street|road|avenue|floor|room|district)\b.*$/i, " ")
    .replace(/\b\d{4,}\b.*$/g, " ")
    .replace(/^[\s,.;:—-]+|[\s,.;:—-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeName(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/['"“”‘’]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value) {
  return normalizeName(value).split(" ").filter(Boolean);
}

function isStrongCandidate(cleaned, normalized) {
  const tokens = tokenize(normalized);
  if (normalized.length < 4 || tokens.length === 0) return false;
  if (tokens.length === 1 && normalized.length < 6) return false;
  const addressHits = tokens.filter((token) => addressWords.has(token)).length;
  if (addressHits >= 2) return false;
  const digitHeavy = cleaned.replace(/\D/g, "").length / Math.max(cleaned.length, 1) > 0.28;
  if (digitHeavy) return false;
  const meaningful = tokens.filter((token) => !weakWords.has(token) && token.length > 1);
  return meaningful.length > 0;
}

function buildCandidateIndex(entities) {
  const index = [];
  entities.forEach((entity) => {
    entity.candidates.forEach((candidate) => {
      index.push({ entity, candidate });
    });
  });
  return index.sort((a, b) => b.candidate.normalized.length - a.candidate.normalized.length);
}

async function handleResumeUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  state.resumeFile = file;
  state.findings = [];
  dom.clearButton.disabled = false;
  dom.results.innerHTML = "";
  dom.findingCount.textContent = "0";
  logStep("Resume uploaded...");
  logStep(`Detected file: ${file.name}`);

  try {
    const extraction = await extractResumeText(file);
    state.resumeText = extraction.text;
    state.pdfDocument = extraction.pdfDocument || null;
    logStep("Normalizing resume...");
    state.normalizedResume = normalizeResume(state.resumeText);
    await renderPreview(file, extraction);
    logStep("Searching entities...");
    state.findings = await scanEntities(state.normalizedResume, state.resumeText, {
      fuzzy: dom.fuzzyToggle.checked,
      threshold: Number(dom.thresholdInput.value)
    });
    logStep("Rendering findings...");
    renderResults(state.findings);
    highlightMatches(state.findings);
    logStep("Complete.");
  } catch (error) {
    logStep(`Processing failed: ${error.message}`);
    dom.previewMeta.textContent = "Unable to process this file.";
  }
}

async function extractResumeText(file) {
  const lowerName = file.name.toLowerCase();
  if (file.type.includes("word") || lowerName.endsWith(".docx")) {
    return { type: "docx", text: await extractTextFromDocx(file) };
  }
  if (file.type === "application/pdf" || lowerName.endsWith(".pdf")) {
    return extractTextFromPdf(file);
  }
  throw new Error("Unsupported file type. Please upload a PDF or DOCX.");
}

async function extractTextFromDocx(file) {
  logStep("Extracting text from DOCX...");
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value || "";
}

async function extractTextFromPdf(file) {
  logStep("Extracting text from PDF...");
  logStep("Checking embedded PDF text...");
  const arrayBuffer = await file.arrayBuffer();
  const pdfDocument = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber);
    const textContent = await page.getTextContent();
    pages.push(textContent.items.map((item) => item.str).join(" "));
    if (pageNumber % 4 === 0) await yieldToBrowser();
  }
  const embeddedText = pages.join("\n\n");
  if (hasMeaningfulText(embeddedText)) {
    logStep("Embedded text found...");
    return { type: "pdf", text: embeddedText, pdfDocument, usedOcr: false };
  }
  logStep("No embedded text detected...");
  const ocrText = await runPdfOcr(pdfDocument);
  return { type: "pdf", text: ocrText, pdfDocument, usedOcr: true };
}

function hasMeaningfulText(text) {
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  return letters > 160 && text.replace(/\s+/g, " ").trim().length > 260;
}

async function runPdfOcr(pdfDocument) {
  logStep("Running OCR...");
  const worker = await Tesseract.createWorker("eng", 1, {
    workerPath: "vendor/tesseract.worker.min.js",
    corePath: "vendor/tesseract-core-lstm.wasm.js",
    langPath: "vendor",
    gzip: true,
    logger: (message) => {
      if (message.status && typeof message.progress === "number") {
        const pct = Math.round(message.progress * 100);
        if (pct % 25 === 0) logStep(`OCR ${message.status}: ${pct}%`);
      }
    }
  });
  const chunks = [];
  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1.8 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    logStep(`OCR page ${pageNumber} of ${pdfDocument.numPages}...`);
    const result = await worker.recognize(canvas);
    chunks.push(result.data.text || "");
    await yieldToBrowser();
  }
  await worker.terminate();
  logStep("OCR complete...");
  return chunks.join("\n\n");
}

function normalizeResume(text) {
  return ` ${normalizeName(text)} `;
}

async function scanEntities(normalizedResume, originalText, options) {
  logStep("Scoring candidate matches...");
  const matches = new Map();
  const resumeTokens = new Set(tokenize(normalizedResume));
  const candidatePool = options.fuzzy ? prefilterCandidates(resumeTokens) : state.candidateIndex;

  for (let i = 0; i < state.candidateIndex.length; i += 1) {
    const item = state.candidateIndex[i];
    const candidate = item.candidate.normalized;
    let match = null;

    if (normalizedResume.includes(` ${candidate} `)) {
      match = makeMatch(item, "normalized", 100, originalText);
    } else if (item.candidate.type === "alias" && normalizedResume.includes(candidate)) {
      match = makeMatch(item, "alias", 96, originalText);
    }

    if (match) mergeMatch(matches, match);
    if (i > 0 && i % 2500 === 0) await yieldToBrowser();
  }

  if (options.fuzzy) {
    let checked = 0;
    for (const item of candidatePool) {
      checked += 1;
      if (matches.has(item.entity.id)) continue;
      const score = fuzzyScore(item.candidate.tokens, resumeTokens);
      if (score >= options.threshold) {
        mergeMatch(matches, makeMatch(item, "fuzzy", score, originalText));
      }
      if (checked % 1800 === 0) await yieldToBrowser();
    }
  }

  return Array.from(matches.values())
    .sort((a, b) => b.score - a.score || a.entity.displayName.localeCompare(b.entity.displayName))
    .slice(0, 250);
}

function prefilterCandidates(resumeTokens) {
  return state.candidateIndex.filter(({ candidate }) => {
    const meaningful = candidate.tokens.filter((token) => !weakWords.has(token) && token.length > 2);
    if (!meaningful.length) return false;
    const overlap = meaningful.filter((token) => resumeTokens.has(token)).length;
    return overlap >= Math.min(2, meaningful.length);
  });
}

function fuzzyScore(candidateTokens, resumeTokens) {
  const meaningful = candidateTokens.filter((token) => !weakWords.has(token));
  if (!meaningful.length) return 0;
  const hits = meaningful.filter((token) => resumeTokens.has(token)).length;
  const coverage = hits / meaningful.length;
  if (coverage < 0.66) return 0;
  const density = hits / Math.max(candidateTokens.length, 1);
  return Math.round((coverage * 0.78 + density * 0.22) * 100);
}

function makeMatch(item, type, score, originalText) {
  return {
    id: item.entity.id,
    entity: item.entity,
    candidate: item.candidate.text,
    normalizedCandidate: item.candidate.normalized,
    type: type === "normalized" && item.candidate.type === "primary" ? "exact/normalized" : type,
    score,
    snippet: getContextSnippet(originalText, item.candidate.text, item.candidate.normalized)
  };
}

function mergeMatch(matches, match) {
  const existing = matches.get(match.id);
  if (!existing || match.score > existing.score) matches.set(match.id, match);
}

function getContextSnippet(text, candidateText, normalizedCandidate) {
  const direct = text.toLowerCase().indexOf(candidateText.toLowerCase());
  if (direct >= 0) return compactSnippet(text, direct, candidateText.length);
  const tokens = tokenize(normalizedCandidate).filter((token) => !weakWords.has(token) && token.length > 2);
  for (const token of tokens) {
    const index = text.toLowerCase().indexOf(token.toLowerCase());
    if (index >= 0) return compactSnippet(text, index, token.length);
  }
  return "No direct text span found; surfaced by normalized token overlap.";
}

function compactSnippet(text, index, length) {
  const start = Math.max(0, index - 80);
  const end = Math.min(text.length, index + length + 100);
  return `${start > 0 ? "..." : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "..." : ""}`;
}

async function renderPreview(file, extraction) {
  dom.preview.className = "preview";
  dom.preview.innerHTML = "";
  dom.previewMeta.textContent = `${file.name} · ${Math.max(1, Math.round(extraction.text.length / 1000)).toLocaleString()}k text characters${extraction.usedOcr ? " · OCR fallback used" : ""}`;

  if (extraction.type === "pdf" && extraction.pdfDocument) {
    const wrapper = document.createElement("div");
    wrapper.className = "pdf-render";
    dom.preview.appendChild(wrapper);
    const maxPages = Math.min(extraction.pdfDocument.numPages, 12);
    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      const pageShell = document.createElement("div");
      pageShell.className = "pdf-page";
      const canvas = document.createElement("canvas");
      pageShell.appendChild(canvas);
      wrapper.appendChild(pageShell);
      const page = await extraction.pdfDocument.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1.25 });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      await yieldToBrowser();
    }
    const textLayer = document.createElement("div");
    textLayer.className = "pdf-text-preview";
    textLayer.dataset.textPreview = "true";
    textLayer.textContent = extraction.text;
    dom.preview.appendChild(textLayer);
    return;
  }

  const documentText = document.createElement("div");
  documentText.className = "doc-preview";
  documentText.dataset.textPreview = "true";
  documentText.textContent = extraction.text || "No extractable text found.";
  dom.preview.appendChild(documentText);
}

function renderResults(findings) {
  dom.findingCount.textContent = findings.length.toLocaleString();
  dom.findingsMeta.textContent = findings.length ? `${findings.length.toLocaleString()} candidate matches surfaced.` : "No candidate matches found.";
  dom.results.className = findings.length ? "results" : "results empty-results";
  if (!findings.length) {
    dom.results.innerHTML = "<p>No findings found for this resume.</p>";
    return;
  }

  dom.results.innerHTML = findings.map((finding, index) => `
    <article class="finding" style="border-left-color:${colorFor(index)}">
      <button type="button" data-scroll-target="${finding.id}">
        <div class="finding-title">${escapeHtml(finding.entity.displayName)}</div>
        <div class="finding-meta">
          <span class="pill">${escapeHtml(finding.type)}</span>
          <span class="pill">${finding.score}%</span>
          <span class="pill">${escapeHtml(finding.entity.list)}</span>
          <span class="pill">source ${escapeHtml(finding.entity.sourceLetter)}</span>
        </div>
        <p class="snippet"><strong>Matched:</strong> ${escapeHtml(finding.candidate)}</p>
        <p class="snippet">${escapeHtml(finding.snippet)}</p>
      </button>
      <details>
        <summary>Raw metadata</summary>
        <pre class="raw-json">${escapeHtml(JSON.stringify(finding.entity.raw, null, 2))}</pre>
      </details>
    </article>
  `).join("");

  dom.results.querySelectorAll("[data-scroll-target]").forEach((button) => {
    button.addEventListener("click", () => scrollToFinding(button.dataset.scrollTarget));
  });
}

function highlightMatches(findings) {
  const textPreview = dom.preview.querySelector("[data-text-preview]");
  if (!textPreview) return;
  let text = state.resumeText || textPreview.textContent;
  const replacements = [];
  findings.slice(0, 80).forEach((finding, index) => {
    const phrase = findBestHighlightPhrase(text, finding);
    if (!phrase) return;
    const location = text.toLowerCase().indexOf(phrase.toLowerCase());
    if (location >= 0) {
      replacements.push({ start: location, end: location + phrase.length, finding, index });
    }
  });

  replacements.sort((a, b) => a.start - b.start);
  const nonOverlapping = [];
  for (const item of replacements) {
    if (!nonOverlapping.length || item.start >= nonOverlapping[nonOverlapping.length - 1].end) {
      nonOverlapping.push(item);
    }
  }

  let html = "";
  let cursor = 0;
  for (const item of nonOverlapping) {
    html += escapeHtml(text.slice(cursor, item.start));
    html += `<mark id="hit-${item.finding.id}" class="hit ${highlightClasses[item.index % highlightClasses.length]}">${escapeHtml(text.slice(item.start, item.end))}</mark>`;
    cursor = item.end;
  }
  html += escapeHtml(text.slice(cursor));
  textPreview.innerHTML = html;
}

function findBestHighlightPhrase(text, finding) {
  if (text.toLowerCase().includes(finding.candidate.toLowerCase())) return finding.candidate;
  const tokens = tokenize(finding.normalizedCandidate).filter((token) => !weakWords.has(token) && token.length > 2);
  return tokens.find((token) => text.toLowerCase().includes(token.toLowerCase())) || "";
}

function scrollToFinding(id) {
  const target = document.getElementById(`hit-${id}`);
  if (!target) return;
  dom.preview.querySelectorAll(".active-hit").forEach((node) => node.classList.remove("active-hit"));
  target.classList.add("active-hit");
  target.scrollIntoView({ block: "center", behavior: "smooth" });
}

function colorFor(index) {
  const colors = ["#176f6b", "#b86d16", "#9b2d35", "#4a65a1", "#477e54", "#69599f"];
  return colors[index % colors.length];
}

function clearResume() {
  state.resumeFile = null;
  state.resumeText = "";
  state.normalizedResume = "";
  state.findings = [];
  dom.resumeInput.value = "";
  dom.clearButton.disabled = true;
  dom.preview.className = "preview empty-state";
  dom.preview.innerHTML = "<div><strong>No resume loaded</strong><span>Detected candidate matches will be highlighted here.</span></div>";
  dom.previewMeta.textContent = "Upload a PDF or DOCX resume to begin.";
  renderResults([]);
  logStep("Resume cleared.");
}

async function rerunScanIfReady() {
  if (!state.normalizedResume) return;
  logStep("Re-running search with updated match settings...");
  state.findings = await scanEntities(state.normalizedResume, state.resumeText, {
    fuzzy: dom.fuzzyToggle.checked,
    threshold: Number(dom.thresholdInput.value)
  });
  renderResults(state.findings);
  highlightMatches(state.findings);
  logStep("Complete.");
}

function logStep(message) {
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  dom.terminalLog.textContent += `[${time}] ${message}\n`;
  dom.terminalLog.scrollTop = dom.terminalLog.scrollHeight;
}

function yieldToBrowser() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
