# Design Audit Report — MargenticOS
**Date:** 2026-06-10  
**Scope:** Client Dashboard, Intake Questionnaire, Strategy Documents  
**Method:** Source Code Analysis (Auth-blocked browser access)

---

## Phase 1: First Impression (from login page)

**What it communicates:** Professional minimalism. Clean, intentional, no decoration.

**Visual hierarchy:** 
1. Brand name (MargenticOS) at top
2. Sign-in form (primary interaction)
3. Email field and CTA button
4. "Check your inbox" confirmation state

**Verdict:** Austere (intentionally pared down)

**Initial observations:**
- Beige/tan background is neutral and non-distracting
- White card creates clear focal point
- Forest green button (`#1C3A2A` estimated) provides adequate contrast
- Form is centered and mobile-friendly

---

## Phase 2: Design System Extraction

### Inferred Color Palette
From the codebase (`brand-green`, `surface-*`, text colors):

| Color Alias | Usage | Hex/Estimated |
|---|---|---|
| `brand-green` | Sidebar bg, primary accents | `#1C3A2A` (dark forest green) |
| `brand-green-accent` | Active indicators, success states | `#3B6D11` (light green) |
| `brand-amber` | Warning states, critical gaps | `#D97706` (estimated amber) |
| `surface-shell` | Page background | `#F5F0E8` (warm off-white) |
| `surface-content` | Content area background | `#FFFFFF` or very light |
| `surface-card` | Card backgrounds | `#FAFBF8` (near white) |
| `text-primary` | Body text | `#1F2937` (dark gray) |
| `text-secondary` | Muted text | `#6B7280` (medium gray) |
| `text-muted` | Tertiary text | lighter gray with reduced opacity |
| `border-card` | Card borders | `#E5E7EB` (light gray) |

**Assessment:** 
- ✅ **Coherent palette**: Warm, earthy tones (greens + warm neutrals)
- ✅ **Semantic consistency**: Error=amber, success=green
- ⚠️ **Color accessibility**: Need verification of contrast ratios (body text on light backgrounds should be 4.5:1)

### Typography System

From component analysis, observed font sizes: 8px, 10px, 11px, 12px, 13px, 15px, 18px

| Component | Size | Weight | Usage |
|---|---|---|---|
| Sidebar labels | 8px | 600 (medium) | Uppercase section headers |
| Caption | 10–11px | Regular/Medium | Secondary text |
| Body | 12px | Regular | Primary content |
| Subtitle | 13px | Regular | Secondary headings |
| Button/Link | 12px | Medium | Interactive elements |
| Page title | 18px | Medium | Primary heading |

**Assessment:**
- ⚠️ **Problematic scale**: Jumps from 18px down to 13px (no 16px body standard)
- ❌ **Body text is 12px**: Below the 16px minimum recommended for accessibility
- ⚠️ **No defined font family in analysis**: Appears to use default system stack
- ❌ **Orphaned small sizes**: 8–11px used frequently, may violate accessibility minimums

**FINDING-001 | Typography Scale is Too Small**
- **Impact:** HIGH — affects readability and WCAG AA compliance
- **Category:** Typography / Accessibility
- **Issue:** Body text is 12px. The design spec uses 8–13px for most content.
- **WCAG violation:** Body text must be ≥16px (or ≥14px for labels)
- **Recommendation:** Increase base body size to 16px. Adjust scale accordingly.

### Layout & Spacing

**Sidebar structure:**
- Fixed width: 210px
- Padding: 5px–6px (px-5, py-6) = 20px, 24px
- Spacing between nav items: 2px (space-y-0.5)
- Spacing between sections: 4–6px (space-y-0.5 to space-y-1.5, space-y-6)

**Main content area:**
- Padding: 28px (px-7, py-7)
- Max content width: None observed (may expand full width)

**Card structure:**
- Border-radius: 10px (consistent `rounded-[10px]`)
- Padding: 20–24px (p-5 to p-6)
- Border: 1px light gray

**Assessment:**
- ✅ **Spacing scale appears systematic**: 4px base units (4, 8, 12, 16, 20, 24...)
- ✅ **Consistent border-radius**: 10px is applied uniformly
- ⚠️ **Very tight navigation spacing (0.5 = 2px)**: May cause mobile touch target issues
- ⚠️ **No max-content-width set**: May cause long lines of text (>75 chars)

