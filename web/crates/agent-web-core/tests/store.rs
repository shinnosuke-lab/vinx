//! The session store, against real SQLite compiled to wasm.
//!
//! Run with `wasm-pack test --node -- --features sqlite`.
//!
//! These use `:memory:`, so the IndexedDB VFS is not exercised — that needs a
//! browser. What they do check is everything above it: the schema, the C API
//! wrapper, and the search semantics this port exists to keep identical to
//! agent-core's. Those are the parts that can silently drift.

#![cfg(feature = "sqlite")]

use agent_web_core::store::SessionStore;
use agent_web_core::types::{ChatMessage, FunctionCall, Role, ToolCall};
use wasm_bindgen_test::*;

fn store() -> SessionStore {
    SessionStore::open(":memory:").expect("open :memory:")
}

fn tool_call(id: &str, name: &str) -> ToolCall {
    ToolCall {
        id: id.to_string(),
        call_type: "function".to_string(),
        function: FunctionCall {
            name: name.to_string(),
            arguments: "{}".to_string(),
        },
    }
}

#[wasm_bindgen_test]
fn save_load_roundtrip_keeps_every_field() {
    let s = store();
    let msgs = vec![
        ChatMessage::system("you are a gateway agent"),
        ChatMessage::user("scan for devices"),
        ChatMessage::assistant(
            Some("scanning".into()),
            Some("the user wants a scan".into()),
            Some(vec![tool_call("call_1", "ble_scan")]),
        ),
        ChatMessage::tool_result("call_1", "found 3 devices"),
    ];
    s.save("s1", &msgs, "web", Some("ble-triage")).unwrap();

    let back = s.load("s1").unwrap();
    assert_eq!(back.len(), 4, "system message is persisted too");
    assert!(matches!(back[0].role, Role::System));
    assert_eq!(back[1].content.as_deref(), Some("scan for devices"));

    // The columns most likely to be lost in a hand-written binding layer.
    assert_eq!(
        back[2].reasoning_content.as_deref(),
        Some("the user wants a scan")
    );
    let calls = back[2].tool_calls.as_ref().expect("tool calls survive");
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].function.name, "ble_scan");
    assert_eq!(back[3].tool_call_id.as_deref(), Some("call_1"));

    let (_, skill) = s.load_state("s1").unwrap();
    assert_eq!(skill.as_deref(), Some("ble-triage"));
}

/// `save` is a whole-table rewrite, so a shortened history must not leave the
/// dropped messages behind. This is also the regression test for statement
/// reuse in the insert loop: without clearing bindings between rows, a message
/// inherits the previous one's tool calls.
#[wasm_bindgen_test]
fn save_replaces_history_rather_than_appending() {
    let s = store();
    s.save(
        "s1",
        &[
            ChatMessage::system("sys"),
            ChatMessage::user("one"),
            ChatMessage::assistant(Some("first".into()), None, Some(vec![tool_call("c1", "t")])),
            ChatMessage::user("two"),
        ],
        "web",
        None,
    )
    .unwrap();
    assert_eq!(s.load("s1").unwrap().len(), 4);

    s.save(
        "s1",
        &[ChatMessage::system("sys"), ChatMessage::user("only")],
        "web",
        None,
    )
    .unwrap();
    let back = s.load("s1").unwrap();
    assert_eq!(back.len(), 2, "old rows are gone, not merged");
    assert_eq!(back[1].content.as_deref(), Some("only"));
    assert!(
        back[1].tool_calls.is_none(),
        "a plain user message must not inherit the previous row's tool calls"
    );
}

