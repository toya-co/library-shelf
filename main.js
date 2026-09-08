const {
  Plugin,
  PluginSettingTab,
  Setting,
  Modal,
  Notice,
  MarkdownRenderChild,
  TFile,
  Keymap,
  parseYaml,
  stringifyYaml,
  requestUrl,
  debounce,
} = require("obsidian");

const DEFAULT_SETTINGS = {
  coverWidth: 108,
  layout: "grid",
  deriveCovers: true,
  ledgerFolder: "Library",
  tmdbApiKey: "",
};

const DEFAULT_COLUMNS = ["cover", "title", "author", "year", "rating"];
const STATUSES = ["wishlist", "active", "done", "abandoned", "reference"];

/* A ledger keeps its entries in a fenced json or yaml block shaped
   { library: [ ... ] }. Any other fenced block in the note is ignored. */
const DATA_FENCE = /```(json|yaml|yml)[^\n]*\n([\s\S]*?)\n```/g;

function parseBlock(lang, body) {
  try {
    return lang === "json" ? JSON.parse(body) : parseYaml(body);
  } catch (e) {
    return null;
  }
}

function toPath(ref) {
  const p = String(ref ?? "").trim().replace(/^\[\[/, "").replace(/\]\]$/, "");
  if (!p) return "";
  return p.toLowerCase().endsWith(".md") ? p : p + ".md";
}

function findDataBlock(raw) {
  DATA_FENCE.lastIndex = 0;
  let m;
  while ((m = DATA_FENCE.exec(raw)) !== null) {
    const lang = m[1] === "json" ? "json" : "yaml";
    const parsed = parseBlock(lang, m[2]);
    if (parsed && Array.isArray(parsed.library)) {
      return { lang, parsed, start: m.index, length: m[0].length };
    }
  }
  return null;
}

async function readLedger(app, ref) {
  const path = toPath(ref);
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return { entries: [], missing: path };
  const raw = await app.vault.cachedRead(file);
  const medium = file.basename;
  const entries = [];
  DATA_FENCE.lastIndex = 0;
  let m;
  while ((m = DATA_FENCE.exec(raw)) !== null) {
    const parsed = parseBlock(m[1] === "json" ? "json" : "yaml", m[2]);
    if (parsed && Array.isArray(parsed.library)) {
      /* stamp the ledger name so a merged shelf can still group by medium */
      for (const it of parsed.library) entries.push(Object.assign({ medium }, it));
    }
  }
  return { entries, missing: null };
}

async function appendEntry(app, ref, entry) {
  const path = toPath(ref);
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) throw new Error("No ledger at " + path);
  const raw = await app.vault.read(file);
  const block = findDataBlock(raw);
  if (!block) throw new Error("No library block in " + file.basename);
  block.parsed.library.push(entry);
  const body =
    block.lang === "json"
      ? JSON.stringify(block.parsed, null, 2)
      : stringifyYaml(block.parsed).trimEnd();
  const fence = "```" + block.lang + "\n" + body + "\n```";
  const next = raw.slice(0, block.start) + fence + raw.slice(block.start + block.length);
  await app.vault.modify(file, next);
}

/* Explicit cover wins. Otherwise derive one from an identifier — Open Library's
   coverage is patchy, so a miss falls through to the titled card. */
function coverUrl(entry, settings) {
  if (entry.cover) return entry.cover;
  if (!settings.deriveCovers) return null;
  if (entry.isbn) {
    return (
      "https://covers.openlibrary.org/b/isbn/" +
      String(entry.isbn).replace(/[- ]/g, "") +
      "-L.jpg?default=false"
    );
  }
  if (entry.asin) {
    return "https://images-na.ssl-images-amazon.com/images/P/" + entry.asin + ".01.LZZZZZZZ.jpg";
  }
  return null;
}

/* Amazon answers an unknown ASIN with a 200 and a 1x1 transparent gif rather
   than a 404, so a load event is not proof of a cover. Anything this small is a
   placeholder — a real cover is nowhere near it. */
const MIN_COVER_PX = 10;

function watchCover(img, onMiss) {
  const check = () => {
    if (img.naturalWidth < MIN_COVER_PX || img.naturalHeight < MIN_COVER_PX) onMiss();
  };
  img.addEventListener("error", onMiss);
  img.addEventListener("load", check);
  /* a cached image can finish loading before the listener attaches */
  if (img.complete && img.naturalWidth) check();
}