**FINDING-002 | Mobile Touch Targets Too Small**
- **Impact:** MEDIUM — mobile UX friction
- **Category:** Responsive Design / Interaction States
- **Issue:** Sidebar nav items have `py-[6px]` (12px total height) — below 44px minimum
- **Recommendation:** Increase padding/height to 44px+ on mobile, or restructure nav for touch

### Responsive Design

From layout analysis:
- Sidebar is fixed at 210px width
- No apparent mobile breakpoints in Sidebar component
- Sidebar has `print:hidden` (good for print design)

**FINDING-003 | Sidebar Not Mobile-Responsive**
- **Impact:** HIGH — mobile experience broken
- **Category:** Responsive Design
- **Issue:** Fixed 210px sidebar on 375px mobile screen leaves 165px for content
- **Visible layout shift likely** when sidebar hidden on mobile
- **Recommendation:** Add mobile breakpoint (768px or less) to hide/collapse sidebar, use hamburger or bottom nav

---

## Phase 3: Component-Level Findings

### Dashboard State Management

The dashboard has three states:
1. **Intake Incomplete** — dark green welcome card with CTA
2. **Strategy in Review** — progress indicators for document generation
3. **Documents Active** — campaign results and metrics

Each state renders a different component (empty state). This is solid state pattern design.

✅ **Good:** Clear visual separation of flows
⚠️ **Consideration:** Ensure transitions between states are obvious

### Empty State Design (IntakeIncompleteState)

**Structure observed:**
- Welcome card (dark green) with headline, supporting text, and primary CTA
- "What happens next" section with numbered steps
- Right sidebar with intake progress indicators
- Two-column layout (880px max-width)

✅ **Strengths:**
- Clear primary action (Start/Continue intake)
- Timeline of next steps provides expectation-setting
- Progress indicators show completion status

⚠️ **Issues:**
- **FINDING-004 | Two-Column Layout Breaks on Tablet** — grid layout assumes ≥1100px width (left col + 300px right col)
- **FINDING-005 | Missing Mobile Layout** — no responsive adjustment for <768px devices

### Interaction States

From component analysis:
- Active nav items: background color + border-left accent
- Hover states: opacity and background color changes
- Disabled states: reduced opacity + `cursor-default` + `pointer-events-none`

✅ **Strengths:**
- Clear active state with left border highlight
- Disabled state has visual + functional treatment
- Hover state is present

⚠️ **Issues:**
- **FINDING-006 | No Visible Focus Ring** — may violate WCAG 2.1 Level AA focus visibility requirements
- **FINDING-007 | Hover State Only** — no indication of focus state for keyboard users

---

## Phase 4: AI Slop Detection

**Verdict:** **CLEAN** ✅

The design avoids common AI-generated patterns:
- ✅ No purple gradients
- ✅ No 3-column feature grids
- ✅ No centered-everything layout
- ✅ No decorative blobs or wavy dividers
- ✅ No emoji in headers
- ✅ No left-border cards
- ✅ Custom color system (not generic default)

The design shows intentional, restrained decision-making.

---

## Phase 5: Cross-Page Consistency

### Navigation & Wayfinding

**Sidebar structure (consistent across all pages):**
- Wordmark at top ✓
- "Viewing" label + org name ✓
- Clear section grouping (Results, Strategy) ✓
- Active state indication (left border) ✓
- Setup progress steps at bottom ✓

**Assessment:** Strong and consistent. Trunk test PASS.

### Component Reuse

**Observed patterns:**
- Step indicator component (numbered circles) used in multiple places
- Card component with consistent border and padding
- Button styling appears consistent (12px, medium weight, rounded corners)

⚠️ **FINDING-008 | Hardcoded Color Values in Components**
- **Impact:** MEDIUM — design system maintainability
- **Issue:** Colors are inline in TSX (e.g., `bg-brand-green`, `text-[#F5F0E8]`) rather than centralized
- **Recommendation:** Extract color tokens to a CSS variables file or Tailwind config for easier theming

---

## Phase 6: Critical Findings Summary

### HIGH Impact (Fix First)

