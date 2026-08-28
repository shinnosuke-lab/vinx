//! The forked agent-core engine, running in a browser tab.
//!
//! The `#[path]` modules below live in vendor/engine/ (a fork of agent-core;
//! see vendor/VENDOR.json) and are mounted at the crate root rather than under
//! an `engine::` module because they address each other as `crate::types`,
//! `crate::tool` and so on. Mounting them anywhere else would mean rewriting
//! every internal path for no gain. `os` keeps its upstream shape for the same
//! reason: its own files say `crate::os::OsPolicy`.
//!
//! What this crate adds around them is only what the browser cannot borrow from
//! a host: a clock, a session store, a skill source, and a set of `Tool`
//! implementations backed by `fetch` instead of a shell.

// ── the forked engine ──
//
// `needless_borrows_for_generic_args` is an artefact of the mechanical
// std::fs → crate::vfs rewrite in the fork's file tools; harmless, and not
// worth churning those files over.
#![allow(clippy::needless_borrows_for_generic_args)]

#[path = "../../../vendor/engine/agent_loop.rs"]
pub mod agent_loop;
#[path = "../../../vendor/engine/agent_task.rs"]
pub mod agent_task;
#[path = "../../../vendor/engine/client.rs"]
pub mod client;
#[path = "../../../vendor/engine/context.rs"]
pub mod context;
#[path = "../../../vendor/engine/event.rs"]
pub mod event;
#[path = "../../../vendor/engine/model_caps.rs"]
pub mod model_caps;
/// `#[path]` on a directory module also moves where its `mod fs;` and friends
/// are looked up, so `os/` is the one vendored piece that keeps its own tree.
#[path = "../../../vendor/engine/os/mod.rs"]
pub mod os;
#[path = "../../../vendor/engine/skill.rs"]
pub mod skill;
#[path = "../../../vendor/engine/sse.rs"]
pub mod sse;
#[path = "../../../vendor/engine/style_tool.rs"]
pub mod style_tool;
#[path = "../../../vendor/engine/tool.rs"]
pub mod tool;
#[path = "../../../vendor/engine/turn.rs"]
pub mod turn;
#[path = "../../../vendor/engine/types.rs"]
pub mod types;

/// Upstream's `web` host module, reduced to the two things the engine reaches
/// into it for by name. Answering under those paths is what lets the forked
/// copies compile unmodified; see vendor/VENDOR.json.
pub mod web {
    pub use crate::sse;

    /// The engine's `store` field is declared as
    /// `Option<Arc<crate::web::store::SqliteStore>>`, and it calls two methods
    /// on it: `archive_messages` before a compaction, `save_async` for a
    /// sub-agent transcript. Both are [`crate::store::SessionStore`]'s.
    pub mod store {
        #[cfg(feature = "sqlite")]
        pub use crate::store::SessionStore as SqliteStore;

        /// Without the `sqlite` feature there is no store, and the engine's
        /// `Option` is always `None` — but the type still has to exist, and its
        /// two methods still have to typecheck on a branch nothing takes. An
        /// uninhabited enum says exactly that: no value of this can be made, so
        /// each body is a match over no cases.
        #[cfg(not(feature = "sqlite"))]
        pub enum SqliteStore {}

        #[cfg(not(feature = "sqlite"))]
        impl SqliteStore {
            pub fn archive_messages(
                &self,
                _id: &str,
                _messages: &[crate::types::ChatMessage],
            ) -> Result<i64, std::convert::Infallible> {
                match *self {}
            }

            pub fn lookup_archived_tool_result(
                &self,
                _id: &str,
                _call_id: &str,
            ) -> Result<Option<(String, String)>, std::convert::Infallible> {
                match *self {}
            }

            pub fn save_async(
                &self,
                _id: &str,
                _messages: &[crate::types::ChatMessage],
                _origin: &str,
                _active_skill: Option<&crate::skill::ActiveSkill>,
            ) {
                match *self {}
            }
        }
    }
}

/// Upstream's `config`, reduced to the defaults the engine reads out of it.
///
/// The rest of that file is 617 lines of loading and saving a TOML the browser
/// does not have: configuration arrives here injected, through
/// [`host::AgentHost::configure`] and the page's own settings panel.
pub mod config {
    /// How long an `ask_user` waits for a human in an unattended session before
    /// auto-picking each question's default.
    pub fn default_ask_user_timeout_secs() -> u64 {
        60
    }

    /// A sub-agent's wall-clock budget: generous for real work, bounded so a
    /// wedged child cannot park a turn forever.
    pub fn default_subagent_timeout_secs() -> u64 {
        600
    }

    /// How many sub-agents of one batch run at a time; the rest queue.
    pub fn default_subagent_max_parallel() -> usize {
        4
    }
}

// ── the browser side ──
pub mod bridge;
pub mod answer;
pub mod files;
/// The theme half of upstream's `releases`, under its own name: the vendored
/// `set_chat_style` addresses it as `crate::releases` and so compiles unpatched.
pub mod releases;
pub mod runtime;
pub mod skills;
pub mod themes;
pub mod tools;
pub mod uploads;
pub mod vfs;

#[cfg(feature = "sqlite")]
pub mod host;
#[cfg(feature = "sqlite")]
pub mod session_tools;
#[cfg(feature = "sqlite")]
pub mod sql;
#[cfg(feature = "sqlite")]
pub mod storage;
#[cfg(feature = "sqlite")]
pub mod store;
#[cfg(feature = "sqlite")]
pub mod workspace;

#[cfg(feature = "size-probe")]
pub mod probe;
