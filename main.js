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
  setIcon,
  Menu,
} = require("obsidian");

const DEFAULT_SETTINGS = {
  coverWidth: 132,
  layout: "grid",
  deriveCovers: true,
  ledgerFolder: "Library",
  notesFolder: "Library/notes",
  tmdbApiKey: "",
  collapsed: {},
};

const DEFAULT_COLUMNS = ["cover", "title", "author", "year", "rating"];
const STATUSES = ["wishlist", "active", "done", "abandoned", "reference"];

/* Where a drawn entry came from — its ledger and row — so a menu edit can write back
   to exactly that row. A symbol, so it never leaks into search or a written ledger. */
const SRC = Symbol("library-source");

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
  let block = 0;
  while ((m = DATA_FENCE.exec(raw)) !== null) {
    const parsed = parseBlock(m[1] === "json" ? "json" : "yaml", m[2]);
    if (parsed && Array.isArray(parsed.library)) {
      /* stamp the ledger name so a merged shelf can still group by medium. Only the
         first block's rows get an index: that's the block writeLedger edits, so a
         row from any later block is found by title instead. */
      parsed.library.forEach((it, i) => {
        const e = Object.assign({ medium }, it);
        e[SRC] = { ledger: path, index: block === 0 ? i : -1 };
        entries.push(e);
      });
      block += 1;
    }
  }
  return { entries, missing: null };
}

/* One write path for the ledger: read, hand the live array to `mutate`, splice the
   block back in its own format. Appending and editing an entry are the same
   operation to the file, so they share the format-preserving half rather than
   growing a second copy of it that drifts. */
async function writeLedger(app, ref, mutate) {
  const path = toPath(ref);
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) throw new Error("No ledger at " + path);
  const raw = await app.vault.read(file);
  const block = findDataBlock(raw);
  if (!block) throw new Error("No library block in " + file.basename);
  mutate(block.parsed.library);
  const body =
    block.lang === "json"
      ? JSON.stringify(block.parsed, null, 2)
      : stringifyYaml(block.parsed).trimEnd();
  const fence = "```" + block.lang + "\n" + body + "\n```";
  const next = raw.slice(0, block.start) + fence + raw.slice(block.start + block.length);
  await app.vault.modify(file, next);
}

async function appendEntry(app, ref, entry) {
  await writeLedger(app, ref, (lib) => lib.push(entry));
}

/* Titles are matched loosely — trimmed and case-folded — because the whole point
   is catching the near-miss a person wouldn't notice. */
const titleKey = (t) => String(t ?? "").trim().toLowerCase();

async function findEntryByTitle(app, ref, title) {
  const path = toPath(ref);
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return null;
  const block = findDataBlock(await app.vault.cachedRead(file));
  if (!block) return null;
  const key = titleKey(title);
  const i = block.parsed.library.findIndex((e) => titleKey(e.title) === key);
  return i === -1 ? null : { index: i, entry: block.parsed.library[i] };
}

/* A reread is another date on the same row, never a second row — that's why
   `finished` is a list. Scalars written by hand get promoted on the way. */
function addFinishedDate(entry, date) {
  const cur = entry.finished;
  const list = cur == null ? [] : Array.isArray(cur) ? cur.slice() : [cur];
  if (!list.map(String).includes(date)) list.push(date);
  entry.finished = list;
  entry.status = "done";
}

function todayStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

const amazonCover = (id) => "https://images-na.ssl-images-amazon.com/images/P/" + id + ".01.LZZZZZZZ.jpg";

/* For print books Amazon's ASIN *is* the ISBN-10, so an ISBN gives a second cover
   source for free. A 978- ISBN-13 converts; a 979- one has no ISBN-10 and doesn't. */
function isbn10(isbn) {
  const d = String(isbn ?? "").replace(/[^0-9Xx]/g, "").toUpperCase();
  if (d.length === 10) return d;
  if (d.length !== 13 || !d.startsWith("978")) return null;
  const core = d.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (10 - i) * Number(core[i]);
  const check = (11 - (sum % 11)) % 11;
  return core + (check === 10 ? "X" : String(check));
}

/* Every source worth trying, best first. Explicit cover wins outright. An ISBN tries
   Open Library, then Amazon by ISBN-10 — Open Library misses a lot of manga and older
   printings that Amazon has. Empty means go straight to the titled card. */
function coverUrls(entry, settings) {
  if (entry.cover) return [entry.cover];
  if (!settings.deriveCovers) return [];
  const urls = [];
  if (entry.isbn) {
    urls.push(
      "https://covers.openlibrary.org/b/isbn/" + String(entry.isbn).replace(/[- ]/g, "") + "-L.jpg?default=false"
    );
    const ten = isbn10(entry.isbn);
    if (ten) urls.push(amazonCover(ten));
  }
  if (entry.asin) urls.push(amazonCover(entry.asin));
  return urls;
}

/* One <img> walking the source list: each miss (a 404, or Amazon's 1x1 gif) swaps
   in the next URL on the same element — its listeners stay attached and judge the
   next source too — and only running out calls onMiss. */
function mountCover(parent, urls, attrs, onMiss) {
  let i = 0;
  const img = parent.createEl("img", {
    cls: attrs.cls,
    attr: { src: urls[0], loading: "lazy", alt: attrs.alt ?? "" },
  });
  watchCover(img, () => {
    i += 1;
    if (i < urls.length) img.src = urls[i];
    else onMiss();
  });
  return img;
}

/* YAML can hand a date back as a string or, under some parsers, a Date. */
const dateStr = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v));
const finishedDates = (entry) => [].concat(entry.finished ?? []).filter((v) => v != null).map(dateStr);

/* Amazon answers an unknown ASIN with a 200 and a 1x1 transparent gif rather
   than a 404, so a load event is not proof of a cover. Anything this small is a
   placeholder — a real cover is nowhere near it. */
const MIN_COVER_PX = 10;

function watchCover(img, onMiss) {
  let judged = "";
  const check = () => {
    /* A cached image can report complete at attach time *and* fire load — judge
       each source once, or a miss would skip two fallbacks at a time. */
    if (judged === img.src) return;
    judged = img.src;
    if (img.naturalWidth < MIN_COVER_PX || img.naturalHeight < MIN_COVER_PX) onMiss();
  };
  img.addEventListener("error", onMiss);
  img.addEventListener("load", check);
  /* a cached image can finish loading before the listener attaches */
  if (img.complete && img.naturalWidth) check();
}

/* Books aren't all one height, and a ruler-straight top line is the main thing
   that makes a cover grid read as thumbnails rather than a shelf. The variance
   is hashed from the title, never random — Math.random() would reshuffle every
   height on each modify-event repaint and make the shelf twitch. */
function trimRatio(title) {
  let h = 0;
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) >>> 0;
  return (1.38 + (h % 25) / 100).toFixed(2);
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
  /* `year: 2026` keeps what was finished in that year — a reread that year counts
     once, since it's one row. `year: current` follows the calendar. */
  if (opts.year != null && opts.year !== "") {
    const y = String(opts.year).toLowerCase() === "current" ? String(new Date().getFullYear()) : String(opts.year);
    out = out.filter((it) => finishedDates(it).some((d) => d.startsWith(y)));
  }
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