function creatorOf(entry) {
  return entry.author ?? entry.director ?? null;
}

/* Arrays sort on their latest member, so a reread `finished` list still orders
   by the most recent sitting. */
function sortKey(entry, field) {
  let v = entry[field];
  if (Array.isArray(v)) v = v.slice().sort().pop();
  return v ?? "";
}

function applyOptions(entries, opts) {
  let out = entries;
  if (opts.where && typeof opts.where === "object") {
    out = out.filter((it) =>
      Object.entries(opts.where).every(([k, v]) =>
        Array.isArray(v) ? v.includes(it[k]) : it[k] === v
      )
    );
  }
  const sort = opts.sort ?? "title";
  const desc = String(sort).startsWith("-");
  const field = desc ? String(sort).slice(1) : String(sort);
  out = out.slice().sort((a, b) => {
    const c = String(sortKey(a, field)).localeCompare(String(sortKey(b, field)), undefined, {
      numeric: true,
    });
    return desc ? -c : c;
  });
  if (opts.limit) out = out.slice(0, Number(opts.limit));
  return out;
}

class ShelfChild extends MarkdownRenderChild {
  constructor(plugin, el, opts, sourcePath) {
    super(el);
    this.plugin = plugin;
    this.opts = opts ?? {};
    this.sourcePath = sourcePath;
    this.sources = [].concat(this.opts.from ?? sourcePath).map(toPath);
  }

  onload() {
    this.plugin.shelves.add(this);
    this.render();
  }

  onunload() {
    this.plugin.shelves.delete(this);
  }

  watches(path) {
    return this.sources.includes(path);
  }

  openNote(entry, evt) {
    evt.preventDefault();
    this.plugin.app.workspace.openLinkText(entry.note, this.sourcePath, Keymap.isModEvent(evt));
  }

  async render() {
    const el = this.containerEl;
    el.empty();
    const settings = this.plugin.settings;
    const opts = this.opts;

    let entries = [];
    const missing = [];
    for (const src of this.sources) {
      const res = await readLedger(this.plugin.app, src);
      if (res.missing) missing.push(res.missing);
      entries = entries.concat(res.entries);
    }

    const root = el.createDiv({ cls: "lib-shelf" });
    const width = opts.size ? Number(opts.size) : settings.coverWidth;
    root.style.setProperty("--lib-cover-w", width + "px");

    if (missing.length) {
      root.createDiv({ cls: "lib-error", text: "Ledger not found: " + missing.join(", ") });
    }

    /* count what matched before `limit` trims it — a total that changes when you
       cap the display isn't a total */
    const matched = applyOptions(entries, Object.assign({}, opts, { limit: null }));
    const items = opts.limit ? matched.slice(0, Number(opts.limit)) : matched;

    if (!items.length) {
      root.createDiv({ cls: "lib-empty", text: opts.empty ?? "Nothing on this shelf yet." });
      return;
    }

    if (opts.total) {
      const total = root.createDiv({ cls: "lib-total" });
      total.createSpan({ cls: "lib-total-count", text: String(matched.length) });
      total.createSpan({
        cls: "lib-total-label",
        text: typeof opts.total === "string" ? opts.total : matched.length === 1 ? "entry" : "entries",
      });
    }

    const layout = opts.layout ?? settings.layout;
    const draw = layout === "table" ? this.table.bind(this) : this.grid.bind(this);

    if (opts.group) {
      const groups = new Map();
      for (const it of items) {
        const k = it[opts.group] ?? "Unshelved";
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(it);
      }
      const ordered = [...groups].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      for (const [name, list] of ordered) {
        const head = root.createDiv({ cls: "lib-group-head" });
        head.createSpan({ cls: "lib-group-name", text: String(name) });
        head.createSpan({ cls: "lib-group-count", text: String(list.length) });
        draw(root, list);
      }
    } else {
      draw(root, items);
    }
  }

  grid(root, items) {
    const grid = root.createDiv({ cls: "lib-grid" });
    for (const it of items) this.tile(grid, it);
  }

