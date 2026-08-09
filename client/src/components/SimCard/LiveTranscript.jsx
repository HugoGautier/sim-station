/**
 * @fileoverview Single-line live transcript with horizontal scroll.
 *
 * Behaviour:
 *   - Auto-scrolls to the right (latest text) on every transcript update,
 *     so the user always sees the most recent words first.
 *   - BUT only auto-scrolls when the user is already "at the end" (within
 *     a small threshold). If the user has scrolled back to look at older
 *     text, we don't yank them back to the present — they can read in
 *     peace and scroll right manually when ready.
 *   - Swallows click/touch/pointer events so the parent SimCard's onClick
 *     (SIM select/deselect) doesn't trigger when the user clicks or drags
 *     inside the transcript area to scroll.
 *   - When idle (no transcript yet), shows a non-breaking space so the
 *     container keeps its 28px height and doesn't collapse the card.
 */

import React, { useRef, useEffect, useCallback } from 'react';

/** Distance from the right edge (px) within which we consider the user
 *  to be "following live" and keep auto-scrolling on new text. */
const FOLLOW_THRESHOLD = 24;

/**
 * @param {{ transcript: string, isModelReady: boolean, error: string | null }} props
 */
export function LiveTranscript({ transcript, isModelReady, error }) {
  const containerRef = useRef(null);
  /** Whether the user is currently at the right edge (i.e. following live). */
  const followingRef = useRef(true);

  // Track manual scroll position. If the user scrolls away from the right
  // edge, stop auto-scrolling on transcript updates; if they come back to
  // within FOLLOW_THRESHOLD of the end, resume.
  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromEnd = el.scrollWidth - el.clientWidth - el.scrollLeft;
    followingRef.current = distanceFromEnd <= FOLLOW_THRESHOLD;
  }, []);

  // Auto-scroll to the right (latest text) on transcript change, only when
  // the user is already following the live edge.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !followingRef.current) return;
    el.scrollLeft = el.scrollWidth;
  }, [transcript]);

  // Swallow mouse/pointer events so the parent SimCard's onClick (used for
  // SIM select/deselect) doesn't fire when the user interacts with the
  // transcript to scroll or read it.
  const stop = useCallback((e) => { e.stopPropagation(); }, []);

  if (error) {
    return (
      <div style={styles.container}>
        <span style={styles.muted}>{error}</span>
      </div>
    );
  }

  if (!isModelReady) {
    return (
      <div style={styles.container}>
        <span style={styles.muted}>Loading voice model…</span>
      </div>
    );
  }

  return (
    <div
      style={styles.container}
      className="live-transcript"
      onClick={stop}
      onMouseDown={stop}
      onPointerDown={stop}
      onTouchStart={stop}
    >
      <div
        ref={containerRef}
        onScroll={onScroll}
        style={styles.scrollArea}
        title="Scroll to review the call from the start"
      >
        <span style={styles.text}>
          {transcript || ' '}
        </span>
      </div>
    </div>
  );
}

const styles = {
  container: {
    position: 'relative',
    width: '100%',
    height: '28px',
    marginBottom: '8px',
    borderRadius: '6px',
    backgroundColor: 'var(--bg-btn)',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
  },
  scrollArea: {
    width: '100%',
    // overflow-x:auto so the user can scroll back to read the start of the
    // call. Still hides the scrollbar with the className-targeted CSS rule
    // in SimCard.css so the bar doesn't eat vertical space in this 28px
    // container.
    overflowX: 'auto',
    overflowY: 'hidden',
    whiteSpace: 'nowrap',
    padding: '0 8px',
    cursor: 'grab',
    scrollbarWidth: 'none',
    msOverflowStyle: 'none',
  },
  text: {
    fontSize: '12px',
    color: 'var(--text)',
    fontFamily: 'inherit',
    lineHeight: '28px',
  },
  muted: {
    fontSize: '11px',
    color: 'var(--text-muted)',
    fontStyle: 'italic',
    padding: '0 8px',
  },
};
