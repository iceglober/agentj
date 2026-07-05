//! Cumulative session token accounting.

use crate::provider::TokenUsage;

/// Cumulative session token accounting, split primary loop vs subagents. `*_in` sums the billed
/// prompt tokens of every model call (history is re-sent each call, so this is spend, not context
/// size); `*_cached` is the cache-hit subset of `*_in`, when the provider reports it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SessionTokens {
    pub primary_in: u64,
    pub primary_out: u64,
    pub primary_cached: u64,
    pub primary_calls: u64,
    pub sub_in: u64,
    pub sub_out: u64,
    pub sub_cached: u64,
    pub sub_calls: u64,
}

impl SessionTokens {
    pub fn add_primary(&mut self, u: &TokenUsage) {
        self.primary_in += u.prompt_tokens;
        self.primary_out += u.completion_tokens;
        self.primary_cached += u.cached_tokens.unwrap_or(0);
        self.primary_calls += 1;
    }
    pub fn add_sub(&mut self, u: &TokenUsage) {
        self.sub_in += u.prompt_tokens;
        self.sub_out += u.completion_tokens;
        self.sub_cached += u.cached_tokens.unwrap_or(0);
        self.sub_calls += 1;
    }
    pub fn total_in(&self) -> u64 {
        self.primary_in + self.sub_in
    }
    pub fn total_out(&self) -> u64 {
        self.primary_out + self.sub_out
    }
}