/// The archive is the swap device `recall_result` falls through to once a
/// Level-2 compaction has rewritten the working context: a tool result must
/// stay addressable by its call_id, newest generation first.
#[wasm_bindgen_test]
fn archived_tool_results_are_recallable_by_id() {
    let s = store();
    let gen1 = vec![
        ChatMessage::system("sys"),
        ChatMessage::user("q"),
        ChatMessage::assistant(None, None, Some(vec![tool_call("call_7", "read_file")])),
        ChatMessage::tool_result("call_7", "the original bytes"),
    ];
    s.archive_messages("s1", &gen1).unwrap();

    let (tool, content) = s
        .lookup_archived_tool_result("s1", "call_7")
        .unwrap()
        .expect("an archived result is found by its call_id");
    assert_eq!(tool, "read_file", "the issuing assistant row names the tool");
    assert_eq!(content, "the original bytes");

    assert!(
        s.lookup_archived_tool_result("s1", "call_none")
            .unwrap()
            .is_none(),
        "an id the session never produced is a clean miss"
    );

    // The same id rides every later generation; the newest copy answers.
    let mut gen2 = gen1.clone();
    gen2[3] = ChatMessage::tool_result("call_7", "the original bytes (gen2)");
    s.archive_messages("s1", &gen2).unwrap();
    let (_, content) = s
        .lookup_archived_tool_result("s1", "call_7")
        .unwrap()
        .unwrap();
    assert_eq!(content, "the original bytes (gen2)");
}

/// The full fault path after a compaction: the id is gone from the working
/// context (only the summary remains), and `resolve_recall` must retrieve the
/// original from the archive — or answer an honest miss without a store.
#[wasm_bindgen_test]
fn recall_falls_through_to_the_archive_after_compaction() {
    use agent_web_core::agent_loop::resolve_recall;

    let s = store();
    let archived = vec![
        ChatMessage::system("sys"),
        ChatMessage::assistant(None, None, Some(vec![tool_call("call_9", "run_shell")])),
        ChatMessage::tool_result("call_9", "42 devices found"),
    ];
    s.archive_messages("s1", &archived).unwrap();

    // What the working context looks like after Level-2: system + summary.
    let compacted = vec![
        ChatMessage::system("sys"),
        ChatMessage::user("[Conversation Summary] scanning done, data in call_9"),
    ];

    let args = serde_json::json!({ "call_id": "call_9" });
    let (result, success) = resolve_recall(&args, &compacted, None, Some(&s), Some("s1"));
    assert!(success, "archive fall-through failed: {result}");
    assert!(result.contains("42 devices found"), "the original bytes: {result}");
    assert!(result.contains("run_shell"), "the tool name orients the model: {result}");

    let (result, success) = resolve_recall(&args, &compacted, None, None, Some("s1"));
    assert!(!success, "no store means an honest miss, not silence");
    assert!(result.contains("No tool result"), "{result}");
}

#[wasm_bindgen_test]
fn origin_is_written_once_and_updated_at_moves() {
    let s = store();
    s.save("s1", &[ChatMessage::user("hi")], "tui", None).unwrap();
    let first = s.list().unwrap().into_iter().next().unwrap();
    assert_eq!(first.origin, "tui");

    // Reopened from the web frontend: the label stays with wherever it started.
    s.save("s1", &[ChatMessage::user("hi again")], "web", None)
        .unwrap();
    let again = s.list().unwrap().into_iter().next().unwrap();
    assert_eq!(again.origin, "tui");
    assert_eq!(again.created_at, first.created_at);
}

#[wasm_bindgen_test]
fn list_excludes_system_from_counts_and_sorts_pinned_first() {
    let s = store();
    s.save(
        "old",
        &[ChatMessage::system("sys"), ChatMessage::user("a")],
        "web",
        None,
    )
    .unwrap();
    s.save(
        "new",
        &[
            ChatMessage::system("sys"),
            ChatMessage::user("a"),
            ChatMessage::assistant(Some("b".into()), None, None),
        ],
        "web",
        None,
    )
    .unwrap();

    let rows = s.list().unwrap();
    assert_eq!(rows.len(), 2);
    let newest = &rows[0];
    assert_eq!(newest.id, "new", "newest first when nothing is pinned");
    assert_eq!(newest.message_count, 2, "the system message is not counted");

    s.update("old", Some("kept"), Some(true)).unwrap();
    let rows = s.list().unwrap();
    assert_eq!(rows[0].id, "old", "pinned outranks recency");
    assert!(rows[0].pinned);
    assert_eq!(rows[0].title, "kept");
}