/* Search on a library page: every word has to appear somewhere in what the card
   shows, so "le guin earthsea" narrows the way a person expects. Finished dates are
   in the haystack too — "2024" usually means read in 2024, not published then. */
function matchesQuery(entry, query) {
  const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [entry.title, entry.author, entry.director, entry.shelf, entry.year, entry.status, entry.medium]
    .concat(finishedDates(entry))
    .filter((v) => v != null)
    .join(" ")
    .toLowerCase();
  return words.every((w) => hay.includes(w));
}

const ledgerName = (path) => String(path).replace(/\.md$/, "").split("/").pop();

/* What the ribbon icon writes on first use. Kept as functions of the found ledgers
   rather than fixed text, so a vault that set a different ledger folder gets a hub
   pointing at the right paths. Paths are quoted: a folder name with a comma or a
   colon is still valid YAML that way. */
const HUB_NAME = "Library.md";

function ledgerTemplate(total) {
  const thing = total === "movies" ? "film" : "book";
  return [
    "---", "tags:", "  - library", "---", "",
    "```library-bar", "```", "",
    "```library-shelf", "group: shelf", "total: " + total, "stats: true",
    "empty: Nothing here yet. Add one with the box above.", "```", "",
    "## Ledger", "",
    "Each " + thing + " is a row in the block below. The add box writes here for you;",
    "editing by hand works too.", "",
    "```yaml", "library: []", "```", "",
  ].join("\n");
}

function hubTemplate(ledgers) {
  const from = "from: [" + ledgers.map((l) => JSON.stringify(String(l).replace(/\.md$/, ""))).join(", ") + "]";
  const shelf = (...lines) => ["```library-shelf", from, ...lines, "```"].join("\n");
  return (
    [
      "---\ntags:\n  - library\n---",
      "# Library",
      "```library-bar\n```",
      "## Now",
      shelf("where:", "  status: active", "size: 96", "empty: Nothing on the go."),
      "## Recently finished",
      shelf("where:", "  status: done", "sort: -finished", "limit: 12", "size: 96", "empty: Nothing finished yet."),
      "## This year",
      shelf("year: current", "sort: -finished", "total: finished this year", "size: 88", "empty: Nothing finished this year yet."),
      "## Everything",
      shelf("group: medium", "size: 88", "empty: Nothing here yet. Add one with the box above."),
      "## Wishlist",
      shelf("where:", "  status: wishlist", "size: 88", "empty: The wishlist is empty."),
    ].join("\n\n") + "\n"
  );
}

class ShelfChild extends MarkdownRenderChild {
  constructor(plugin, el, opts, sourcePath) {
    super(el);
    this.plugin = plugin;
    this.opts = opts ?? {};
    this.sourcePath = sourcePath;
    this.sources = [].concat(this.opts.from ?? sourcePath).map(toPath);
    /* Transient view state, not settings: a facet narrows what's shown without
       touching the ledger or the block options. It survives the modify-event
       repaint because that re-renders this same child, and resets when the note
       is closed — which is what you want from a filter you clicked once. */
    this.facet = null;
  }

  onload() {
    this.plugin.shelves.add(this);
    this.render();
  }

  onunload() {
    this.plugin.shelves.delete(this);
    if (this.resizeObs) {
      this.resizeObs.disconnect();
      this.resizeObs = null;
    }
  }

  watches(path) {
    return this.sources.includes(path);
  }

  /* Reads whichever ledgers were resolved on the last render, not a fixed list —
     a card with no `from` doesn't know its sources until it has looked. */
  async resolveSources() {
    if (this.opts.from) return this.sources;
    this.sources = (await this.plugin.findLedgers()).map(toPath);
    return this.sources;
  }

  openNote(entry, evt) {
    evt.preventDefault();
    this.plugin.app.workspace.openLinkText(entry.note, this.sourcePath, Keymap.isModEvent(evt));
  }