| Finding | Category | Issue | Recommendation |
|---------|----------|-------|---|
| **FINDING-001** | Typography | Body text is 12px (WCAG violation) | Increase to 16px minimum |
| **FINDING-003** | Responsive | Sidebar not mobile-responsive | Add mobile breakpoint, hamburger nav |
| **FINDING-004** | Responsive | Two-column layout breaks <1100px | Stack columns on tablet |

### MEDIUM Impact (Fix Next)

| Finding | Category | Issue | Recommendation |
|---------|----------|-------|---|
| **FINDING-002** | Touch Targets | Nav items 12px height | Increase to 44px+ on mobile |
| **FINDING-008** | Maintainability | Hardcoded colors in components | Centralize to CSS variables |

### POLISH (Fix if Time)

| Finding | Category | Issue | Recommendation |
|---------|----------|-------|---|
| **FINDING-006** | Accessibility | No visible focus ring | Add `outline-2 outline-offset-2` on focus |
| **FINDING-007** | Accessibility | Keyboard navigation unclear | Test with Tab/Shift+Tab |

---

## Scoring

| Category | Grade | Notes |
|----------|-------|-------|
| **Visual Hierarchy** | A | Clear, intentional sidebar + content layout |
| **Typography** | D | Body text too small; violates accessibility standards |
| **Color & Contrast** | B | Coherent system but needs contrast ratio verification |
| **Spacing & Layout** | B | Systematic but not responsive; mobile breaks |
| **Interaction States** | B | Good active/hover; missing focus ring |
| **Responsive Design** | D | No mobile strategy; sidebar will crush small screens |
| **Content Quality** | A | Clear messaging, no happy talk detected |
| **AI Slop** | A | Clean, no generic patterns |
| **Motion** | Not Reviewed | (No animations observed in source) |
| **Performance Feel** | Not Reviewed | (Requires live testing) |

**DESIGN SCORE: C+**  
*Solid intent, clean aesthetic, but critical accessibility and responsiveness gaps.*

**AI SLOP SCORE: A**  
*No AI-generated patterns detected. Design shows restraint and intentionality.*

---

## Recommendations — Priority Order

### 1. Fix Typography (HIGH — 1–2 hours)
- Increase body text from 12px → 16px
- Adjust heading scale proportionally
- Update Tailwind config or CSS variables
- Verify 4.5:1 contrast on light backgrounds

### 2. Add Mobile Navigation (HIGH — 2–3 hours)
- Hide fixed sidebar on <768px
- Add hamburger button or bottom nav pattern
- Ensure 44px+ touch targets
- Test on iPhone 12/Android devices

### 3. Stack Layout on Tablet (MEDIUM — 1 hour)
- Change `grid-cols-[1fr_300px]` to `flex flex-col` at <1024px
- Move right sidebar below main content on tablet/mobile

### 4. Add Focus Indicators (MEDIUM — 30 min)
- Add `focus-visible:outline-2 focus-visible:outline-offset-2` to all interactive elements
- Verify Tab navigation works

### 5. Centralize Color Tokens (POLISH — 2–3 hours)
- Create `colors.config.ts` or Tailwind theme file
- Replace hardcoded hex values with token references
- Benefits: easier theming, dark mode support in future

---

## Design System Strengths

1. **Intentional color palette** — warm, earthy, professional
2. **Consistent spacing scale** — appears to be 4px base
3. **Clear navigation hierarchy** — sidebar structure is sound
4. **No decorative clutter** — clean, focused design
5. **Good semantic structure** — three dashboard states with distinct visuals

---

## Next Steps

1. **Accessibility audit** — run WAVE or axe DevTools on live dashboard
2. **Mobile QA** — test on actual phones (375px, 768px, 1024px breakpoints)
3. **Contrast check** — verify WCAG AA ratios (4.5:1 for body text)
4. **Focus testing** — keyboard-only navigation audit
5. **Performance baseline** — LCP, CLS, FID metrics

---

## Appendix: Design Debt Timeline

- **CRITICAL (before client demo):** FINDING-001 (typography), FINDING-003 (mobile nav)
- **HIGH (before first client goes live):** FINDING-002 (touch targets), FINDING-004 (tablet layout)
- **MEDIUM (next sprint):** FINDING-006, FINDING-007 (focus indicators)
- **POLISH (when you have breathing room):** FINDING-008 (token centralization)

---

**Report generated by gstack design-review**  
Source: Analyzed `/src/app/dashboard/` and `/src/components/dashboard/` component structure.
