#!/usr/bin/env python3
"""Renders HANDBOOK.md to a print-ready PDF.

Rendered through headless Chromium rather than a PDF library: the handbook is
long, table-heavy and needs real typography, page breaks that respect
headings, and running page numbers. A layout engine gives all of that for
free.

Run: python3 tool/build_handbook_pdf.py
"""

import base64
import re
from pathlib import Path

import markdown
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'HANDBOOK.md'
OUTPUT = ROOT / 'KWEMA-RIDE-HANDBOOK.pdf'
LOGO = ROOT / 'public' / 'brand' / 'icon-512.png'

CSS = """
@page {
  size: A4;
  margin: 20mm 18mm 22mm 18mm;
}

:root {
  --tz-900:#12142B; --tz-700:#26327A; --tz-500:#3A4BB8; --tz-50:#EEF0FC;
  --mg-600:#B87A12; --mg-500:#E39B1F; --mg-50:#FDF2DE;
  --ink:#12142B; --ink-2:#33323E; --muted:#65626F;
  --line:#DEDAD2; --sand:#F7F4EE;
}

* { box-sizing: border-box; }

body {
  font-family: 'DM Sans', -apple-system, 'Segoe UI', Roboto, sans-serif;
  font-size: 10.2pt;
  line-height: 1.62;
  color: var(--ink-2);
  margin: 0;
  font-variant-numeric: tabular-nums;
}

/* ---- cover ---- */
.cover {
  page-break-after: always;
  height: 247mm;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding-left: 4mm;
}
.cover img { width: 74px; height: 74px; border-radius: 17px; margin-bottom: 26px; }
.cover h1 {
  font-size: 40pt; line-height: 1.02; letter-spacing: -1.6pt;
  color: var(--tz-900); margin: 0 0 10px; font-weight: 800;
  /* The global h1 rule forces a page break before every h1; without this
     override the cover's own heading pushes it onto page two and leaves a
     blank first page. */
  page-break-before: avoid;
}
.cover .sub { font-size: 15pt; color: var(--tz-500); font-weight: 600; margin-bottom: 6px; }
.cover .motto { font-size: 11pt; color: var(--mg-600); font-weight: 600; margin-bottom: 34px; }
.cover .meta { font-size: 9.5pt; color: var(--muted); line-height: 1.9;
  border-top: 2px solid var(--line); padding-top: 16px; max-width: 118mm; }

/* ---- headings ---- */
h1, h2, h3, h4 { color: var(--tz-900); font-weight: 800; letter-spacing: -0.35pt; }
h1 { font-size: 20pt; margin: 0 0 14px; page-break-before: always; page-break-after: avoid; }
h2 {
  font-size: 15pt; margin: 26px 0 10px;
  padding-top: 12px; border-top: 2px solid var(--tz-500);
  page-break-after: avoid;
}
h3 { font-size: 11.6pt; margin: 20px 0 7px; color: var(--tz-700); page-break-after: avoid; }
h1 + p, h2 + p, h3 + p { margin-top: 0; }

/* The contents list follows the title on page two, so no forced break. */
h2#contents { page-break-before: avoid; }

p { margin: 0 0 10px; }
strong { color: var(--ink); font-weight: 700; }
em { color: var(--muted); }

ul, ol { margin: 0 0 12px; padding-left: 20px; }
li { margin-bottom: 5px; }

a { color: var(--tz-500); text-decoration: none; }

code {
  font-family: 'DejaVu Sans Mono', ui-monospace, monospace;
  font-size: 8.8pt; background: var(--sand); padding: 1px 4px;
  border-radius: 3px; color: var(--tz-700);
}

pre {
  background: var(--tz-900); color: #E8E6F2; padding: 13px 15px;
  border-radius: 7px; overflow: hidden; page-break-inside: avoid;
  font-size: 8.1pt; line-height: 1.5; margin: 0 0 14px;
}
pre code { background: none; color: inherit; padding: 0; font-size: inherit; }

table {
  width: 100%; border-collapse: collapse; margin: 0 0 15px;
  font-size: 9.2pt; page-break-inside: avoid;
}
th {
  background: var(--tz-50); color: var(--tz-700); text-align: left;
  padding: 7px 9px; font-weight: 700; border: 1px solid var(--line);
}
td { padding: 7px 9px; border: 1px solid var(--line); vertical-align: top; }
tr:nth-child(even) td { background: #FBFAF8; }

blockquote {
  border-left: 3px solid var(--mg-500); background: var(--mg-50);
  margin: 0 0 14px; padding: 10px 14px; color: #7A5209;
}

hr { border: none; border-top: 1px solid var(--line); margin: 22px 0; }

/* Keep a heading and its first rows together. */
h2, h3 { break-after: avoid-page; }
table, pre, blockquote { break-inside: avoid; }
"""

