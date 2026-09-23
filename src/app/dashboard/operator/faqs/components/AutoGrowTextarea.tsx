'use client'

// A TEXTAREA SIZED BY WHAT IS IN IT.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY
//
// Both answer boxes on this screen were fixed at three or four rows with resizing turned
// off, so the operator could see about a quarter of what they were writing and had no way
// to make the box bigger. Measured on the live faqs table 2026-09-22: 12 answers, 146 to
// 451 characters, average 275, and EVERY ONE OF THEM CONTAINS A LINE BREAK. These are
// multi-paragraph answers being written and edited through a slot that fits three lines.
//
// ═════════════════════════════════════════════════════════════════════════════
// HOW, AND WHY THERE IS NO JAVASCRIPT IN IT
//
// The usual way to grow a textarea is to measure scrollHeight in an effect and assign
// element.style.height. That writes an inline style, which the code rules in CLAUDE.md
// forbid, and it costs a layout read on every keystroke and a visible jump on first paint
// before the effect runs.
//
// This does it in CSS instead. The wrapper is a one-cell grid holding two things stacked in
// the same cell: the textarea, and an invisible copy of the same text in an ordinary div.
// The copy wraps and is therefore as tall as the text needs. The grid row is as tall as its
// tallest item, and the textarea, stretched to the cell, is exactly that tall too.
//
// THE TWO COPIES MUST MEASURE THE SAME OR THE BOX IS THE WRONG HEIGHT. Font and line height
// are set once on the wrapper and inherited by both (Tailwind's preflight makes a textarea
// inherit them, which it does not do on its own). Padding and wrapping are declared
// identically on each. The border sits on the WRAPPER, outside both, so it cannot count
// towards one and not the other.

import type { ChangeEvent } from 'react'

/**
 * The value with a space on the end.
 *
 * A trailing newline produces no final line box in the pseudo-element, so a box that has
 * just been given a new paragraph would shrink back by one line until the first character
 * of it was typed. One trailing space gives that last line something to be.
 */
function measurableText(value: string): string {
  return `${value} `
}

export function AutoGrowTextarea({
  value,
  onChange,
  disabled = false,
  placeholder,
  ariaLabel,
  /**
   * The smallest the box ever gets, as a Tailwind min-height class on the wrapper.
   *
   * A MINIMUM AND NOT A FIXED HEIGHT. An empty box that is already answer-sized says what
   * length of answer is expected here, which three rows said wrongly.
   */
  minHeightClass = 'min-h-[9rem]',
}: {
  value: string
  onChange: (next: string) => void
  disabled?: boolean
  placeholder?: string
  ariaLabel?: string
  minHeightClass?: string
}) {
  return (
    <div
      className={
        'grid w-full text-[12px] leading-relaxed text-text-primary bg-white ' +
        'border border-border-card rounded-[6px] ' +
        // The focus treatment moves to the wrapper because the border is on the wrapper.
        // Matches the ring the plain inputs on this screen already use.
        'focus-within:border-[#A8D4B8] focus-within:ring-1 focus-within:ring-[#A8D4B8] ' +
        // ── THE CAP ────────────────────────────────────────────────────────────
        // Growing without limit pushes Save and Cancel off the bottom of the screen on a
        // long paste, which is a worse failure than scrolling: the operator can no longer
        // finish the edit at all. Past the cap the wrapper scrolls and the box stops.
        'max-h-[28rem] overflow-y-auto ' +
        `${minHeightClass} ` +
        (disabled ? 'opacity-60 ' : '')
      }
    >
      <textarea
        value={value}
        onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel}
        rows={1}
        className={
          // Both children occupy the SAME grid cell, so the taller one sets the row height
          // and the textarea is stretched to match it.
          '[grid-area:1/1] w-full resize-none overflow-hidden bg-transparent ' +
          'px-3 py-2.5 break-words ' +
          'focus:outline-none disabled:cursor-not-allowed'
        }
      />
      {/* THE INVISIBLE COPY THAT DOES THE MEASURING. aria-hidden because a screen reader
          would otherwise read every answer twice. */}
      <div
        aria-hidden="true"
        className="[grid-area:1/1] invisible whitespace-pre-wrap break-words px-3 py-2.5"
      >
        {measurableText(value)}
      </div>
    </div>
  )
}
