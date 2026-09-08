# Library Shelf

An Obsidian plugin for a cover-grid library of books and films, where **a title
doesn't need a file.**

Every Obsidian bookshelf tutorial is note-per-book: one file per title, metadata
in frontmatter, a Dataview table over the folder. That's a lot of ceremony for a
paperback you read once and had no thoughts about. This keeps every title on the
shelf as a row in a ledger note, and lets any one of them graduate into a real
note when you actually have something to write about it.

Files buy you links; rows buy you low friction. You get both, applied where each
is worth paying for.

![Library Shelf rendering a shelf of books and films in Obsidian](./images/libraryshelf.png)

## The ledger

A ledger is any note holding a fenced `json` or `yaml` block shaped
`{ library: [ … ] }`. Everything else in the note is left alone, so a ledger can
carry prose, and can render its own shelf.

````markdown
```yaml
library:
  - title: Hiroshima Diary
    author: Michihiko Hachiya
    shelf: Non-Fiction
    isbn: "9780807845479"
    status: active
  - title: Arrival
    director: Denis Villeneuve
    year: 2016
    shelf: Sci-Fi
    status: done
    rating: 5
    finished: [2024-08-19, 2026-01-04]
```
````

That's a complete entry. Only `title` is required.

One ledger per medium works best — `Books.md`, `Films.md` — since you hand-edit
them. A shelf can read across several at once.

### Fields

| Field | |
|---|---|
| `title` | The only required field |
| `author` / `director` | Interchangeable; whichever is set is displayed |
| `year` | |
| `status` | `wishlist` · `active` · `done` · `abandoned` · `reference` |
| `rating` | A number, so it sorts and averages. Halves are fine |
| `finished` | A **list** of dates — a reread is another entry, not an overwrite |
| `shelf` | Free-text grouping: genre, format, however you shelve |
| `cover` | Image URL. Overrides derivation |
| `isbn` / `asin` | Derives a cover for free when `cover` is unset |
| `note` | Path to a real note, once one exists |

`reference` is for books you dip into rather than finish — cookbooks, manuals,
poetry. Without it they sit at `active` forever and clutter every "reading now"
view. `abandoned` is worth recording: what you bounced off is more informative
than another finished title.

### Promoting a row to a note

Add `note: Library/notes/Some Title` and create that file. The shelf marks the
entry with a dot and links its title.

**The note holds only your writing.** Author, cover, rating and status stay in
the ledger, so there's exactly one source of truth and nothing to drift.

## Rendering

````markdown
```library-shelf
from: [Library/Books, Library/Films]
where:
  status: active
group: shelf
size: 96
```
````

With no `from`, the block reads the note it's in.

| Option | |
|---|---|
| `from` | Ledger path, or a list of them. Defaults to the current note |
| `where` | Field/value pairs. A list value matches any of them |
| `group` | Field to group by. `medium` is the ledger's own name, stamped on load |
| `sort` | Field name; `-` prefix for descending. Lists sort on their latest member |
| `limit` | Cap the number shown |
| `size` | Grid column width in px |
| `layout` | `grid` (default) or `table` |
| `columns` | Table columns. Default: `cover, title, author, year, rating` |
| `total` | Count above the shelf. `true` for a bare number, or a label like `books` |
| `stats` | With `total`, adds a breakdown by status and an average rating |
| `empty` | Text shown when nothing matches |

Status drives appearance as well as filtering: `active` gets an accent outline,
`wishlist` dims until hover, `abandoned` desaturates. Editing a ledger repaints
every open shelf that reads it.

`total` counts everything `where` matched, **before** `limit` trims the display —
a number that shrinks when you cap the grid isn't a total.

**Group headers fold.** Click one to collapse its shelf. The state is keyed by
note and group name and kept in the plugin's data, so it survives a re-render
and a reload rather than springing back open every time a ledger changes.

## Appearance

Covers stand on a shelf board rather than floating: each sits in a fixed-height
well whose bottom border is the plinth, and neighbouring wells abut into one
continuous line.

`size` is a **target, not a literal**. Columns must be a fixed width for the
plinth to land at an exact height, which would otherwise leave a gutter down the
right — so the width is solved on render to divide the container evenly, and
re-solved by a `ResizeObserver` when the pane changes. The board runs edge to
edge at any width.