  /* Right-click (long-press on mobile) on a cover or table row: the edits you'd
     otherwise make by hand in the ledger. Every item writes the one row it came
     from; the modify event then repaints every shelf that reads that ledger. */
  entryMenu(entry, evt) {
    const src = entry[SRC];
    if (!src) return;
    evt.preventDefault();
    const edit = (fn) => this.plugin.editEntry(src, entry, fn);
    const menu = new Menu();
    for (const st of STATUSES) {
      menu.addItem((i) =>
        i
          .setTitle(st[0].toUpperCase() + st.slice(1))
          .setChecked(entry.status === st)
          .onClick(() => edit((e) => (e.status = st)))
      );
    }
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle("Finished again today").setIcon("check").onClick(() => edit((e) => addFinishedDate(e, todayStamp())))
    );
    menu.addItem((i) => i.setTitle("Rate…").setIcon("star").onClick(() => new RatingModal(this.plugin, src, entry).open()));
    menu.addSeparator();
    if (entry.note) {
      menu.addItem((i) =>
        i.setTitle("Open note").setIcon("notebook-pen").onClick(() =>
          this.plugin.app.workspace.openLinkText(entry.note, this.sourcePath, false)
        )
      );
    } else {
      menu.addItem((i) =>
        i.setTitle("Create note").setIcon("file-plus").onClick(() => promoteEntry(this.plugin, src.ledger, entry))
      );
    }
    menu.addItem((i) =>
      i.setTitle("Remove from library").setIcon("trash").onClick(() =>
        new ConfirmModal(
          this.plugin.app,
          "Remove “" + (entry.title ?? "Untitled") + "” from " + ledgerName(src.ledger) + "?",
          "Remove",
          () => edit(null)
        ).open()
      )
    );
    menu.showAtMouseEvent(evt);
  }

  async render() {
    /* Search re-renders on every pause in typing, and each render awaits the
       ledger reads — so an older render can finish after a newer one. Only the
       latest may draw. */
    const seq = (this.renderSeq = (this.renderSeq ?? 0) + 1);
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
    if (seq !== this.renderSeq) return;
    el.empty();

    const root = el.createDiv({ cls: "lib-shelf" });

    /* `size` is a target, not a literal. Columns are fixed-width so the plinth
       lands at an exact height, which means a leftover gutter unless the width
       is solved to divide the container evenly — so solve it, and re-solve when
       the pane resizes. */
    const target = opts.size ? Number(opts.size) : settings.coverWidth;
    const gap = 12;
    const fit = () => {
      const avail = root.clientWidth;
      if (!avail) return;
      const cols = Math.max(1, Math.round(avail / (target + gap)));
      root.style.setProperty("--lib-cover-w", Math.floor(avail / cols) - gap + "px");
    };
    root.style.setProperty("--lib-cover-w", target + "px");
    fit();
    if (this.resizeObs) this.resizeObs.disconnect();
    this.resizeObs = new ResizeObserver(fit);
    this.resizeObs.observe(root);

    if (missing.length) {
      root.createDiv({ cls: "lib-error", text: "Ledger not found: " + missing.join(", ") });
    }

    /* count what matched before `limit` trims it — a total that changes when you
       cap the display isn't a total */
    const matched = applyOptions(entries, Object.assign({}, opts, { limit: null }));

    /* An empty shelf is empty before any facet is applied — check that first, so
       a facet that matches nothing still leaves the stat row on screen to click
       back out of. */
    if (!matched.length) {
      root.createDiv({ cls: "lib-empty", text: opts.empty ?? "Nothing on this shelf yet." });
      return;
    }

    /* A ledger edit can retire the status a facet is pinned to, and the stat row
       only draws statuses it still counts — so a stale facet would filter the
       shelf to nothing with no cell left to click back out of. Drop it instead. */
    if (this.facet && !matched.some((it) => it.status === this.facet)) this.facet = null;

    /* The page's search box narrows like a facet does: the count follows it, the
       stat row doesn't, so the navigation stays put while you type. */
    const query = this.plugin.searches.get(this.sourcePath) ?? "";
    const found = query ? matched.filter((it) => matchesQuery(it, query)) : matched;
    const shown = this.facet ? found.filter((it) => it.status === this.facet) : found;
    const items = opts.limit ? shown.slice(0, Number(opts.limit)) : shown;

    if (opts.total) {
      const total = root.createDiv({ cls: "lib-total" });
      total.createSpan({ cls: "lib-total-count", text: String(shown.length) });
      /* `goal: 24` prints the count against it — "14 / 24". */
      if (Number(opts.goal) > 0) total.createSpan({ cls: "lib-total-goal", text: "/ " + Number(opts.goal) });
      total.createSpan({
        cls: "lib-total-label",
        text: typeof opts.total === "string" ? opts.total : shown.length === 1 ? "entry" : "entries",
      });

      if (opts.stats) {
        /* Counted from `matched`, never from `shown` — the stat row is the
           navigation, so its numbers have to hold still while you click across
           it rather than collapsing to the facet you just picked. */
        const counts = new Map();
        for (const it of matched) {
          if (it.status) counts.set(it.status, (counts.get(it.status) ?? 0) + 1);
        }
        const row = root.createDiv({ cls: "lib-stats" });
        row.classList.toggle("has-facet", !!this.facet);
        for (const st of STATUSES) {
          if (!counts.has(st)) continue;
          const cell = row.createDiv({ cls: "lib-stat mod-facet" });
          cell.dataset.status = st;
          cell.createSpan({ cls: "lib-stat-n", text: String(counts.get(st)) });
          cell.createSpan({ cls: "lib-stat-label", text: st });

          const on = this.facet === st;
          cell.classList.toggle("is-active", on);
          cell.setAttribute("role", "button");
          cell.setAttribute("tabindex", "0");
          cell.setAttribute("aria-pressed", String(on));
          const toggle = () => {
            this.facet = on ? null : st;
            this.render();
          };
          cell.addEventListener("click", toggle);
          cell.addEventListener("keydown", (evt) => {
            if (evt.key === "Enter" || evt.key === " ") {
              evt.preventDefault();
              toggle();
            }
          });
        }
        const rated = matched.filter((it) => typeof it.rating === "number");
        if (rated.length) {
          const avg = rated.reduce((a, it) => a + it.rating, 0) / rated.length;
          const cell = row.createDiv({ cls: "lib-stat" });
          cell.createSpan({ cls: "lib-stat-n", text: avg.toFixed(1) });
          cell.createSpan({ cls: "lib-stat-label", text: "avg rating" });
        }
      }
    }

    if (!items.length) {
      root.createDiv({
        cls: "lib-empty",
        text: query
          ? "No matches for “" + query + "”."
          : this.facet
          ? "Nothing " + this.facet + " on this shelf."
          : opts.empty ?? "Nothing on this shelf yet.",
      });
      return;
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
        const wrap = root.createDiv({ cls: "lib-group" });
        const head = wrap.createDiv({ cls: "lib-group-head" });
        const chevron = head.createSpan({ cls: "lib-group-chevron" });
        setIcon(chevron, "chevron-down");
        head.createSpan({ cls: "lib-group-name", text: String(name) });
        head.createSpan({ cls: "lib-group-count", text: String(list.length) });
        const body = wrap.createDiv({ cls: "lib-group-body" });
        draw(body, list);

        /* Collapse state is keyed by note + group name and kept in plugin data,
           so it survives both a re-render and a reload. */
        const key = this.sourcePath + "::" + String(name);
        let shut = !!this.plugin.settings.collapsed[key];
        wrap.toggleClass("is-collapsed", shut);
        head.addEventListener("click", () => {
          shut = !shut;
          wrap.toggleClass("is-collapsed", shut);
          if (shut) this.plugin.settings.collapsed[key] = true;
          else delete this.plugin.settings.collapsed[key];
          this.plugin.saveSettings();
        });
      }
    } else {
      draw(root, items);
    }
  }

  grid(root, items) {
    const grid = root.createDiv({ cls: "lib-grid" });
    for (const it of items) this.tile(grid, it);
  }

  /* ---------- the note-side card ---------- */

  /* Rendered by a `library-card` block at the top of a note the ledger points at.
     It takes no arguments: the note knows its own path, and the ledger row that
     claims it is the one whose `note:` resolves here. That direction matters —
     the note stays prose with one inert block in it, and every field on the card
     is still owned by the ledger, so there is nothing to keep in sync. */
  async renderCard() {
    const el = this.containerEl;
    el.empty();
    const root = el.createDiv({ cls: "lib-card" });

    let hit = null;
    for (const src of await this.resolveSources()) {
      const res = await readLedger(this.plugin.app, src);
      const found = res.entries.find((e) => e.note && toPath(e.note) === toPath(this.sourcePath));
      if (found) {
        hit = { entry: found, ledger: src };
        break;
      }
    }

    if (!hit) {
      root.createDiv({
        cls: "lib-card-empty",
        text:
          "No ledger entry points here yet. Add `note: " +
          this.sourcePath.replace(/\.md$/, "") +
          "` to the row this note is about.",
      });
      return;
    }

    const { entry, ledger } = hit;
    const by = creatorOf(entry);

    const urls = coverUrls(entry, this.plugin.settings);
    const art = root.createDiv({ cls: "lib-card-art" });
    if (urls.length) {
      mountCover(art, urls, { alt: entry.title ?? "" }, () => {
        art.empty();
        art.addClass("is-blank");
      });
    } else {
      art.addClass("is-blank");
    }

    const body = root.createDiv({ cls: "lib-card-body" });
    body.createDiv({ cls: "lib-card-title", text: entry.title ?? "Untitled" });
    const sub = [by, entry.year].filter(Boolean).join(" · ");
    if (sub) body.createDiv({ cls: "lib-card-by", text: sub });

    const chips = body.createDiv({ cls: "lib-card-chips" });
    const chip = (text, mod) => {
      const c = chips.createSpan({ cls: "lib-chip", text });
      if (mod) c.dataset.chip = mod;
      return c;
    };
    if (entry.status) chip(entry.status, entry.status);
    if (entry.rating != null) chip(entry.rating + "★", "rating");
    const sittings = entry.finished == null ? [] : [].concat(entry.finished);
    if (sittings.length) {
      chip(sittings.length === 1 ? "read once" : "read " + sittings.length + "×", "sittings");
    }
    if (entry.shelf) chip(entry.shelf);

    if (sittings.length) {
      body.createDiv({ cls: "lib-card-dates", text: sittings.map(String).join(" · ") });
    }

    /* Back-link: the shelf already links here, so this closes the loop rather
       than leaving the note a dead end. */
    const back = body.createDiv({ cls: "lib-card-back" });
    const a = back.createEl("a", {
      cls: "internal-link",
      text: "on " + ledger.replace(/\.md$/, "").split("/").pop(),
      attr: { href: ledger },
    });
    a.addEventListener("click", (evt) => {
      evt.preventDefault();
      this.plugin.app.workspace.openLinkText(ledger, this.sourcePath, Keymap.isModEvent(evt));
    });
  }

  tile(parent, entry) {
    const card = parent.createDiv({ cls: "lib-item" });
    if (entry.status) card.dataset.status = entry.status;
    /* the shelf box is a fixed-height well the cover stands on; its bottom
       border is the plinth, and adjacent boxes abut to form one board */
    const shelfBox = card.createDiv({ cls: "lib-shelfbox" });
    const art = shelfBox.createDiv({ cls: "lib-art" });
    art.style.setProperty("--lib-ratio", trimRatio(entry.title ?? ""));
    const by = creatorOf(entry);

    const blank = () => {
      art.empty();
      art.addClass("is-blank");
      art.createDiv({ cls: "lib-blank-title", text: entry.title ?? "Untitled" });
      if (by) art.createDiv({ cls: "lib-blank-by", text: by });
    };

    const urls = coverUrls(entry, this.plugin.settings);
    if (urls.length) mountCover(art, urls, { alt: entry.title ?? "" }, blank);
    else blank();

    if (entry.rating != null) art.createDiv({ cls: "lib-rating", text: String(entry.rating) });
    card.addEventListener("contextmenu", (evt) => this.entryMenu(entry, evt));
    if (entry.note) {
      art.addClass("is-linked");
      art.addEventListener("click", (evt) => this.openNote(entry, evt));
    } else {
      /* A note-less cover used to do nothing on click; now it opens the menu. */
      art.addClass("is-menu");
      art.addEventListener("click", (evt) => this.entryMenu(entry, evt));
    }

    const meta = card.createDiv({ cls: "lib-meta" });
    const title = meta.createDiv({ cls: "lib-title" });
    if (entry.note) {
      /* The indicator sits by the title rather than on the cover: a corner dot on
         artwork reads as a rendering artefact, and on a light cover it disappears. */
      const mark = title.createSpan({ cls: "lib-noteicon", attr: { "aria-label": "Has a note" } });
      setIcon(mark, "notebook-pen");
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
      row.addEventListener("contextmenu", (evt) => this.entryMenu(entry, evt));
      for (const c of cols) this.cell(row, entry, c);
    }
  }

  cell(row, entry, col) {
    const td = row.createEl("td", { cls: "lib-td-" + col });
    if (col === "cover") {
      const urls = coverUrls(entry, this.plugin.settings);
      if (urls.length) {
        const img = mountCover(td, urls, { cls: "lib-thumb" }, () => img.remove());
      }
      return;
    }
    if (col === "title") {
      if (entry.note) {
        const mark = td.createSpan({ cls: "lib-noteicon", attr: { "aria-label": "Has a note" } });
        setIcon(mark, "notebook-pen");
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

/* Same lifecycle as a shelf — registered in plugin.shelves, repainted by the
   modify handler — so a rating edited in the ledger updates the note's card. */
class CardChild extends ShelfChild {
  render() {
    return this.renderCard();
  }
}

/* ---------- the page bar ---------- */

/* A `library-bar` block: a search box and an add box at the top of a library page.
   Search is page-local — it narrows every shelf rendered from the same note and
   nothing else — and lives in memory, not settings, for the same reason a facet
   does: it's something you typed a moment ago, not a preference. */
class BarChild extends MarkdownRenderChild {
  constructor(plugin, el, opts, sourcePath) {
    super(el);
    this.plugin = plugin;
    this.opts = opts ?? {};
    this.sourcePath = sourcePath;
  }

  onload() {
    this.render();
  }

  onunload() {
    if (this.plugin.searches.delete(this.sourcePath)) this.plugin.refreshPage(this.sourcePath);
  }

  async render() {
    const el = this.containerEl;
    el.empty();
    const bar = el.createDiv({ cls: "lib-bar" });

    const find = bar.createDiv({ cls: "lib-bar-field" });
    setIcon(find.createSpan({ cls: "lib-bar-icon" }), "search");
    const q = find.createEl("input", {
      cls: "lib-bar-input",
      attr: { type: "search", placeholder: "Search this page", "aria-label": "Search this page" },
    });
    q.value = this.plugin.searches.get(this.sourcePath) ?? "";
    const apply = debounce(
      () => {
        const v = q.value.trim();
        if (v) this.plugin.searches.set(this.sourcePath, v);
        else this.plugin.searches.delete(this.sourcePath);
        this.plugin.refreshPage(this.sourcePath);
      },
      150,
      true
    );
    q.addEventListener("input", apply);
    q.addEventListener("keydown", (evt) => {
      if (evt.key === "Escape" && q.value) {
        evt.stopPropagation();
        q.value = "";
        apply();
      }
    });

    const add = bar.createDiv({ cls: "lib-bar-field mod-add" });
    setIcon(add.createSpan({ cls: "lib-bar-icon" }), "plus");
    const t = add.createEl("input", {
      cls: "lib-bar-input",
      attr: { type: "text", placeholder: "Add a title…", "aria-label": "Add a title" },
    });

    /* Where the add box writes: a ledger page adds to itself; a hub offers every
       ledger, defaulting to the first. `ledger:` in the block overrides both. */
    const ledgers = await this.plugin.findLedgers();
    const own = toPath(this.sourcePath);
    let target = this.opts.ledger ? toPath(this.opts.ledger) : ledgers.includes(own) ? own : ledgers[0];
    if (!this.opts.ledger && !ledgers.includes(own) && ledgers.length > 1) {
      const sel = add.createEl("select", { cls: "dropdown lib-bar-ledger", attr: { "aria-label": "Add to" } });
      for (const l of ledgers) sel.createEl("option", { text: ledgerName(l), attr: { value: l } });
      sel.value = target;
      sel.addEventListener("change", () => (target = sel.value));
    }

    const go = () => {
      new AddEntryModal(this.plugin, { query: t.value.trim(), ledger: target }).open();
      t.value = "";
    };
    t.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        go();
      }
    });
    add.createEl("button", { cls: "lib-bar-btn", text: "Add" }).addEventListener("click", go);

    const imp = bar.createEl("button", {
      cls: "lib-bar-import clickable-icon",
      attr: { "aria-label": "Import from Goodreads, StoryGraph or Letterboxd" },
    });
    setIcon(imp, "import");
    imp.addEventListener("click", () => new ImportModal(this.plugin, { ledger: this.opts.ledger || (ledgers.includes(own) ? own : "") }).open());

    if (!ledgers.length) {
      el.createDiv({
        cls: "lib-error",
        text: "No ledger yet — click the library icon in the ribbon to set one up.",
      });
    }
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

/* ---------- import ---------- */

/* RFC 4180-ish: quoted fields may hold commas, doubled quotes and newlines — a
   Goodreads review column has all three. A leading BOM is dropped. */
function parseCsv(text) {
  const src = String(text).replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [head = [], ...body] = rows.filter((r) => r.some((v) => v.trim() !== ""));
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

/* Goodreads wraps ISBNs as ="0141439475" so spreadsheets keep the leading zero. */
const unexcel = (v) => String(v ?? "").replace(/^="?/, "").replace(/"$/, "").trim();
const slashDate = (v) => {
  const m = String(v ?? "").match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  return m ? m[1] + "-" + m[2].padStart(2, "0") + "-" + m[3].padStart(2, "0") : null;
};
const num = (v) => {
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
const cleanIsbn = (v) => {
  const d = unexcel(v).replace(/[- ]/g, "");
  return /^(\d{9}[\dXx]|\d{13})$/.test(d) ? d : undefined;
};
const tidy = (e) => Object.fromEntries(Object.entries(e).filter(([, v]) => v != null && v !== "" && !(Array.isArray(v) && !v.length)));

const GOODREADS_STATUS = { read: "done", "currently-reading": "active", "to-read": "wishlist" };
function fromGoodreads(rows) {
  return rows.map((r) => {
    const shelf = String(r["Exclusive Shelf"] || "").toLowerCase();
    const status = GOODREADS_STATUS[shelf] || (/dnf|did-not-finish|abandon/.test(shelf) ? "abandoned" : "wishlist");
    /* first custom shelf that isn't one of the three built-in ones */
    const custom = String(r["Bookshelves"] || "")
      .split(",")
      .map((x) => x.trim())
      .find((x) => x && !GOODREADS_STATUS[x] && x !== shelf);
    const read = slashDate(r["Date Read"]);
    return tidy({
      title: r["Title"],
      author: r["Author"],
      year: num(r["Original Publication Year"]) || num(r["Year Published"]),
      shelf: custom,
      status,
      rating: num(r["My Rating"]),
      finished: status === "done" && read ? [read] : undefined,
      isbn: cleanIsbn(r["ISBN13"]) || cleanIsbn(r["ISBN"]),
    });
  });
}

const STORYGRAPH_STATUS = {
  read: "done",
  "currently-reading": "active",
  "to-read": "wishlist",
  "did-not-finish": "abandoned",
  paused: "active",
};
function fromStoryGraph(rows) {
  return rows.map((r) => {
    const status = STORYGRAPH_STATUS[String(r["Read Status"] || "").toLowerCase()] || "wishlist";
    /* "Dates Read" holds each read as start-end; the end of each is a finish. */
    let finished = String(r["Dates Read"] || "")
      .split(",")
      .map((x) => slashDate(x.split("-").pop()))
      .filter(Boolean);
    if (!finished.length && slashDate(r["Last Date Read"])) finished = [slashDate(r["Last Date Read"])];
    return tidy({
      title: r["Title"],
      author: r["Authors"],
      status,
      rating: num(r["Star Rating"]),
      finished: status === "done" ? [...new Set(finished)].sort() : undefined,
      isbn: cleanIsbn(r["ISBN/UID"]),
    });
  });
}

/* Letterboxd exports a zip of CSVs; the useful four are merged by title + year.
   watched/diary/ratings mean seen, watchlist means wishlist, the diary's dates are
   the viewings, and a rating anywhere wins over none. */
function fromLetterboxd(files) {
  const films = new Map();
  const get = (r) => {
    const key = titleKey(r["Name"]) + "|" + (r["Year"] || "");
    if (!films.has(key)) films.set(key, { title: r["Name"], year: num(r["Year"]), status: "wishlist", finished: [] });
    return films.get(key);
  };
  const order = { watchlist: 0, watched: 1, ratings: 2, diary: 3 };
  for (const f of [...files].sort((a, b) => order[a.kind] - order[b.kind])) {
    for (const r of f.rows) {
      if (!r["Name"]) continue;
      const e = get(r);
      if (f.kind !== "watchlist") e.status = "done";
      if (num(r["Rating"])) e.rating = num(r["Rating"]);
      const seen = slashDate(r["Watched Date"]);
      if (f.kind === "diary" && seen) e.finished.push(seen);
    }
  }
  return [...films.values()].map((e) => tidy(Object.assign(e, { finished: [...new Set(e.finished)].sort() })));
}

/* Tell a file's source from its header row; Letterboxd's watched and watchlist
   files share one header, so their names split them. */
function detectExport(name, rows) {
  const head = new Set(Object.keys(rows[0] || {}));
  if (head.has("Exclusive Shelf") && head.has("My Rating")) return { service: "Goodreads", medium: "books" };
  if (head.has("Read Status") && head.has("Star Rating")) return { service: "StoryGraph", medium: "books" };
  if (head.has("Letterboxd URI")) {
    const kind = head.has("Watched Date")
      ? "diary"
      : head.has("Rating")
      ? "ratings"
      : /watchlist/i.test(name)
      ? "watchlist"
      : "watched";
    return { service: "Letterboxd", medium: "films", kind };
  }
  return null;
}

/* The ledger's own dedupe key: a title, plus the year for films so a remake is its
   own row. Existing rows and the incoming batch are both checked. */
function mergeImport(existing, incoming, medium) {
  const key = (e) => titleKey(e.title) + (medium === "films" && e.year ? "|" + e.year : "");
  const loose = (e) => titleKey(e.title);
  const have = new Set(existing.map(key));
  const haveLoose = new Set(existing.filter((e) => !e.year).map(loose));
  const added = [];
  let skipped = 0;
  for (const e of incoming) {
    if (!e.title) continue;
    if (have.has(key(e)) || haveLoose.has(loose(e))) {
      skipped++;
      continue;
    }
    have.add(key(e));
    added.push(e);
  }
  return { added, skipped };
}

function convertExports(files) {
  const lb = files.filter((f) => f.found.service === "Letterboxd");
  const out = [];
  for (const f of files) {
    if (f.found.service === "Goodreads") out.push(...fromGoodreads(f.rows));
    if (f.found.service === "StoryGraph") out.push(...fromStoryGraph(f.rows));
  }
  if (lb.length) out.push(...fromLetterboxd(lb.map((f) => ({ kind: f.found.kind, rows: f.rows }))));
  return out;
}

class ImportModal extends Modal {
  constructor(plugin, preset = {}) {
    super(plugin.app);
    this.plugin = plugin;
    this.presetLedger = preset.ledger ? toPath(preset.ledger) : "";
    this.files = [];
  }

  async onOpen() {
    this.titleEl.setText("Import a library");
    const { contentEl } = this;
    contentEl.addClass("lib-add-modal");

    const help = contentEl.createDiv({ cls: "lib-import-help" });
    help.createDiv({ text: "Pick the CSV your service exports:" });
    const ul = help.createEl("ul");
    ul.createEl("li", { text: "Goodreads — My Books → Import and export → Export library" });
    ul.createEl("li", { text: "StoryGraph — Manage account → Export StoryGraph library" });
    ul.createEl("li", {
      text: "Letterboxd — Settings → Data → Export your data; unzip, then pick watched, diary, ratings and watchlist .csv together",
    });

    this.ledgers = await this.plugin.findLedgers();
    if (!this.ledgers.length) {
      contentEl.createDiv({ cls: "lib-error", text: "No ledger yet — click the library icon in the ribbon to set one up." });
      return;
    }
    this.ledger = this.ledgers.includes(this.presetLedger) ? this.presetLedger : this.ledgers[0];

    const input = contentEl.createEl("input", { attr: { type: "file", accept: ".csv,text/csv", multiple: "" } });
    input.addEventListener("change", async () => {
      this.files = [];
      for (const file of Array.from(input.files || [])) {
        this.files.push({ name: file.name, text: await file.text() });
      }
      this.preview();
    });

    new Setting(contentEl).setName("Import into").addDropdown((d) => {
      for (const l of this.ledgers) d.addOption(l, ledgerName(l));
      this.ledgerDropdown = d;
      d.setValue(this.ledger).onChange((v) => {
        this.ledger = v;
        this.userPicked = true;
        this.preview();
      });
    });

    this.resultsEl = contentEl.createDiv({ cls: "lib-results" });
  }

  /* Read the picked files, work out what they are, and show what an import would
     do before doing it. */
  async preview() {
    this.resultsEl.empty();
    this.plan = null;
    if (!this.files.length) return;

    const parsed = [];
    for (const f of this.files) {
      const rows = parseCsv(f.text);
      const found = detectExport(f.name, rows);
      if (!found) {
        this.resultsEl.createDiv({ cls: "lib-error", text: f.name + " isn't a Goodreads, StoryGraph or Letterboxd export." });
        continue;
      }
      parsed.push({ name: f.name, rows, found });
    }
    if (!parsed.length) return;

    /* Point the ledger at the right medium the first time a file tells us which. */
    const medium = parsed[0].found.medium;
    if (!this.userPicked && !this.presetLedger) {
      const guess = this.ledgers.find((l) => (medium === "films" ? /film|movie|watch|cinema/i : /book|read/i).test(l));
      if (guess && guess !== this.ledger) {
        this.ledger = guess;
        this.ledgerDropdown.setValue(guess);
      }
    }

    const incoming = convertExports(parsed);
    const existing = (await readLedger(this.plugin.app, this.ledger)).entries;
    const { added, skipped } = mergeImport(existing, incoming, medium);
    this.plan = added;

    const services = [...new Set(parsed.map((p) => p.found.service))].join(" + ");
    this.resultsEl.createDiv({
      cls: "lib-results-note",
      text:
        services + ": " + incoming.length + " " + (medium === "films" ? "films" : "books") + " — " +
        added.length + " new, " + skipped + " already in " + ledgerName(this.ledger) + ".",
    });
    if (!added.length) return;
    const b = this.resultsEl.createEl("button", { cls: "mod-cta", text: "Import " + added.length });
    b.addEventListener("click", () => this.run());
  }

  async run() {
    if (!this.plan || !this.plan.length) return;
    try {
      await writeLedger(this.plugin.app, this.ledger, (lib) => lib.push(...this.plan));
      new Notice("Imported " + this.plan.length + " into " + ledgerName(this.ledger));
      this.close();
    } catch (e) {
      new Notice("Couldn't import: " + e.message);
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

class AddEntryModal extends Modal {
  /* `preset` comes from a page's add box: the title typed there and the ledger that
     page writes to. With a title, the lookup runs as the dialog opens. */
  constructor(plugin, preset = {}) {
    super(plugin.app);
    this.plugin = plugin;
    this.query = preset.query ?? "";
    this.presetLedger = preset.ledger ? toPath(preset.ledger) : "";
    this.source = "books";
    this.ledger = "";
    this.status = "wishlist";
    this.results = null;
    this.resultsFor = "";
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
    this.ledger = ledgers.includes(this.presetLedger) ? this.presetLedger : ledgers[0];
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
      t.setValue(this.query);
      t.onChange((v) => (this.query = v));
      t.inputEl.addEventListener("keydown", (evt) => {
        if (evt.key !== "Enter") return;
        evt.preventDefault();
        /* Enter looks up; Enter again on the same words takes the top result — so
           adding a book is type, Enter, Enter. */
        if (this.results && this.results.length && this.resultsFor === this.query.trim()) {
          this.commit(this.results[0]);
        } else {
          this.run();
        }
      });
      window.setTimeout(() => t.inputEl.focus(), 0);
    });
    search.addButton((b) => b.setButtonText("Search").setCta().onClick(() => this.run()));

    this.resultsEl = contentEl.createDiv({ cls: "lib-results" });
    if (this.query.trim()) this.run();
  }

  /* Film lookup needs a free TMDB key. Ask for it here, where the need shows up,
     rather than sending anyone off to settings halfway through adding a film. The
     search that follows is the test: a rejected key lands back here. */
  keyPrompt(message) {
    const box = this.resultsEl.createDiv({ cls: "lib-key" });
    box.createDiv({
      cls: "lib-results-note",
      text: message ?? "Film lookup uses TMDB, which needs a free API key. Paste it once and it's saved.",
    });
    box.createEl("a", {
      cls: "lib-key-link",
      text: "Get a free key at themoviedb.org",
      attr: { href: "https://www.themoviedb.org/settings/api" },
    });
    const row = box.createDiv({ cls: "lib-key-row" });
    const input = row.createEl("input", { attr: { type: "text", placeholder: "TMDB API key (v3)" } });
    const go = async () => {
      const key = input.value.trim();
      if (!key) return;
      this.plugin.settings.tmdbApiKey = key;
      await this.plugin.saveSettings();
      this.run();
    };
    row.createEl("button", { cls: "mod-cta", text: "Save and search" }).addEventListener("click", go);
    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        evt.stopPropagation();
        go();
      }
    });
    if (this.query.trim()) {
      const bare = box.createEl("button", {
        cls: "lib-key-bare",
        text: "Add “" + this.query.trim() + "” without looking it up",
      });
      bare.addEventListener("click", () => this.commit({ title: this.query.trim() }));
    }
    window.setTimeout(() => input.focus(), 0);
  }

  guessSource(ledgerPath) {
    return /film|movie|watch|cinema/i.test(ledgerPath) ? "films" : "books";
  }

  async run() {
    if (!this.query.trim()) return;
    this.results = null;
    this.resultsEl.empty();

    if (this.source === "manual") {
      await this.commit({ title: this.query.trim() });
      return;
    }
    if (this.source === "films" && !this.plugin.settings.tmdbApiKey) {
      this.keyPrompt();
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
      /* A bad key is the likely failure on the film path — ask again in place. */
      if (this.source === "films" && (e.status === 401 || /401/.test(String(e.message)))) {
        this.keyPrompt("TMDB didn't accept that key. Check it and paste it again.");
        return;
      }
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

    this.results = results;
    this.resultsFor = this.query.trim();
    this.resultsEl.createDiv({ cls: "lib-results-note", text: "Enter adds the first result, or click any." });
    results.forEach((r, i) => {
      const row = this.resultsEl.createDiv({ cls: "lib-result" + (i === 0 ? " is-top" : "") });
      if (r.cover) {
        row.createEl("img", { cls: "lib-thumb", attr: { src: r.cover, loading: "lazy", alt: "" } });
      }
      const text = row.createDiv({ cls: "lib-result-text" });
      text.createDiv({ cls: "lib-result-title", text: r.title || "Untitled" });
      const sub = [r.author, r.year].filter(Boolean).join(" · ");
      if (sub) text.createDiv({ cls: "lib-result-sub", text: sub });
      row.addEventListener("click", () => this.commit(r));
    });
  }

  async commit(result, force) {
    const entry = { title: result.title, status: this.status };
    if (result.author) entry.author = result.author;
    if (result.year) entry.year = result.year;
    /* Prefer the identifier over a baked URL — it survives a CDN reshuffle. */
    if (result.isbn) entry.isbn = result.isbn;
    else if (result.cover) entry.cover = result.cover;

    /* Silently writing a second row for a title already on the shelf loses the
       thing the ledger is for. Offer the edits that were actually wanted, and keep
       a duplicate available — a different edition or translation is a real one. */
    if (!force) {
      let hit = null;
      try { hit = await findEntryByTitle(this.app, this.ledger, entry.title); } catch (e) {}
      if (hit) return this.showExisting(result, hit);
    }

    try {
      await appendEntry(this.app, this.ledger, entry);
      new Notice("Added “" + entry.title + "” to " + this.ledger.replace(/\.md$/, ""));
      this.close();
    } catch (e) {
      new Notice("Couldn't add: " + e.message);
    }
  }

  showExisting(result, hit) {
    const { entry, index } = hit;
    const ledgerName = this.ledger.replace(/\.md$/, "");
    this.resultsEl.empty();

    const box = this.resultsEl.createDiv({ cls: "lib-dupe" });
    box.createDiv({
      cls: "lib-dupe-title",
      text: "“" + entry.title + "” is already in " + ledgerName,
    });
    const bits = [
      entry.status,
      entry.rating != null ? entry.rating + "★" : null,
      Array.isArray(entry.finished)
        ? entry.finished.length + (entry.finished.length === 1 ? " sitting" : " sittings")
        : entry.finished
        ? "1 sitting"
        : null,
    ].filter(Boolean);
    if (bits.length) box.createDiv({ cls: "lib-dupe-sub", text: bits.join(" · ") });

    const act = (label, fn) => {
      const b = box.createEl("button", { cls: "lib-dupe-btn", text: label });
      b.addEventListener("click", async () => {
        try {
          await fn();
          this.close();
        } catch (e) {
          new Notice("Couldn't update: " + e.message);
        }
      });
      return b;
    };

    const today = todayStamp();
    act("Finished again today", async () => {
      await writeLedger(this.app, this.ledger, (lib) => addFinishedDate(lib[index], today));
      new Notice("“" + entry.title + "” — another sitting, " + today);
    });

    if (entry.status !== this.status) {
      act("Set status to " + this.status, async () => {
        await writeLedger(this.app, this.ledger, (lib) => (lib[index].status = this.status));
        new Notice("“" + entry.title + "” is now " + this.status);
      });
    }

    /* Not through act(): commit() closes on success and leaves the modal open with
       a Notice on failure, so wrapping it would swallow the error behind a close. */
    const sep = box.createEl("button", { cls: "lib-dupe-btn", text: "Add as a separate entry" });
    sep.addEventListener("click", () => this.commit(result, true));
  }

  onClose() {
    this.contentEl.empty();
  }
}

/* Promotion was a two-step manual job: make the file, then hand-write `note:`
   back onto the row. Both halves fail quietly on their own — a note nothing points
   at, or a `note:` pointing at a file that doesn't exist — so they're one action.
   Shared by the command and the shelf menu. */
async function promoteEntry(plugin, ledger, entry) {
  const app = plugin.app;
  const folder = (plugin.settings.notesFolder || "Library/notes").replace(/\/$/, "");
  /* Obsidian forbids these in a filename; a title carrying one would otherwise
     fail at create() with a message about the path rather than the title. */
  const safe = String(entry.title ?? "Untitled").replace(/[\\/:*?"<>|#^[\]]/g, "").trim();
  const notePath = folder + "/" + safe + ".md";
  try {
    if (folder && !app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
    if (!app.vault.getAbstractFileByPath(notePath)) await app.vault.create(notePath, "```library-card\n```\n\n");
    const ref = notePath.replace(/\.md$/, "");
    await writeLedger(app, ledger, (lib) => {
      const i = lib.findIndex((e) => titleKey(e.title) === titleKey(entry.title));
      if (i !== -1) lib[i].note = ref;
    });
    new Notice("Created " + ref);
    const file = app.vault.getAbstractFileByPath(notePath);
    if (file) await app.workspace.getLeaf(false).openFile(file);
    return true;
  } catch (e) {
    new Notice("Couldn't promote: " + e.message);
    return false;
  }
}

/* A rating is picked, not typed: halves from 0.5 to 5, plus clearing it. */
class RatingModal extends Modal {
  constructor(plugin, src, entry) {
    super(plugin.app);
    this.plugin = plugin;
    this.src = src;
    this.entry = entry;
  }

  onOpen() {
    this.titleEl.setText("Rate “" + (this.entry.title ?? "Untitled") + "”");
    const row = this.contentEl.createDiv({ cls: "lib-rate" });
    for (let r = 0.5; r <= 5; r += 0.5) {
      const b = row.createEl("button", { cls: "lib-rate-btn", text: String(r) });
      if (this.entry.rating === r) b.addClass("mod-cta");
      b.addEventListener("click", () => this.set(r));
    }
    if (this.entry.rating != null) {
      const clear = this.contentEl.createEl("button", { cls: "lib-rate-clear", text: "Clear rating" });
      clear.addEventListener("click", () => this.set(null));
    }
  }

  async set(r) {
    await this.plugin.editEntry(this.src, this.entry, (e) => {
      if (r == null) delete e.rating;
      else e.rating = r;
    });
    this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

/* A yes/no before anything destructive. */
class ConfirmModal extends Modal {
  constructor(app, message, action, onYes) {
    super(app);
    this.message = message;
    this.action = action;
    this.onYes = onYes;
  }

  onOpen() {
    this.titleEl.setText(this.message);
    const row = this.contentEl.createDiv({ cls: "modal-button-container" });
    const yes = row.createEl("button", { cls: "mod-warning", text: this.action });
    yes.addEventListener("click", async () => {
      await this.onYes();
      this.close();
    });
    row.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}

class PromoteModal extends Modal {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
    this.ledger = "";
    this.pick = null;
  }

  async onOpen() {
    this.titleEl.setText("Create note for a library entry");
    const { contentEl } = this;
    contentEl.addClass("lib-add-modal");

    const ledgers = await this.plugin.findLedgers();
    if (!ledgers.length) {
      contentEl.createDiv({ cls: "lib-error", text: "No ledger notes found." });
      return;
    }
    this.ledger = ledgers[0];

    new Setting(contentEl).setName("Ledger").addDropdown((d) => {
      for (const l of ledgers) d.addOption(l, l.replace(/\.md$/, ""));
      d.setValue(this.ledger).onChange((v) => {
        this.ledger = v;
        this.list();
      });
    });

    const search = new Setting(contentEl).setName("Filter");
    search.addText((t) => {
      t.setPlaceholder("Title…");
      t.onChange((v) => {
        this.query = v;
        this.list();
      });
      window.setTimeout(() => t.inputEl.focus(), 0);
    });

    this.resultsEl = contentEl.createDiv({ cls: "lib-results" });
    this.list();
  }

  async list() {
    this.resultsEl.empty();
    const res = await readLedger(this.plugin.app, this.ledger);
    const q = titleKey(this.query || "");
    /* Entries that already have a note are the ones this command has nothing to
       do, so they're out of the list rather than sitting there as no-ops. */
    const open = res.entries.filter((e) => !e.note && (!q || titleKey(e.title).includes(q)));

    if (!open.length) {
      this.resultsEl.createDiv({
        cls: "lib-results-note",
        text: q ? "No match without a note already." : "Every entry here already has a note.",
      });
      return;
    }

    for (const e of open.slice(0, 12)) {
      const row = this.resultsEl.createDiv({ cls: "lib-result" });
      const text = row.createDiv({ cls: "lib-result-text" });
      text.createDiv({ cls: "lib-result-title", text: e.title ?? "Untitled" });
      const sub = [creatorOf(e), e.year].filter(Boolean).join(" · ");
      if (sub) text.createDiv({ cls: "lib-result-sub", text: sub });
      row.addEventListener("click", () => this.promote(e));
    }
  }

  async promote(entry) {
    if (await promoteEntry(this.plugin, this.ledger, entry)) this.close();
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

    new Setting(containerEl)
      .setName("Notes folder")
      .setDesc("Where “Create note for a library entry” puts the note it makes.")
      .addText((t) =>
        t.setValue(this.plugin.settings.notesFolder).onChange(async (v) => {
          this.plugin.settings.notesFolder = v.trim();
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

const LibraryShelfPlugin = (module.exports = class LibraryShelfPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.shelves = new Set();
    this.searches = new Map(); // note path -> what its search box holds

    this.addRibbonIcon("library", "Open library", () => this.openLibrary());
    this.addCommand({ id: "open-library", name: "Open library", callback: () => this.openLibrary() });

    this.registerMarkdownCodeBlockProcessor("library-bar", (source, el, ctx) => {
      let opts = {};
      try {
        opts = parseYaml(source) || {};
      } catch (e) {
        el.createDiv({ cls: "lib-error", text: "Bad block options: " + e.message });
        return;
      }
      ctx.addChild(new BarChild(this, el, opts, ctx.sourcePath));
    });

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

    this.registerMarkdownCodeBlockProcessor("library-card", (source, el, ctx) => {
      let opts = {};
      try {
        opts = parseYaml(source) || {};
      } catch (e) {
        el.createDiv({ cls: "lib-error", text: "Bad block options: " + e.message });
        return;
      }
      ctx.addChild(new CardChild(this, el, opts, ctx.sourcePath));
    });

    this.addCommand({
      id: "add-entry",
      name: "Add to library",
      callback: () => new AddEntryModal(this).open(),
    });

    this.addCommand({
      id: "import-library",
      name: "Import from Goodreads, StoryGraph or Letterboxd",
      callback: () => new ImportModal(this).open(),
    });

    this.addCommand({
      id: "promote-entry",
      name: "Create note for a library entry",
      callback: () => new PromoteModal(this).open(),
    });

    this.addSettingTab(new LibraryShelfSettingTab(this.app, this));
  }

  onunload() {
    this.shelves.clear();
  }

  refreshAll() {
    for (const shelf of this.shelves) shelf.render();
  }

  /* One row, edited in place — `mutate` null removes it. The index says where the row
     sat when the shelf was drawn; the title check guards against the ledger having
     changed underneath since, and falls back to finding it by title. */
  async editEntry(src, entry, mutate) {
    try {
      await writeLedger(this.app, src.ledger, (lib) => {
        let i = src.index;
        const same = (e) => e && titleKey(e.title) === titleKey(entry.title);
        if (!(i >= 0 && same(lib[i]))) i = lib.findIndex(same);
        if (i === -1) throw new Error("“" + entry.title + "” isn't in " + ledgerName(src.ledger) + " any more");
        if (mutate) mutate(lib[i]);
        else lib.splice(i, 1);
      });
      return true;
    } catch (e) {
      new Notice("Couldn't update: " + e.message);
      return false;
    }
  }

  /* Search is scoped to a page, so only that page's shelves repaint. Cards are
     shelves too (same registry) but aren't searchable — skip them. */
  refreshPage(path) {
    for (const shelf of this.shelves) {
      if (shelf.sourcePath === path && !(shelf instanceof CardChild)) shelf.render();
    }
  }

  /* The ribbon icon. First use in a vault with no ledger builds the whole library —
     Books, Movies, and a hub reading both — so nobody types YAML to get started.
     Every use after that just opens the hub. */
  async openLibrary() {
    const vault = this.app.vault;
    const folder = (this.settings.ledgerFolder || "").replace(/\/$/, "");
    const at = (name) => (folder ? folder + "/" : "") + name;
    const made = [];

    let ledgers = await this.findLedgers();
    if (!ledgers.length) {
      if (folder && !vault.getAbstractFileByPath(folder)) await vault.createFolder(folder);
      for (const [name, total] of [["Books", "books"], ["Movies", "movies"]]) {
        const path = at(name + ".md");
        if (vault.getAbstractFileByPath(path)) continue;
        await vault.create(path, ledgerTemplate(total));
        made.push(path);
      }
      ledgers = await this.findLedgers();
    }
    if (!ledgers.length) {
      new Notice("Couldn't set up a library in " + (folder || "the vault root") + " — a note there is in the way.");
      return;
    }

    let hub = vault.getAbstractFileByPath(at(HUB_NAME));
    if (!hub) {
      hub = await vault.create(at(HUB_NAME), hubTemplate(ledgers));
      made.push(at(HUB_NAME));
    }
    if (made.length) new Notice("Library set up: " + made.map(ledgerName).join(", "));
    await this.app.workspace.getLeaf(false).openFile(hub);
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
    if (!this.settings.collapsed || typeof this.settings.collapsed !== "object") {
      this.settings.collapsed = {};
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
});

/* Pure helpers, exposed for the headless checks in test/ — not plugin API. */
LibraryShelfPlugin._internals = { parseCsv, detectExport, convertExports, mergeImport, coverUrls, isbn10, matchesQuery, applyOptions };
