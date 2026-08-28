//! Saying no, with the status the shim should say it in.
//!
//! Most of what the host does either works or is not the user's business, and
//! reports through `log`. A few calls are different: an upload over the size
//! cap, a skill package that is not one. The UI puts those messages in front of
//! the user verbatim and branches on the status, and the rules that produce
//! both live here rather than in the shim — a MIME table or a zip validator
//! kept in two languages is a table that will disagree with itself.

use serde::Serialize;

/// A refusal: what to tell the user, and what HTTP status it is.
#[derive(Debug)]
pub struct Refused {
    pub status: u16,
    pub message: String,
}

impl Refused {
    /// The request was malformed or the content was not what it claimed.
    pub fn bad(message: impl Into<String>) -> Self {
        Refused {
            status: 400,
            message: message.into(),
        }
    }

    /// Nothing here by that name.
    pub fn missing(message: impl Into<String>) -> Self {
        Refused {
            status: 404,
            message: message.into(),
        }
    }

    /// Well-formed, but it would displace something that may not be displaced.
    pub fn conflict(message: impl Into<String>) -> Self {
        Refused {
            status: 409,
            message: message.into(),
        }
    }

    /// Over a cap.
    pub fn too_large(message: impl Into<String>) -> Self {
        Refused {
            status: 413,
            message: message.into(),
        }
    }

    /// The workspace refused a write. Rare, and never the caller's fault.
    pub fn broken(message: impl Into<String>) -> Self {
        Refused {
            status: 500,
            message: message.into(),
        }
    }
}

/// Serialise an outcome for the RPC: `{ok: true, ...}` or
/// `{ok: false, status, error}`.
///
/// The payload is flattened into the success case rather than nested, so the
/// shim can hand it to the UI as the response body unchanged.
pub fn envelope<T: Serialize>(outcome: Result<T, Refused>) -> String {
    let value = match outcome {
        Ok(payload) => {
            let mut body = serde_json::to_value(payload).unwrap_or(serde_json::Value::Null);
            match body.as_object_mut() {
                Some(map) => {
                    map.insert("ok".into(), true.into());
                    body
                }
                // A payload that is not an object (a string, a list) cannot
                // carry the flag, so it rides one level down.
                None => serde_json::json!({ "ok": true, "value": body }),
            }
        }
        Err(refused) => serde_json::json!({
            "ok": false,
            "status": refused.status,
            "error": refused.message,
        }),
    };
    value.to_string()
}