  tile(parent, entry) {
    const card = parent.createDiv({ cls: "lib-item" });
    if (entry.status) card.dataset.status = entry.status;
    const art = card.createDiv({ cls: "lib-art" });
    const by = creatorOf(entry);

    const blank = () => {
      art.empty();
      art.addClass("is-blank");
      art.createDiv({ cls: "lib-blank-title", text: entry.title ?? "Untitled" });
      if (by) art.createDiv({ cls: "lib-blank-by", text: by });
    };

    const url = coverUrl(entry, this.plugin.settings);
    if (url) {
      const img = art.createEl("img", {
        attr: { src: url, loading: "lazy", alt: entry.title ?? "" },
      });
      watchCover(img, blank);
    } else {
      blank();
    }

    if (entry.rating != null) art.createDiv({ cls: "lib-rating", text: String(entry.rating) });
    if (entry.note) {
      art.createDiv({ cls: "lib-hasnote", attr: { "aria-label": "Has notes" } });
      art.addClass("is-linked");
      art.addEventListener("click", (evt) => this.openNote(entry, evt));
    }

    const meta = card.createDiv({ cls: "lib-meta" });
    const title = meta.createDiv({ cls: "lib-title" });
    if (entry.note) {
      const a = title.createEl("a", {
        cls: "internal-link",
        text: entry.title ?? "Untitled",
        attr: { href: entry.note },
      });
      a.addEventListener("click", (evt) => this.openNote(entry, evt));
    } else {
      title.setText(entry.title ?? "Untitled");
    }
    const line = [by, entry.year].filter(Boolean).join(" · ");
    if (line) meta.createDiv({ cls: "lib-by", text: line });
  }

  table(root, items) {
    const cols = [].concat(this.opts.columns ?? DEFAULT_COLUMNS);
    const table = root.createEl("table", { cls: "lib-table" });
    const head = table.createEl("thead").createEl("tr");
    for (const c of cols) {
      head.createEl("th", { text: c === "cover" ? "" : c[0].toUpperCase() + c.slice(1) });
    }
    const body = table.createEl("tbody");
    for (const entry of items) {
      const row = body.createEl("tr");
      if (entry.status) row.dataset.status = entry.status;
      for (const c of cols) this.cell(row, entry, c);
    }
  }

  cell(row, entry, col) {
    const td = row.createEl("td", { cls: "lib-td-" + col });
    if (col === "cover") {
      const url = coverUrl(entry, this.plugin.settings);
      if (url) {
        const img = td.createEl("img", {
          cls: "lib-thumb",
          attr: { src: url, loading: "lazy", alt: "" },
        });
        watchCover(img, () => img.remove());
      }
      return;
    }
    if (col === "title") {
      if (entry.note) {
        const a = td.createEl("a", {
          cls: "internal-link",
          text: entry.title ?? "Untitled",
          attr: { href: entry.note },
        });
        a.addEventListener("click", (evt) => this.openNote(entry, evt));
      } else {
        td.setText(entry.title ?? "Untitled");
      }
      return;
    }
    if (col === "author") {
      td.setText(creatorOf(entry) ?? "");
      return;
    }
    let v = entry[col];
    if (Array.isArray(v)) v = v.join(", ");
    td.setText(v == null ? "" : String(v));
  }
}

/* ---------- lookup ---------- */

async function searchOpenLibrary(query) {
  const url =
    "https://openlibrary.org/search.json?limit=8&fields=title,author_name,first_publish_year,isbn,cover_i&q=" +
    encodeURIComponent(query);
  const res = await requestUrl({ url });
  const docs = (res.json && res.json.docs) || [];
  return docs.map((d) => ({
    title: d.title,
    author: (d.author_name || []).join(", ") || undefined,
    year: d.first_publish_year,
    isbn: (d.isbn || [])[0],
    cover: d.cover_i ? "https://covers.openlibrary.org/b/id/" + d.cover_i + "-L.jpg" : undefined,
  }));
}

async function searchTmdb(query, apiKey) {
  const url =
    "https://api.themoviedb.org/3/search/movie?api_key=" +
    encodeURIComponent(apiKey) +
    "&query=" +
    encodeURIComponent(query);
  const res = await requestUrl({ url });
  const results = (res.json && res.json.results) || [];
  return results.slice(0, 8).map((d) => ({
    title: d.title,
    year: d.release_date ? Number(String(d.release_date).slice(0, 4)) : undefined,
    cover: d.poster_path ? "https://image.tmdb.org/t/p/w342" + d.poster_path : undefined,
  }));
}