Trim height varies per title, **hashed from the title rather than randomised** —
random heights would reshuffle on every repaint and make the shelf twitch every
time you edit a ledger. A fore-edge strip down the right of each cover is what
makes it read as an object rather than a picture.

Four CSS variables are the tuning knobs, settable on `.lib-shelf` in a snippet:

| Variable | |
|---|---|
| `--lib-plinth` | Shelf board colour. Defaults to the theme's third accent |
| `--lib-paper` | Fore-edge colour |
| `--lib-book-gap` | Space between books |
| `--lib-display` | Serif face for shelf names and counts |

## Covers

An explicit `cover` always wins. Otherwise, with **Derive covers** enabled:

- `isbn` → Open Library. Free, no key, but **coverage is patchy** — it misses a
  lot of manga and older printings.
- `asin` → Amazon's image CDN. Unofficial, but it resolves.

Anything that fails to load falls back to a titled card in the theme's accent
colour. Misses are common enough that this is a normal state, not an error.

A load event alone isn't proof of a cover: **Amazon answers an unknown ASIN with
a 200 and a 1x1 transparent GIF**, not a 404. Images under 10px in either
dimension are therefore treated as misses too.

Films have no derivable identifier — paste a TMDB poster URL into `cover`, or
let the add-entry command fill it in.

## Adding entries

Command palette → **Add to library**. Pick a ledger, search, click a result; the
entry is appended to the ledger's data block in whatever format that block
already uses. "Don't look up" adds a bare title.

- **Books** search Open Library. No API key.
- **Films** search TMDB. Needs a free key in settings.

Lookups go through Obsidian's `requestUrl`, so there's no CORS problem.

## Settings

Ledger folder · default layout · cover width · derive covers · TMDB API key.

## Verification

End-to-end, in a live vault. Every step states what you should see.

**1. Make a ledger.** New note `Library/Books.md`:

````markdown
```library-shelf
group: shelf
```

```yaml
library:
  - title: Everything Is F*cked
    author: Mark Manson
    shelf: Non-Fiction
    isbn: "9780062888433"
    status: done
    rating: 3.5
  - title: Miss Sunflower
    author: Sugano Manami
    shelf: Fiction
    isbn: "4840137390"
    status: wishlist
```
````

*Expected:* two group headers, `FICTION 1` and `NON-FICTION 1`. Everything Is
F\*cked shows a real cover with a `3.5` badge. Miss Sunflower's ISBN has no Open
Library cover, so it renders as a bordered card reading "Miss Sunflower / Sugano
Manami", dimmed to 55% because it's on the wishlist — full opacity on hover.

**2. Live refresh.** With that note open in one pane, open it in a second pane
and change `status: wishlist` to `status: active`.

*Expected:* the first pane's shelf repaints within ~300ms. Miss Sunflower moves
to full opacity with an accent outline. No tab reload.

**3. Cross-ledger read.** New note `Library/Hub.md`:

````markdown
```library-shelf
from: [Library/Books]
where:
  status: done
layout: table
```
````

*Expected:* a one-row table — thumbnail, "Everything Is F*cked", "Mark Manson",
blank year, `3.5`.

**4. Lookup and append.** Command palette → **Add to library**. Ledger
`Library/Books.md`, status `wishlist`, search `piranesi clarke`.

*Expected:* a result list with covers. Clicking one shows the notice
`Added "Piranesi" to Library/Books`, and `Books.md`'s yaml block gains an entry
with `title`, `author`, `year` and `isbn`. Both shelves repaint to include it.

**5. Promotion.** Create `Library/notes/Piranesi.md`, then add
`note: Library/notes/Piranesi` to that entry.

*Expected:* a small dot appears at the bottom-left of the cover, the title
becomes a link, and clicking either opens the note (ctrl/cmd-click opens in a
new pane).

**6. Settings.** Settings → Library Shelf → drag **Cover width**.

*Expected:* open shelves resize immediately, and `data.json` appears in the
plugin folder.

### Logic checks without Obsidian

`main.js` requires `obsidian` at load, so testing outside the app means stubbing
it. The parser, query layer, cover resolution and append round-trip are all
covered that way, with recorded output.

## Licence

MIT.