#[wasm_bindgen_test]
fn detail_hides_the_system_message() {
    let s = store();
    s.save(
        "s1",
        &[ChatMessage::system("sys"), ChatMessage::user("visible")],
        "web",
        None,
    )
    .unwrap();
    s.set_title("s1", "a title").unwrap();

    let (title, _created, _updated, skill, msgs) = s.detail("s1").unwrap().expect("session exists");
    assert_eq!(title, "a title");
    assert_eq!(skill, None);
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].content.as_deref(), Some("visible"));

    assert!(s.detail("nope").unwrap().is_none());
}

/// The behaviour the upstream comment calls out: terms are ANDed per session but
/// may land in different messages, because one `LIKE '%whole query%'` would
/// almost never match a multi-word query.
#[wasm_bindgen_test]
fn search_ands_terms_across_different_messages() {
    let s = store();
    s.save(
        "both",
        &[
            ChatMessage::user("the bridge keeps dropping"),
            ChatMessage::assistant(Some("check the antenna".into()), None, None),
        ],
        "web",
        None,
    )
    .unwrap();
    s.save(
        "one",
        &[ChatMessage::user("the bridge is fine")],
        "web",
        None,
    )
    .unwrap();

    let hits = s.search("bridge antenna", 10, None).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, "both");

    // Neither term alone should be enough to drop a session that has both.
    assert_eq!(s.search("bridge", 10, None).unwrap().len(), 2);
}

#[wasm_bindgen_test]
fn search_ignores_system_skill_and_tool_messages() {
    let s = store();
    s.save(
        "s1",
        &[
            ChatMessage::system("secretword lives in the prompt"),
            ChatMessage::skill_context("triage", "secretword lives in the skill"),
            ChatMessage::tool_result("c1", "secretword lives in a log dump"),
            ChatMessage::user("something else entirely"),
        ],
        "web",
        None,
    )
    .unwrap();

    assert!(
        s.search("secretword", 10, None).unwrap().is_empty(),
        "prompt noise and log dumps are not searchable content"
    );
    assert_eq!(s.search("entirely", 10, None).unwrap().len(), 1);
}

#[wasm_bindgen_test]
fn blank_query_lists_recent_sessions_without_snippets() {
    let s = store();
    s.save("a", &[ChatMessage::user("one")], "web", None).unwrap();
    s.save("b", &[ChatMessage::user("two")], "web", None).unwrap();

    let hits = s.search("   ", 10, None).unwrap();
    assert_eq!(hits.len(), 2);
    assert_eq!(hits[0].id, "b", "newest first");
    assert!(hits[0].snippets.is_empty());
    assert_eq!(hits[0].match_count, 0);

    let hits = s.search("", 10, Some("b")).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, "a", "exclude_id drops the caller's own session");
}

#[wasm_bindgen_test]
fn search_respects_limit_and_exclude_together() {
    let s = store();
    for id in ["a", "b", "c"] {
        s.save(id, &[ChatMessage::user("shared term")], "web", None)
            .unwrap();
    }
    let hits = s.search("shared", 2, Some("c")).unwrap();
    assert_eq!(hits.len(), 2);
    assert!(hits.iter().all(|h| h.id != "c"));
}

/// A user searching for a literal `%` or `_` must not get a wildcard. This is
/// what `escape_like` plus `ESCAPE '\'` is for.
#[wasm_bindgen_test]
fn like_metacharacters_are_matched_literally() {
    let s = store();
    s.save(
        "literal",
        &[ChatMessage::user("battery at 50% now")],
        "web",
        None,
    )
    .unwrap();
    s.save(
        "other",
        &[ChatMessage::user("battery at 50 percent now")],
        "web",
        None,
    )
    .unwrap();

    let hits = s.search("50%", 10, None).unwrap();
    assert_eq!(hits.len(), 1, "`%` is a literal, not a wildcard");
    assert_eq!(hits[0].id, "literal");

    s.save("under", &[ChatMessage::user("a_b")], "web", None)
        .unwrap();
    s.save("dash", &[ChatMessage::user("axb")], "web", None)
        .unwrap();
    let hits = s.search("a_b", 10, None).unwrap();
    assert_eq!(hits.len(), 1, "`_` is a literal, not a single-char wildcard");
    assert_eq!(hits[0].id, "under");
}

