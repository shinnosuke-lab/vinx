//! Budget model, Level-1 stepped pruning with an absolute cut, tokenizer
//! calibration, the Level-2 verbatim tail and recall index, and the task-state
//! verdict bands -- ported from xcore's `context.rs` unit tests (xcore keeps
//! them inline as `#[test]`; the engine files in vinx carry no inline tests,
//! so they live here under `wasm_bindgen_test`). Semantics are xcore's except
//! where a comment says "vinx:".

use agent_web_core::context::*;
use agent_web_core::types::*;
use serde_json::json;
use wasm_bindgen_test::*;


fn bulky_write(id: &str, n: usize) -> ChatMessage {
    ChatMessage::assistant(
        None,
        None,
        Some(vec![ToolCall {
            id: id.into(),
            call_type: "function".into(),
            function: FunctionCall {
                name: "write_file".into(),
                arguments: format!(r#"{{"path":"src/{id}.rs","content":"{}"}}"#, "y".repeat(n)),
            },
        }]),
    )
}

fn assistant_call(id: &str, tool: &str) -> ChatMessage {
    ChatMessage::assistant(
        None,
        None,
        Some(vec![ToolCall {
            id: id.to_string(),
            call_type: "function".to_string(),
            function: FunctionCall {
                name: tool.to_string(),
                arguments: "{}".to_string(),
            },
        }]),
    )
}

fn long_result(id: &str, marker: &str) -> ChatMessage {
    ChatMessage::tool_result(id, &format!("{marker} {}", "x".repeat(300)))
}

fn paging_history() -> Vec<ChatMessage> {
    let mut msgs = vec![ChatMessage::system("sys"), ChatMessage::user("do things")];
    let tools = ["read_file", "run_shell", "list_dir"];
    let markers = ["ONE", "TWO", "THREE"];
    for i in 1..=(KEEP_RECENT_TOOL_RESULTS + 2) {
        let id = format!("call_{i}");
        msgs.push(assistant_call(&id, tools[(i - 1) % tools.len()]));
        msgs.push(long_result(&id, markers.get(i - 1).unwrap_or(&"FILLER")));
    }
    msgs
}

fn state_call(id: &str, state: &str) -> ChatMessage {
    ChatMessage::assistant(
        None,
        None,
        Some(vec![ToolCall {
            id: id.to_string(),
            call_type: "function".to_string(),
            function: FunctionCall {
                name: "update_task_state".to_string(),
                arguments: json!({ "state": state }).to_string(),
            },
        }]),
    )
}

fn suffix_chars(msgs: &[ChatMessage], start: usize) -> usize {
    msgs[start..].iter().map(message_chars).sum()
}

#[wasm_bindgen_test]
fn working_budget_is_capped_unless_configured() {
    // A 1M window does not mean a 1M working set: the default budget caps
    // it. Smaller windows still narrow the budget.
    assert_eq!(working_budget_tokens("kimi-k3", 0), DEFAULT_WORKING_BUDGET_TOKENS);
    assert_eq!(working_budget_tokens("glm-5.2", 0), DEFAULT_WORKING_BUDGET_TOKENS);
    assert_eq!(working_budget_tokens("glm-5.1", 0), 160_000.min(200_000));
    // An explicit configuration is the user's call, above or below.
    assert_eq!(working_budget_tokens("kimi-k3", 1_000_000), 1_000_000);
    assert_eq!(working_budget_tokens("kimi-k3", 50_000), 50_000);
    // Thresholds follow the budget: compaction at 75% of the budget in
    // characters (the reserve does not bind at 160k: 160k − 40k = 120k =
    // 0.75 × 160k), pruning at 70% of that, the prune target at 40%.
    let budget = DEFAULT_WORKING_BUDGET_TOKENS as f64 * CHARS_PER_TOKEN_F;
    assert_eq!(compaction_threshold("kimi-k3", 0), (budget * 0.75) as usize);
    assert_eq!(
        pruning_threshold("kimi-k3", 0),
        ((budget * 0.75) as usize as f64 * 0.70) as usize
    );
    assert!(prune_target("kimi-k3", 0) < pruning_threshold("kimi-k3", 0));
    // Small configured budgets: the 40k reserve binds (128k → 88k), and
    // the 35% floor keeps a tiny budget from going to zero (40k → 14k).
    assert_eq!(
        compaction_threshold("glm-5.1", 128_000),
        (88_000.0 * CHARS_PER_TOKEN_F) as usize
    );
    assert_eq!(
        compaction_threshold("glm-5.1", 40_000),
        (40_000.0 * 0.35 * CHARS_PER_TOKEN_F) as usize
    );
    // Large configured budgets: the ratio (1M → 750k).
    assert_eq!(
        compaction_threshold("kimi-k3", 1_000_000),
        (750_000.0 * CHARS_PER_TOKEN_F) as usize
    );
}

#[wasm_bindgen_test]
fn calibration_scales_thresholds_from_measured_ratio() {
    let mut st = SessionContextState::default();
    // No measurement: identity.
    assert_eq!(st.threshold_for(100_000), 100_000);
    assert_eq!(st.calibrated(100_000), 100_000);
    // Too small a sample or no tokens: ignored.
    st.observe(500, 200);
    st.observe(50_000, 0);
    assert!(st.chars_per_token.is_none());
    // Content denser than the default (1.8 chars/token, like the measured
    // Claude sessions): thresholds come DOWN by 1.8/2.4 so they bite
    // earlier on raw character counts.
    st.observe(180_000, 100_000);
    let r = st.chars_per_token.unwrap();
    assert!((r - 1.8).abs() < 1e-9, "{r}");
    assert_eq!(st.threshold_for(240_000), 180_000);
    assert_eq!(st.calibrated(180_000), 240_000);
    // Smoothed, clamped.
    st.observe(6_000_000, 100_000); // absurd 60 chars/token → clamped to 6
    let r = st.chars_per_token.unwrap();
    assert!(r < 6.0 && r > 1.8, "{r}");
    // A compaction keeps the calibration, a full reset drops it.
    st.prune.elided = Some(20);
    st.reset_cut();
    assert!(st.prune.elided.is_none());
    assert!(st.chars_per_token.is_some());
    st.reset();
    assert!(st.chars_per_token.is_none());
}

#[wasm_bindgen_test]
fn request_chars_counts_system_prompt_and_schemas() {
    let msgs = vec![ChatMessage::system(&"s".repeat(1_000)), ChatMessage::user("hi")];
    assert_eq!(context_chars(&msgs), 2);
    assert_eq!(request_chars(&msgs, None), 1_002);
    let tool = ToolDefinition::new(
        "run_shell",
        &"x".repeat(100),
        ToolParameters {
            schema_type: "object".into(),
            properties: std::collections::HashMap::new(),
            required: Vec::new(),
        },
    );
    let with = request_chars(&msgs, Some(&[tool.clone()]));
    assert_eq!(with, 1_002 + serde_json::to_string(&tool).unwrap().len());
}

#[wasm_bindgen_test]
fn context_chars_counts_tool_call_arguments() {
    // A write_file body rides in the assistant message's arguments and is
    // tokenized in full by the provider — it must count.
    let body = "x".repeat(10_000);
    let call = ChatMessage::assistant(
        None,
        None,
        Some(vec![ToolCall {
            id: "w1".into(),
            call_type: "function".into(),
            function: FunctionCall {
                name: "write_file".into(),
                arguments: format!(r#"{{"path":"a.txt","content":"{body}"}}"#),
            },
        }]),
    );
    let msgs = vec![
        ChatMessage::system("sys"),
        ChatMessage::user("write it"),
        call,
        ChatMessage::tool_result("w1", "ok"),
    ];
    let n = context_chars(&msgs);
    assert!(n > 10_000, "arguments counted: {n}");
    assert!(n < 10_200, "…but nothing else inflated: {n}");
    // vinx: reasoning has no signature metadata here; replay is decided per
    // provider profile and always covers tool-call turns, so reasoning counts
    // on an assistant message that carries tool calls and on no other.
    let plain = ChatMessage::assistant(Some("hi".into()), Some("r".repeat(500)), None);
    assert_eq!(context_chars(&[ChatMessage::system("s"), plain]), 2);
    let with_call = ChatMessage::assistant(
        Some("hi".into()),
        Some("r".repeat(500)),
        Some(vec![ToolCall {
            id: "c1".into(),
            call_type: "function".into(),
            function: FunctionCall {
                name: "read_file".into(),
                arguments: "{}".into(),
            },
        }]),
    );
    // "hi" + 500 reasoning + `{}` arguments + the tool name
    assert_eq!(context_chars(&[ChatMessage::system("s"), with_call]), 513);
}

#[wasm_bindgen_test]
fn old_bulky_arguments_are_stubbed_but_recent_and_small_stay() {
    let mut msgs = vec![ChatMessage::system("sys")];
    // 20 write_file calls of 5k each, each answered by a short "ok".
    for i in 0..20 {
        msgs.push(bulky_write(&format!("w{i}"), 5_000));
        msgs.push(ChatMessage::tool_result(&format!("w{i}"), "ok"));
    }
    // One small call among them.
    msgs.push(ChatMessage::assistant(
        None,
        None,
        Some(vec![ToolCall {
            id: "s1".into(),
            call_type: "function".into(),
            function: FunctionCall {
                name: "run_shell".into(),
                arguments: r#"{"command":"ls"}"#.into(),
            },
        }]),
    ));
    msgs.push(ChatMessage::tool_result("s1", "a\nb"));
    let before = context_chars(&msgs);

    let mut view = msgs.clone();
    stub_old_tool_call_args(&mut view, 4);
    // Results were all short ("ok"), so clear_old_tool_results would have
    // left every one of them — yet the 40k+ of stale file bodies go.
    let after = context_chars(&view);
    assert!(after < before / 4, "before={before} after={after}");
    // The 4 most recent results are w17..w19 + s1 → their calls untouched.
    let args_of = |v: &[ChatMessage], id: &str| {
        v.iter()
            .filter_map(|m| m.tool_calls.as_ref())
            .flatten()
            .find(|c| c.id == id)
            .map(|c| c.function.arguments.clone())
            .unwrap()
    };
    assert!(args_of(&view, "w19").contains(&"y".repeat(5_000)));
    assert!(args_of(&view, "w17").contains(&"y".repeat(5_000)));
    assert_eq!(args_of(&view, "s1"), r#"{"command":"ls"}"#);
    // An old one keeps its path, drops its body, and stays valid JSON.
    let stub = args_of(&view, "w0");
    let parsed: serde_json::Value = serde_json::from_str(&stub).expect("stub is JSON");
    assert_eq!(parsed["path"], "src/w0.rs");
    assert!(parsed.get("content").is_none());
    assert!(parsed["_elided"].as_str().unwrap().contains("write_file"));
    // Canonical untouched.
    assert!(args_of(&msgs, "w0").contains(&"y".repeat(5_000)));
    // Idempotent: a second pass does not re-wrap the stub.
    let once = view.clone();
    stub_old_tool_call_args(&mut view, 4);
    assert_eq!(context_chars(&once), context_chars(&view));
}

#[wasm_bindgen_test]
fn prune_plan_keeps_enough_recent_results_to_hit_the_target() {
    let mut msgs = vec![ChatMessage::system("sys")];
    for i in 0..40 {
        msgs.push(bulky_write(&format!("w{i}"), 2_000 + 1));
        msgs.push(ChatMessage::tool_result(&format!("w{i}"), &"r".repeat(1_000)));
    }
    // Each result costs ~3k when kept (2k args + 1k result) and ~320 when
    // elided. Target 60k → roughly 20 kept; never below the floor.
    let keep = prune_plan(&msgs, 60_000);
    assert!(keep >= KEEP_RECENT_TOOL_RESULTS, "{keep}");
    assert!(keep < 40, "{keep}");
    let view = build_request_view_keeping(&msgs, 0, keep).unwrap();
    let size = context_chars(&view);
    assert!(size <= 60_000 + 3_000, "view {size} should land near the target");
    // A tiny target bottoms out at the floor.
    assert_eq!(prune_plan(&msgs, 1), KEEP_RECENT_TOOL_RESULTS);
    // A huge target keeps everything.
    assert_eq!(prune_plan(&msgs, 10_000_000), 40);
}

#[wasm_bindgen_test]
fn prune_state_holds_the_cut_between_prunes() {
    let mut msgs = vec![ChatMessage::system("sys")];
    for i in 0..30 {
        msgs.push(bulky_write(&format!("w{i}"), 3_000));
        msgs.push(ChatMessage::tool_result(&format!("w{i}"), &"r".repeat(1_000)));
    }
    let mut state = PruneState::default();
    let compact_thresh = 10_000_000;
    // Under the threshold: canonical as is, no cut recorded.
    assert!(state.view(&msgs, 10_000_000, 5_000_000, compact_thresh).is_none());
    assert!(state.elided.is_none());
    // Over it: a cut is planned and recorded. (Each kept call costs ~4k;
    // the floor of 8 kept is ~32k, so the threshold must sit above that
    // for the planned cut — not the floor — to be what fits.)
    let prune_thresh = 100_000;
    let target = 80_000;
    let v1 = state.view(&msgs, prune_thresh, target, compact_thresh).expect("pruned");
    let elided = state.elided.expect("cut recorded");
    assert!(elided > 0, "something was elided");
    assert!(30 - elided > KEEP_RECENT_TOOL_RESULTS, "planned above the floor: {elided}");
    assert!(context_chars(&v1) <= prune_thresh);
    assert_eq!(state.planned_size, context_chars(&v1));
    // Next round: one more call + result. The SAME absolute cut applies:
    // every message the provider saw last round is byte-identical in the
    // new view — the previously kept results stay verbatim (no sliding
    // window), and only the new pair is appended.
    msgs.push(bulky_write("w30", 3_000));
    msgs.push(ChatMessage::tool_result("w30", &"r".repeat(1_000)));
    let v2 = state.view(&msgs, prune_thresh, target, compact_thresh).expect("pruned");
    assert_eq!(state.elided, Some(elided), "no re-cut while under threshold");
    assert_eq!(v2.len(), v1.len() + 2);
    for (i, (a, b)) in v1.iter().zip(v2.iter()).enumerate() {
        assert_eq!(
            serde_json::to_string(a).unwrap(),
            serde_json::to_string(b).unwrap(),
            "message {i} changed between rounds"
        );
    }
    // After a compaction the cut is forgotten.
    state.reset();
    assert!(state.elided.is_none());
}

#[wasm_bindgen_test]
fn prune_state_replan_only_moves_the_cut_forward() {
    let mut msgs = vec![ChatMessage::system("sys")];
    for i in 0..30 {
        msgs.push(bulky_write(&format!("w{i}"), 3_000));
        msgs.push(ChatMessage::tool_result(&format!("w{i}"), &"r".repeat(1_000)));
    }
    let prune_thresh = 100_000;
    let target = 80_000;
    let compact_thresh = 10_000_000;
    let mut state = PruneState::default();
    let v1 = state.view(&msgs, prune_thresh, target, compact_thresh).expect("pruned");
    let first_cut = state.elided.unwrap();
    // Keep appending until the verbatim tail pushes the view over the
    // threshold again: the pruner must re-plan, and the new cut must sit
    // further along, never behind the old one.
    let mut rounds = 0;
    let (v_before, v_after) = loop {
        let n = 31 + rounds;
        msgs.push(bulky_write(&format!("w{n}"), 3_000));
        msgs.push(ChatMessage::tool_result(&format!("w{n}"), &"r".repeat(1_000)));
        let before = state.elided.unwrap();
        let prev = state.view(&msgs, prune_thresh, target, compact_thresh).expect("pruned");
        if state.elided.unwrap() != before {
            // `prev` is the re-planned view; rebuild the pre-re-plan one
            // with the old cut to compare the cold prefix.
            let old_view = build_request_view_eliding(&msgs, before);
            break (old_view, prev);
        }
        rounds += 1;
        assert!(rounds < 200, "never re-planned");
    };
    let second_cut = state.elided.unwrap();
    assert!(second_cut > first_cut, "{second_cut} > {first_cut}");
    assert!(context_chars(&v_after) <= target + 5_000, "re-plan lands near the target");
    // Everything BEFORE the old cut is untouched by the re-plan: those
    // placeholders are the same bytes, so the provider's cache still
    // covers that prefix.
    let old_cut_index = cut_message_index(&msgs, first_cut);
    for i in 0..old_cut_index {
        assert_eq!(
            serde_json::to_string(&v_before[i]).unwrap(),
            serde_json::to_string(&v_after[i]).unwrap(),
            "message {i} (before the old cut) changed on re-plan"
        );
    }
    // And the first view's prefix is still what the latest view starts with.
    for i in 0..old_cut_index {
        assert_eq!(
            serde_json::to_string(&v1[i]).unwrap(),
            serde_json::to_string(&v_after[i]).unwrap(),
            "message {i} drifted since the first prune"
        );
    }
    // A cut that points past the history (rewritten without a reset) is
    // not trusted: the pruner plans afresh instead of eliding everything.
    let mut stale = PruneState { elided: Some(10_000), planned_size: 0 };
    let v = stale.view(&msgs, prune_thresh, target, compact_thresh).expect("pruned");
    assert!(stale.elided.unwrap() <= tool_result_count(&msgs));
    assert!(context_chars(&v) <= prune_thresh);
    // A forced cut (provider said "too long") moves forward as well.
    let mut forced = PruneState { elided: Some(second_cut), planned_size: 0 };
    let _ = forced.force_cut(&msgs, 1);
    assert!(forced.elided.unwrap() >= second_cut);
}

#[wasm_bindgen_test]
fn prune_state_steps_instead_of_sliding_when_the_target_is_out_of_reach() {
    // The part pruning cannot touch (here: fat assistant text) is already
    // above the target, so every plan lands at the floor of kept results
    // and the view sits above the pruning line for good. Re-planning each
    // round would then slide the cut by one result per round — the exact
    // churn the absolute cut exists to prevent. Instead the cut must hold
    // until the view has grown by a full step past the last plan (or
    // crosses the compaction line).
    let mut msgs = vec![ChatMessage::system("sys")];
    let fat = "x".repeat(2_000);
    for i in 0..30 {
        msgs.push(ChatMessage::assistant(Some(fat.clone()), None, None));
        msgs.push(bulky_write(&format!("w{i}"), 3_000));
        msgs.push(ChatMessage::tool_result(&format!("w{i}"), &"r".repeat(1_000)));
    }
    // 30 × 2k of untouchable text = 60k > target; prune line 50k, step 20k.
    let prune_thresh = 50_000;
    let target = 30_000;
    let compact_thresh = 10_000_000;
    let mut state = PruneState::default();
    let v1 = state.view(&msgs, prune_thresh, target, compact_thresh).expect("pruned");
    let cut = state.elided.unwrap();
    assert_eq!(30 - cut, KEEP_RECENT_TOOL_RESULTS, "landed on the floor");
    assert!(context_chars(&v1) > prune_thresh, "target out of reach");
    let planned = state.planned_size;
    // Rounds keep coming; the cut must NOT move while the growth since the
    // plan is under one step, even though the view is over the line.
    let mut n = 30;
    let mut held = 0;
    loop {
        msgs.push(ChatMessage::assistant(Some(fat.clone()), None, None));
        msgs.push(bulky_write(&format!("w{n}"), 3_000));
        msgs.push(ChatMessage::tool_result(&format!("w{n}"), &"r".repeat(1_000)));
        n += 1;
        let v = state.view(&msgs, prune_thresh, target, compact_thresh).expect("pruned");
        let grown = context_chars(&build_request_view_eliding(&msgs, cut));
        if grown <= planned + (prune_thresh - target) {
            assert_eq!(state.elided, Some(cut), "cut slid before a full step of growth");
            assert!(context_chars(&v) > prune_thresh);
            held += 1;
        } else {
            assert!(state.elided.unwrap() > cut, "re-planned once a full step had grown");
            break;
        }
        assert!(n < 200, "never re-planned");
    }
    assert!(held >= 2, "the cut held for several rounds: {held}");
    // Over the compaction line, Level 1 re-plans at once (its utmost comes
    // before Level 2 is considered), even if the step is not complete.
    let mut eager = PruneState { elided: Some(0), planned_size: usize::MAX / 2 };
    let _ = eager.view(&msgs, prune_thresh, target, 1_000).expect("pruned");
    assert!(eager.elided.unwrap() > 0, "re-planned because the view is over the compaction line");
}

#[wasm_bindgen_test]
fn superseded_task_state_in_the_verbatim_tail_waits_for_the_cut() {
    // Two accepted registers: the older one is superseded. Behind the cut
    // it is stubbed; in the verbatim tail it stays as the provider saw it.
    let msgs = vec![
        ChatMessage::system("sys"),
        state_call("s1", "goal: first"),
        ChatMessage::tool_result("s1", "ok"),
        bulky_write("w1", 3_000),
        ChatMessage::tool_result("w1", &"r".repeat(1_000)),
        state_call("s2", "goal: second"),
        ChatMessage::tool_result("s2", "ok"),
    ];
    let args_of = |v: &[ChatMessage], id: &str| {
        v.iter()
            .filter_map(|m| m.tool_calls.as_ref())
            .flatten()
            .find(|c| c.id == id)
            .map(|c| c.function.arguments.clone())
            .unwrap()
    };
    // Cut behind everything (elided = 0): s1 sits in the verbatim tail
    // and keeps its arguments even though s2 superseded it.
    let v0 = build_request_view_eliding(&msgs, 0);
    assert!(args_of(&v0, "s1").contains("first"), "{}", args_of(&v0, "s1"));
    assert!(args_of(&v0, "s2").contains("second"));
    // Cut after s1's result (elided = 1): s1 is cold and gets stubbed.
    let v1 = build_request_view_eliding(&msgs, 1);
    assert_eq!(args_of(&v1, "s1"), "{\"state\":\"[superseded]\"}");
    assert!(args_of(&v1, "s2").contains("second"), "the live register is never stubbed");
    // Cut past everything: the live register still survives.
    let v3 = build_request_view_eliding(&msgs, 3);
    assert_eq!(args_of(&v3, "s1"), "{\"state\":\"[superseded]\"}");
    assert!(args_of(&v3, "s2").contains("second"));
}

#[wasm_bindgen_test]
fn should_compact_view_threshold_and_canonical_cap() {
    // Under both limits: no compaction.
    assert!(!should_compact(100, 100, 1000));
    // Pruned view over the compaction threshold: compact.
    assert!(should_compact(2000, 1001, 1000));
    // View small but the canonical history beyond the hard cap: compact
    // anyway — pruning no longer shrinks the canonical context, and every
    // sync rewrites it wholesale to SQLite.
    assert!(!should_compact(CANONICAL_CAP_FACTOR * 1000, 100, 1000));
    assert!(should_compact(CANONICAL_CAP_FACTOR * 1000 + 1, 100, 1000));
}

#[wasm_bindgen_test]
fn over_target_task_states_are_still_the_snapshot() {
    // Between the target and the cap the tool records the write (with a
    // trim nudge); refusing would drop the freshest state right when the
    // model is busiest. The replay must agree: this IS the register.
    let over_target = "y".repeat(TASK_STATE_TARGET_CHARS + 1);
    let msgs = vec![
        ChatMessage::system("sys"),
        state_call("call_1", "goal: older"),
        ChatMessage::tool_result("call_1", "recorded"),
        state_call("call_2", &over_target),
        ChatMessage::tool_result("call_2", "recorded (over target)"),
    ];
    assert_eq!(
        latest_task_state(&msgs).as_deref(),
        Some(over_target.as_str())
    );
}

#[wasm_bindgen_test]
fn task_state_verdict_bands() {
    // The verdict is the single source of truth for the tool, the replay
    // and the view stub — pin its edges. Whitespace-only counts as empty
    // because callers trim first.
    assert_eq!(task_state_verdict(""), TaskStateVerdict::Empty);
    assert_eq!(task_state_verdict("   ".trim()), TaskStateVerdict::Empty);
    assert_eq!(task_state_verdict("goal: x"), TaskStateVerdict::Ok(7));
    assert_eq!(
        task_state_verdict(&"a".repeat(TASK_STATE_TARGET_CHARS)),
        TaskStateVerdict::Ok(TASK_STATE_TARGET_CHARS)
    );
    assert_eq!(
        task_state_verdict(&"a".repeat(TASK_STATE_TARGET_CHARS + 1)),
        TaskStateVerdict::OverTarget(TASK_STATE_TARGET_CHARS + 1)
    );
    assert_eq!(
        task_state_verdict(&"a".repeat(TASK_STATE_MAX_CHARS)),
        TaskStateVerdict::OverTarget(TASK_STATE_MAX_CHARS)
    );
    assert_eq!(
        task_state_verdict(&"a".repeat(TASK_STATE_MAX_CHARS + 1)),
        TaskStateVerdict::OverCap(TASK_STATE_MAX_CHARS + 1)
    );
    // Sizes are chars, not bytes: CJK text is not penalised threefold.
    assert_eq!(task_state_verdict("目标：完成"), TaskStateVerdict::Ok(5));

    assert!(TaskStateVerdict::Ok(1).accepted());
    assert!(TaskStateVerdict::OverTarget(1).accepted());
    assert!(!TaskStateVerdict::OverCap(1).accepted());
    assert!(!TaskStateVerdict::Empty.accepted());
    // The aim quoted to the model sits under the target it must respect.
    assert!(TASK_STATE_AIM_CHARS < TASK_STATE_TARGET_CHARS);
    assert!(TASK_STATE_TARGET_CHARS < TASK_STATE_MAX_CHARS);
}

#[wasm_bindgen_test]
fn a_refused_write_does_not_supersede_the_live_register() {
    // The newest write was over the cap, so the tool refused it and the
    // replay ignores it. The view must keep the SAME register the replay
    // returns intact — not stub the last good one in favour of a write
    // that was never recorded.
    let over_cap = "z".repeat(TASK_STATE_MAX_CHARS + 1);
    let mut msgs = vec![
        ChatMessage::system("sys"),
        state_call("state_1", "goal: first"),
        ChatMessage::tool_result("state_1", "recorded"),
        state_call("state_2", "goal: live"),
        ChatMessage::tool_result("state_2", "recorded"),
        state_call("state_3", &over_cap),
        ChatMessage::tool_result("state_3", "refused"),
    ];
    assert_eq!(latest_task_state(&msgs).as_deref(), Some("goal: live"));
    stub_superseded_task_states(&mut msgs);
    let args = |i: usize| {
        msgs[i].tool_calls.as_ref().unwrap()[0]
            .function
            .arguments
            .clone()
    };
    assert_eq!(args(1), "{\"state\":\"[superseded]\"}");
    assert!(
        args(3).contains("goal: live"),
        "live register stubbed: {}",
        args(3)
    );
    assert_eq!(args(5), "{\"state\":\"[superseded]\"}");
}

#[wasm_bindgen_test]
fn with_no_accepted_write_the_newest_stays_visible() {
    // Every write was refused: nothing is live, but the model should still
    // see its most recent attempt rather than a view of nothing but stubs.
    let over_cap = "z".repeat(TASK_STATE_MAX_CHARS + 1);
    let mut msgs = vec![
        ChatMessage::system("sys"),
        state_call("state_1", &over_cap),
        ChatMessage::tool_result("state_1", "refused"),
        state_call("state_2", ""),
        ChatMessage::tool_result("state_2", "refused"),
    ];
    assert_eq!(latest_task_state(&msgs), None);
    stub_superseded_task_states(&mut msgs);
    let args = |i: usize| {
        msgs[i].tool_calls.as_ref().unwrap()[0]
            .function
            .arguments
            .clone()
    };
    assert_eq!(args(1), "{\"state\":\"[superseded]\"}");
    assert_eq!(args(3), "{\"state\":\"\"}");
}

#[wasm_bindgen_test]
fn tail_is_the_longest_fitting_suffix_on_a_clean_boundary() {
    // system, user, then rounds of assistant(call_N) + result(call_N).
    let msgs = paging_history();
    let n = msgs.len();
    // Budget for the last two rounds and a bit: the start must land on the
    // assistant message that opens the second-to-last round, never on a
    // tool result.
    let budget = suffix_chars(&msgs, n - 4) + 10;
    let start = compaction_tail_start(&msgs, budget);
    assert_eq!(start, n - 4, "two full rounds fit");
    assert_eq!(msgs[start].role, Role::Assistant);
    assert!(suffix_chars(&msgs, start) <= budget);

    // One char short of that: the second-to-last round no longer fits
    // whole, so the tail starts at the LAST round's assistant message —
    // not at the result of the round before it.
    let start = compaction_tail_start(&msgs, budget - 11);
    assert_eq!(start, n - 2);
    assert_eq!(msgs[start].role, Role::Assistant);
}

#[wasm_bindgen_test]
fn tail_never_begins_with_an_orphan_tool_result() {
    let msgs = paging_history();
    let n = msgs.len();
    // Exactly the last tool result fits — but on its own it would be an
    // orphan (its call summarized away), so nothing is kept.
    let budget = message_chars(&msgs[n - 1]);
    assert_eq!(compaction_tail_start(&msgs, budget), n);
    // The last call AND its result fit: that is a valid tail.
    let budget = suffix_chars(&msgs, n - 2);
    assert_eq!(compaction_tail_start(&msgs, budget), n - 2);
}

#[wasm_bindgen_test]
fn tail_leaves_at_least_the_first_user_message_to_summarize() {
    let msgs = vec![
        ChatMessage::system("sys"),
        ChatMessage::user("first"),
        ChatMessage::assistant(Some("reply".to_string()), None, None),
        ChatMessage::user("second"),
    ];
    // Everything would fit; the first user message is still summarized.
    assert_eq!(compaction_tail_start(&msgs, usize::MAX), 2);
    // Without a system prompt the rule is the same: index 0 is summarized.
    let no_sys = msgs[1..].to_vec();
    assert_eq!(compaction_tail_start(&no_sys, usize::MAX), 1);
    // Nothing fits: no tail.
    assert_eq!(compaction_tail_start(&msgs, 0), msgs.len());
    // Degenerate histories never panic.
    assert_eq!(compaction_tail_start(&[], 100), 0);
    assert_eq!(compaction_tail_start(&msgs[..1], 100), 1);
}

#[wasm_bindgen_test]
fn tail_budget_is_a_fixed_share_of_the_compaction_line() {
    let line = compaction_threshold("glm-5.1", 0);
    let budget = compaction_tail_budget(line);
    assert_eq!(budget, (line as f64 * COMPACTION_TAIL_RATIO) as usize);
    assert!(budget < line / 5, "the tail is a small share: {budget} of {line}");
}

#[wasm_bindgen_test]
fn recall_index_lists_the_largest_results_in_order() {
    let mut msgs = vec![ChatMessage::system("sys"), ChatMessage::user("go")];
    // Twice the line cap, sizes growing with the index, plus one small
    // result and one exactly at the floor.
    let n = RECALL_INDEX_MAX_LINES * 2;
    for i in 1..=n {
        let id = format!("call_{i}");
        let mut call = assistant_call(&id, "read_file");
        call.tool_calls.as_mut().unwrap()[0].function.arguments =
            format!("{{\"path\":\"src/file_{i}.rs\"}}");
        msgs.push(call);
        msgs.push(ChatMessage::tool_result(
            &id,
            &"x".repeat(RECALL_INDEX_MIN_CHARS + i * 100),
        ));
    }
    msgs.push(assistant_call("call_small", "list_files"));
    msgs.push(ChatMessage::tool_result("call_small", "tiny"));
    msgs.push(assistant_call("call_floor", "Shell"));
    msgs.push(ChatMessage::tool_result("call_floor", &"y".repeat(RECALL_INDEX_MIN_CHARS)));

    let index = recall_index(&msgs).expect("large results qualify");
    let lines: Vec<&str> = index.lines().filter(|l| l.starts_with("- ")).collect();
    assert_eq!(lines.len(), RECALL_INDEX_MAX_LINES, "{index}");
    assert!(index.starts_with(RECALL_INDEX_HEADING), "{index}");
    // The smallest qualifying results lost the cut; the largest are all
    // there, in message order, each with its tool, arguments and size.
    assert!(!index.contains("call_small"), "below the floor: {index}");
    assert!(!index.contains("call_floor "), "the floor lost to bigger ones: {index}");
    for (k, line) in lines.iter().enumerate() {
        let i = n - RECALL_INDEX_MAX_LINES + k + 1;
        assert!(line.contains(&format!("- call_{i}  read_file(")), "line {k}: {line}");
        assert!(line.contains(&format!("src/file_{i}.rs")), "line {k}: {line}");
        assert!(line.ends_with("k chars"), "line {k}: {line}");
    }
}

#[wasm_bindgen_test]
fn recall_index_is_absent_when_nothing_is_worth_recalling() {
    let mut msgs = paging_history(); // results of ~300 chars
    assert!(recall_index(&msgs).is_none());
    // One big result alone makes an index, even with the floor exactly met
    // and no line cap pressure; its arguments head is clipped.
    let mut call = assistant_call("call_big", "Shell");
    call.tool_calls.as_mut().unwrap()[0].function.arguments =
        format!("{{\"command\":\"{}\"}}", "a\nb".repeat(100));
    msgs.push(call);
    msgs.push(ChatMessage::tool_result("call_big", &"z".repeat(RECALL_INDEX_MIN_CHARS)));
    let index = recall_index(&msgs).unwrap();
    let line = index.lines().last().unwrap();
    assert!(line.starts_with("- call_big  Shell("), "{line}");
    assert!(line.contains('…') && !line.contains('\n'), "clipped, one line: {line}");
    assert!(line.ends_with("1.5k chars"), "{line}");
}

#[wasm_bindgen_test]
fn recall_index_inherits_the_previous_summary_lines_into_spare_room() {
    // The span opens with the previous compaction's summary, whose index
    // names results that are archived and otherwise unreachable.
    let prior_lines: Vec<String> = (1..=RECALL_INDEX_MAX_LINES)
        .map(|i| format!("- old_{i}  read_file({{\"path\":\"old_{i}\"}})  9.{i}k chars"))
        .collect();
    let prior = format!(
        "{SUMMARY_MARKER}\nEarlier history archived (generation 1).\n\nnarrative\n\n\
         {RECALL_INDEX_HEADING}\nThe largest tool results of the summarized history; \
         recall_result(call_id=...) returns the full content.\n{}",
        prior_lines.join("\n")
    );
    let mut msgs = vec![ChatMessage::system("sys"), ChatMessage::user(&prior)];
    // Four new large results leave MAX-4 lines of room: the NEWEST
    // inherited lines fill it, ahead of the span's own, in order.
    for i in 1..=4 {
        let id = format!("new_{i}");
        msgs.push(assistant_call(&id, "Shell"));
        msgs.push(ChatMessage::tool_result(&id, &"n".repeat(RECALL_INDEX_MIN_CHARS + i)));
    }
    let index = recall_index(&msgs).unwrap();
    let lines: Vec<&str> = index.lines().filter(|l| l.starts_with("- ")).collect();
    assert_eq!(lines.len(), RECALL_INDEX_MAX_LINES, "{index}");
    assert!(lines[0].starts_with("- old_5 "), "oldest four dropped: {}", lines[0]);
    assert!(
        lines[RECALL_INDEX_MAX_LINES - 5].starts_with(&format!("- old_{RECALL_INDEX_MAX_LINES} ")),
        "{index}"
    );
    assert!(lines[RECALL_INDEX_MAX_LINES - 4].starts_with("- new_1 "), "{index}");
    assert!(lines[RECALL_INDEX_MAX_LINES - 1].starts_with("- new_4 "), "{index}");
    // A summary without an index contributes nothing — and a span with
    // neither has no index at all.
    let bare = vec![
        ChatMessage::system("sys"),
        ChatMessage::user(&format!("{SUMMARY_MARKER}\njust narrative")),
    ];
    assert!(recall_index(&bare).is_none());
}