class AddEntryModal extends Modal {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
    this.query = "";
    this.source = "books";
    this.ledger = "";
    this.status = "wishlist";
  }

  async onOpen() {
    this.titleEl.setText("Add to library");
    const { contentEl } = this;
    contentEl.addClass("lib-add-modal");

    const ledgers = await this.plugin.findLedgers();
    if (!ledgers.length) {
      contentEl.createDiv({
        cls: "lib-error",
        text:
          "No ledger notes found in " +
          (this.plugin.settings.ledgerFolder || "the vault") +
          ". A ledger is a note holding a json or yaml block shaped { library: [] }.",
      });
      return;
    }
    this.ledger = ledgers[0];
    this.source = this.guessSource(this.ledger);

    new Setting(contentEl).setName("Ledger").addDropdown((d) => {
      for (const l of ledgers) d.addOption(l, l.replace(/\.md$/, ""));
      d.setValue(this.ledger).onChange((v) => {
        this.ledger = v;
        this.source = this.guessSource(v);
        if (this.sourceDropdown) this.sourceDropdown.setValue(this.source);
      });
    });

    new Setting(contentEl).setName("Look up in").addDropdown((d) => {
      d.addOption("books", "Open Library (books)");
      d.addOption("films", "TMDB (films)");
      d.addOption("manual", "Don't look up");
      this.sourceDropdown = d;
      d.setValue(this.source).onChange((v) => (this.source = v));
    });

    new Setting(contentEl).setName("Status").addDropdown((d) => {
      for (const s of STATUSES) d.addOption(s, s);
      d.setValue(this.status).onChange((v) => (this.status = v));
    });

    const search = new Setting(contentEl).setName("Title");
    search.addText((t) => {
      t.setPlaceholder("Search, or type a title to add as-is");
      t.onChange((v) => (this.query = v));
      t.inputEl.addEventListener("keydown", (evt) => {
        if (evt.key === "Enter") {
          evt.preventDefault();
          this.run();
        }
      });
      window.setTimeout(() => t.inputEl.focus(), 0);
    });
    search.addButton((b) => b.setButtonText("Search").setCta().onClick(() => this.run()));

    this.resultsEl = contentEl.createDiv({ cls: "lib-results" });
  }

  guessSource(ledgerPath) {
    return /film|movie|watch|cinema/i.test(ledgerPath) ? "films" : "books";
  }

  async run() {
    if (!this.query.trim()) return;
    this.resultsEl.empty();

    if (this.source === "manual") {
      await this.commit({ title: this.query.trim() });
      return;
    }
    if (this.source === "films" && !this.plugin.settings.tmdbApiKey) {
      this.resultsEl.createDiv({
        cls: "lib-error",
        text: "Film lookup needs a TMDB API key in Library Shelf settings. Switch to “Don't look up” to add it by hand.",
      });
      return;
    }

    this.resultsEl.createDiv({ cls: "lib-results-note", text: "Searching…" });
    let results;
    try {
      results =
        this.source === "films"
          ? await searchTmdb(this.query, this.plugin.settings.tmdbApiKey)
          : await searchOpenLibrary(this.query);
    } catch (e) {
      this.resultsEl.empty();
      this.resultsEl.createDiv({ cls: "lib-error", text: "Lookup failed: " + e.message });
      return;
    }

    this.resultsEl.empty();
    if (!results.length) {
      this.resultsEl.createDiv({ cls: "lib-results-note", text: "No matches." });
      const b = this.resultsEl.createEl("button", {
        text: "Add “" + this.query.trim() + "” anyway",
      });
      b.addEventListener("click", () => this.commit({ title: this.query.trim() }));
      return;
    }

    for (const r of results) {
      const row = this.resultsEl.createDiv({ cls: "lib-result" });
      if (r.cover) {
        row.createEl("img", { cls: "lib-thumb", attr: { src: r.cover, loading: "lazy", alt: "" } });
      }
      const text = row.createDiv({ cls: "lib-result-text" });
      text.createDiv({ cls: "lib-result-title", text: r.title || "Untitled" });
      const sub = [r.author, r.year].filter(Boolean).join(" · ");
      if (sub) text.createDiv({ cls: "lib-result-sub", text: sub });
      row.addEventListener("click", () => this.commit(r));
    }
  }

  async commit(result) {
    const entry = { title: result.title, status: this.status };
    if (result.author) entry.author = result.author;
    if (result.year) entry.year = result.year;
    /* Prefer the identifier over a baked URL — it survives a CDN reshuffle. */
    if (result.isbn) entry.isbn = result.isbn;
    else if (result.cover) entry.cover = result.cover;

    try {
      await appendEntry(this.app, this.ledger, entry);
      new Notice("Added “" + entry.title + "” to " + this.ledger.replace(/\.md$/, ""));
      this.close();
    } catch (e) {
      new Notice("Couldn't add: " + e.message);
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

/* ---------- settings ---------- */

class LibraryShelfSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Ledger folder")
      .setDesc("Where the add-entry command looks for ledger notes. Blank searches the whole vault.")
      .addText((t) =>
        t.setValue(this.plugin.settings.ledgerFolder).onChange(async (v) => {
          this.plugin.settings.ledgerFolder = v.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl).setName("Default layout").addDropdown((d) =>
      d
        .addOption("grid", "Cover grid")
        .addOption("table", "Table")
        .setValue(this.plugin.settings.layout)
        .onChange(async (v) => {
          this.plugin.settings.layout = v;
          await this.plugin.saveSettings();
          this.plugin.refreshAll();
        })
    );

    new Setting(containerEl)
      .setName("Cover width")
      .setDesc("Grid column width in pixels. A block's own size: overrides this.")
      .addSlider((s) =>
        s
          .setLimits(64, 220, 4)
          .setValue(this.plugin.settings.coverWidth)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.coverWidth = v;
            await this.plugin.saveSettings();
            this.plugin.refreshAll();
          })
      );

    new Setting(containerEl)
      .setName("Derive covers from identifiers")
      .setDesc("With no cover set, fetch one from Open Library for an isbn or Amazon for an asin.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.deriveCovers).onChange(async (v) => {
          this.plugin.settings.deriveCovers = v;
          await this.plugin.saveSettings();
          this.plugin.refreshAll();
        })
      );

    new Setting(containerEl)
      .setName("TMDB API key")
      .setDesc("Only needed to look up films. Books use Open Library, which needs no key.")
      .addText((t) =>
        t.setValue(this.plugin.settings.tmdbApiKey).onChange(async (v) => {
          this.plugin.settings.tmdbApiKey = v.trim();
          await this.plugin.saveSettings();
        })
      );
  }
}