#[wasm_bindgen_test]
fn search_is_ascii_case_insensitive_like_sqlite_like() {
    let s = store();
    s.save("s1", &[ChatMessage::user("Bridge Restarted")], "web", None)
        .unwrap();
    assert_eq!(s.search("bridge", 10, None).unwrap().len(), 1);
    assert_eq!(s.search("BRIDGE", 10, None).unwrap().len(), 1);
}

/// Snippets are cut by character, not by byte. Content here is largely CJK and
/// byte slicing would panic mid-codepoint.
#[wasm_bindgen_test]
fn snippets_are_char_indexed_and_capped() {
    let s = store();
    let long = format!("{}网关重启了{}", "前".repeat(200), "后".repeat(200));
    s.save(
        "s1",
        &[
            ChatMessage::user(&long),
            ChatMessage::assistant(Some(long.clone()), None, None),
            ChatMessage::user("网关重启了 again"),
        ],
        "web",
        None,
    )
    .unwrap();

    let hits = s.search("网关重启了", 10, None).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].match_count, 3, "every matching message is counted");
    assert_eq!(hits[0].snippets.len(), 2, "but only two are excerpted");

    for snip in &hits[0].snippets {
        assert!(snip.contains("网关重启了"), "excerpt covers the match: {snip}");
        // Radius is 60 chars each side, plus the term and two ellipses.
        assert!(snip.chars().count() <= 60 + 5 + 60 + 2, "excerpt stays short");
    }
    assert!(
        hits[0].snippets[1].contains("again"),
        "excerpts come back in chronological order, newest last"
    );
}

#[wasm_bindgen_test]
fn title_of_distinguishes_unnamed_from_missing() {
    let s = store();
    s.save("s1", &[ChatMessage::user("hi")], "web", None).unwrap();

    assert_eq!(
        s.title_of("s1").unwrap().as_deref(),
        Some(""),
        "an existing but unnamed session reports an empty title"
    );
    assert_eq!(s.title_of("nope").unwrap(), None, "a missing session is None");

    s.set_title("s1", "named").unwrap();
    assert_eq!(s.title_of("s1").unwrap().as_deref(), Some("named"));
}

#[wasm_bindgen_test]
fn delete_removes_the_messages_too() {
    let s = store();
    s.save(
        "s1",
        &[ChatMessage::user("hi"), ChatMessage::user("there")],
        "web",
        None,
    )
    .unwrap();
    s.save("s2", &[ChatMessage::user("keep me")], "web", None)
        .unwrap();

    s.delete("s1").unwrap();
    assert!(s.load("s1").unwrap().is_empty());
    assert!(s.detail("s1").unwrap().is_none());
    assert_eq!(s.list().unwrap().len(), 1);
    assert_eq!(s.load("s2").unwrap().len(), 1, "other sessions untouched");
}

#[wasm_bindgen_test]
fn a_namespace_gives_each_gateway_its_own_database() {
    use agent_web_core::storage::db_name;

    assert_eq!(
        db_name(None),
        "sessions.db",
        "no namespace keeps the name a database written before this existed already has"
    );
    assert_eq!(db_name(Some("  ")), "sessions.db", "blank is no namespace");

    assert_eq!(db_name(Some("192.168.1.104:60000")), "sessions-192-168-1-104-60000.db");
    assert_ne!(
        db_name(Some("192.168.1.104:60000")),
        db_name(Some("192.168.1.105:60000")),
        "two gateways must not share a history"
    );

    // The namespace comes from a query parameter, so it is reachable by anyone
    // who can hand the operator a link. It ends up as a filename.
    assert_eq!(db_name(Some("../../etc/passwd")), "sessions-etc-passwd.db");
    assert!(!db_name(Some("a/b\\c")).contains(['/', '\\']));
}