HEADER = """
<div style="font-size:7pt;color:#9B98A6;width:100%;padding:0 18mm;
            font-family:sans-serif;display:flex;justify-content:space-between">
  <span>Kwema Ride — Platform Handbook</span>
  <span>Jatelo Technologies</span>
</div>
"""

FOOTER = """
<div style="font-size:7pt;color:#9B98A6;width:100%;padding:0 18mm;
            font-family:sans-serif;display:flex;justify-content:space-between">
  <span>© 2026 Jatelo Technologies · Confidential</span>
  <span><span class="pageNumber"></span> / <span class="totalPages"></span></span>
</div>
"""


def build_html(md_text: str) -> str:
    html = markdown.markdown(
        md_text,
        extensions=['tables', 'fenced_code', 'toc', 'sane_lists', 'attr_list'],
    )

    # The cover is composed separately; drop the source title block so it does
    # not repeat on page two.
    html = re.sub(r'^<h1>.*?</h1>', '', html, count=1, flags=re.S)
    html = re.sub(r'<p>Everything about how Kwema Ride works.*?</p>', '', html,
                  count=1, flags=re.S)
    html = re.sub(r'<p><em>Kwema Ride is a product of Jatelo Technologies.*?</p>',
                  '', html, count=1, flags=re.S)

    logo = base64.b64encode(LOGO.read_bytes()).decode() if LOGO.exists() else ''

    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>{CSS}</style></head>
<body>
<div class="cover">
  {'<img src="data:image/png;base64,' + logo + '" alt="">' if logo else ''}
  <h1>Kwema&nbsp;Ride</h1>
  <div class="sub">Platform Handbook</div>
  <div class="motto">Haraka, salama na kwa wakati</div>
  <div class="meta">
    Everything about how Kwema Ride works: what it is, how the money moves,
    why the technical decisions were made the way they were, what is built,
    what is not, and what has to happen before it carries a paying passenger.
    <br><br>
    A Jatelo Technologies product &nbsp;·&nbsp; Dar es Salaam, Tanzania<br>
    Version 1.0 &nbsp;·&nbsp; September 2026
  </div>
</div>
{html}
</body></html>"""


def main() -> None:
    html = build_html(SOURCE.read_text(encoding='utf-8'))
    tmp = ROOT / '.handbook.tmp.html'
    tmp.write_text(html, encoding='utf-8')

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto(tmp.as_uri(), wait_until='networkidle')
        page.wait_for_timeout(1200)
        page.pdf(
            path=str(OUTPUT),
            format='A4',
            print_background=True,
            display_header_footer=True,
            header_template=HEADER,
            footer_template=FOOTER,
            margin={'top': '18mm', 'bottom': '20mm', 'left': '18mm', 'right': '18mm'},
        )
        browser.close()

    tmp.unlink(missing_ok=True)
    size = OUTPUT.stat().st_size / 1024
    print(f'{OUTPUT.name} written ({size:.0f} KB)')


if __name__ == '__main__':
    main()