/* ---------- plugin ---------- */

module.exports = class LibraryShelfPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.shelves = new Set();

    this.registerMarkdownCodeBlockProcessor("library-shelf", (source, el, ctx) => {
      let opts = {};
      try {
        opts = parseYaml(source) || {};
      } catch (e) {
        el.createDiv({ cls: "lib-error", text: "Bad block options: " + e.message });
        return;
      }
      ctx.addChild(new ShelfChild(this, el, opts, ctx.sourcePath));
    });

    /* A ledger edit repaints every open shelf that reads it — the thing a
       dataviewjs block could never do. */
    const onChange = debounce(
      (file) => {
        for (const shelf of this.shelves) if (shelf.watches(file.path)) shelf.render();
      },
      300,
      true
    );
    this.registerEvent(this.app.vault.on("modify", onChange));

    this.addCommand({
      id: "add-entry",
      name: "Add to library",
      callback: () => new AddEntryModal(this).open(),
    });

    this.addSettingTab(new LibraryShelfSettingTab(this.app, this));
  }

  onunload() {
    this.shelves.clear();
  }

  refreshAll() {
    for (const shelf of this.shelves) shelf.render();
  }

  /* A ledger is any note in the ledger folder that actually holds a data block. */
  async findLedgers() {
    const folder = this.settings.ledgerFolder.replace(/\/$/, "");
    const found = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (folder && !file.path.startsWith(folder + "/")) continue;
      const raw = await this.app.vault.cachedRead(file);
      if (findDataBlock(raw)) found.push(file.path);
    }
    return found.sort();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
};