/// A sub-agent transcript (`origin = 'task'`, hidden from the session list)
/// must stay resolvable by the id its task report carries: id resolution goes
/// straight at the sessions table, not through `list()`'s visible-only filter.
#[wasm_bindgen_test]
fn resolve_id_prefix_sees_hidden_task_sessions() {
    let s = store();
    let task_id = "task-cccc3333-0000-0000-0000-000000000009";
    s.save(task_id, &[ChatMessage::user("delegated")], "task", None)
        .unwrap();
    s.save("dddd4444-visible", &[ChatMessage::user("q")], "web", None)
        .unwrap();

    // The UI list keeps hiding task transcripts.
    assert!(s.list().unwrap().iter().all(|r| r.origin != "task"));

    // Full id and unique prefix both resolve to the hidden session.
    assert_eq!(s.resolve_id_prefix(task_id).unwrap(), vec![task_id]);
    assert_eq!(s.resolve_id_prefix("task-cccc3333").unwrap(), vec![task_id]);

    // A shared prefix reports every candidate (the tool renders "ambiguous").
    s.save("task-cccc3333-fork", &[ChatMessage::user("x")], "task", None)
        .unwrap();
    assert_eq!(s.resolve_id_prefix("task-cccc3333").unwrap().len(), 2);

    // No match is a clean empty, not an error.
    assert!(s.resolve_id_prefix("ffffffff").unwrap().is_empty());
}

/// `_` in a prefix must match literally, not as the LIKE single-char wildcard
/// — same `escape_like` + `ESCAPE '\'` contract as search.
#[wasm_bindgen_test]
fn resolve_id_prefix_escapes_like_metacharacters() {
    let s = store();
    s.save("task_under", &[ChatMessage::user("a")], "task", None)
        .unwrap();
    s.save("taskXother", &[ChatMessage::user("b")], "task", None)
        .unwrap();

    assert_eq!(
        s.resolve_id_prefix("task_").unwrap(),
        vec!["task_under"],
        "`_` is a literal, not a single-char wildcard"
    );
}

/// The tool layer over the same fact: `read_session` renders a hidden task
/// transcript when handed the id (or a unique prefix) from a task report.
#[wasm_bindgen_test]
async fn read_session_reads_hidden_task_transcripts() {
    use agent_web_core::session_tools::ReadSessionTool;
    use agent_web_core::tool::{Tool, ToolContext};
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    let s = store();
    s.save(
        "task-cccc3333-0000-0000-0000-000000000009",
        &[
            ChatMessage::system("sys"),
            ChatMessage::user("delegated prompt"),
            ChatMessage::assistant(Some("child final report".into()), None, None),
        ],
        "task",
        None,
    )
    .unwrap();

    let tool = ReadSessionTool::new(Arc::new(s));
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let ctx = ToolContext::new(tx, Arc::new(AtomicBool::new(false)));

    // Unique prefix (the natural thing for a model to pass).
    let res = tool
        .execute(serde_json::json!({ "id": "task-cccc3333" }), &ctx)
        .await;
    assert_eq!(res.success, Some(true), "got: {}", res.output);
    assert!(res.output.contains("child final report"));
    assert!(res.output.contains("HISTORICAL"));
    assert!(!res.output.contains("sys"), "system prompt is not rendered");
}

#[wasm_bindgen_test]
fn update_changes_only_what_is_given() {
    let s = store();
    s.save("s1", &[ChatMessage::user("hi")], "web", None).unwrap();
    s.update("s1", Some("first"), Some(true)).unwrap();

    s.update("s1", None, Some(false)).unwrap();
    let row = s.list().unwrap().into_iter().next().unwrap();
    assert_eq!(row.title, "first", "title survives a pinned-only update");
    assert!(!row.pinned);

    s.update("s1", Some("second"), None).unwrap();
    let row = s.list().unwrap().into_iter().next().unwrap();
    assert_eq!(row.title, "second");
    assert!(!row.pinned, "pinned survives a title-only update");
}
