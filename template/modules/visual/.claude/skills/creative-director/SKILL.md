---
name: creative-director
description: Choose this product's visual direction before screens are built. Researches references, renders three distinct design directions as real pages with screenshots, gets an independent critique, stops for the owner's choice, then writes DESIGN.md. Use for a new product's look, a new major screen, or a redesign; also when someone asks what the app should look like.
argument-hint: "[screen or feature to design]"
allowed-tools: Bash(proj shot *), PowerShell(proj shot *), Bash(mkdir -p design/*), PowerShell(mkdir design/*)
---

# Creative Director

Design target: `$ARGUMENTS` (empty: the product's main screen from `docs/BRIEF.md`).
If `DESIGN.md` already says "Status: approved", extend that system instead: skip to step 4 with one direction
that follows it, unless the owner asked for a redesign.

## 1. Brief (ask at most three questions, only what you cannot infer)

Read `docs/BRIEF.md` and `DESIGN.md`. Ask the owner only for what is missing, in one message:
- who it is for and three words for how it should feel;
- products or sites they like or dislike for this;
- fixed constraints (existing brand colors or logo, platforms, accessibility needs).

## 2. Research

Hand the brief to the `design-researcher` agent. It writes `design/research.md`: 6–10 references from this product's
category and one adjacent field, each with a link and the one pattern worth taking. No web access: say so and
work from the brief.

## 3. Three distinct directions

Create directions A, B and C that differ on purpose: typography pairing, color strategy, density and layout,
shape and imagery language. Each must still fit the brief. For each direction:
- `design/directions/<a|b|c>/index.html`: one self-contained static page (inline CSS, no build step) showing the
  target screen with realistic content, never lorem ipsum, plus a short comment block naming its tokens;
- screenshots at desktop and mobile size:
  `proj shot design/directions/a/index.html design/directions/a/desktop.png --width 1440 --height 900`
  `proj shot design/directions/a/index.html design/directions/a/mobile.png --width 390 --height 844`
  Without `proj`, run Chrome or Edge directly:
  `<browser> --headless=new --hide-scrollbars --window-size=1440,900 --screenshot=<out.png> <file URL>`.
For a game or a native mobile app the page is only a canvas: show the main screen at device size (game: the HUD
over a representative scene, plus the title or menu screen), not a website about the product.
Look at every screenshot yourself before moving on.

## 4. Independent critique

For each direction, give the `visual-critic` agent only the screenshots, the brief and the direction's one-line
intent, never your own reasoning. Fix clear defects it finds (contrast, overflow, broken mobile layout) and
re-shoot once. Keep the three directions distinct: do not average them.

## 5. Owner's choice (stop here)

Show the owner, for each direction: its name, the idea in one sentence, the screenshot paths, the critic's score
and its main concern. Ask them to pick one, combine named parts, or ask for revisions. Build no screens and write
no `DESIGN.md` until they choose.

## 6. DESIGN.md

From the chosen direction, rewrite `DESIGN.md`: status approved with the date and direction; 3–5 principles;
tokens (color roles with hex values and text contrast ratios, type scale, spacing scale, radius, elevation,
motion); layout grid and breakpoints; core components with their states (button, input, card, navigation);
imagery and icons; voice and microcopy; accessibility rules (text contrast at least 4.5:1, visible focus, touch
targets at least 44px); do and don't. Record the choice in `docs/DECISIONS.md`. Keep `design/directions/` as
the reference.

## 7. Afterwards

Every UI change comes with fresh screenshots and a `visual-critic` review against `DESIGN.md` before its pull
request is marked ready.
