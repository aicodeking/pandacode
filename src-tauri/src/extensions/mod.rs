//! Bounded extension packages, host-owned presentation and explicitly trusted native execution.
pub mod contracts;
pub mod packages;
pub mod windows;
pub mod rich_views;
pub mod context;
mod inventory;
mod project_reads;
pub mod runtime;
pub mod jobs;
pub mod connections;
pub mod services;
pub mod runtime_grants;
pub mod providers;
pub(crate) mod placement;
pub(crate) mod supervisor;
