//! Timestamp ordering, which this platform does not give us for free.
//!
//! The store orders sessions by `updated_at`. On wasm `Utc::now()` is backed by
//! `Date.now()`, so two calls in the same millisecond return the same value and
//! "newest first" stops being defined. The store compensates; these tests hold
//! both halves of that in place.

#![cfg(feature = "sqlite")]

use agent_web_core::store::SessionStore;
use agent_web_core::types::ChatMessage;
use wasm_bindgen_test::*;

/// The platform limitation itself. If this ever starts failing, the browser
/// clock got finer and the monotonic nudge in the store could be reconsidered —
/// but it is harmless either way, so prefer leaving it alone.
#[wasm_bindgen_test]
fn the_wall_clock_alone_cannot_break_ties() {
    // Over a run of reads rather than one pair. Two back-to-back calls almost
    // always land in the same millisecond, but the clock can tick between them,
    // and an unlucky moment is not a finer clock — it is a red build, which is
    // what a slower machine produced. A millisecond clock read this often
    // cannot help but repeat itself.
    let stamps: Vec<String> = (0..64).map(|_| chrono::Utc::now().to_rfc3339()).collect();
    let collisions = stamps.windows(2).filter(|p| p[0] == p[1]).count();
    assert!(
        collisions > 0,
        "none of {} reads collided, so the clock is finer than assumed: {stamps:?}",
        stamps.len()
    );
}

/// And the compensation: saves in a burst still come back newest-first.
#[wasm_bindgen_test]
fn a_burst_of_saves_stays_ordered() {
    let s = SessionStore::open(":memory:").unwrap();
    let ids = ["a", "b", "c", "d", "e"];
    for id in ids {
        s.save(id, &[ChatMessage::user(id)], "web", None).unwrap();
    }

    let listed: Vec<String> = s.list().unwrap().into_iter().map(|r| r.id).collect();
    let expected: Vec<String> = ids.iter().rev().map(|s| s.to_string()).collect();
    assert_eq!(listed, expected, "newest first, in true insertion order");

    // Timestamps are strictly increasing, not merely distinct.
    let stamps: Vec<String> = s.list().unwrap().into_iter().map(|r| r.updated_at).collect();
    for pair in stamps.windows(2) {
        assert!(
            pair[0] > pair[1],
            "list is descending, so each stamp must exceed the next: {pair:?}"
        );
    }
}

/// Re-saving an existing session moves it back to the top.
#[wasm_bindgen_test]
fn touching_a_session_moves_it_to_the_front() {
    let s = SessionStore::open(":memory:").unwrap();
    for id in ["a", "b", "c"] {
        s.save(id, &[ChatMessage::user(id)], "web", None).unwrap();
    }
    s.save("a", &[ChatMessage::user("a again")], "web", None)
        .unwrap();

    let listed: Vec<String> = s.list().unwrap().into_iter().map(|r| r.id).collect();
    assert_eq!(listed, vec!["a", "c", "b"]);
}
