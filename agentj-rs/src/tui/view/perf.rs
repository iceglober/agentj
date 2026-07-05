//! Test-only performance counters: event-batch drain sizes and input-layout cache hit/refresh
//! counts, asserted by the perf tests.

#[derive(Default, Debug, Clone, Copy, PartialEq, Eq)]
pub struct PerfMetrics {
    pub input_batches: u64,
    pub input_events_total: u64,
    pub input_batch_max: usize,
    pub ui_batches: u64,
    pub ui_events_total: u64,
    pub ui_batch_max: usize,
    pub input_layout_refreshes: u64,
    pub input_layout_cache_hits: u64,
}

pub fn note_batch(metrics: &mut PerfMetrics, len: usize, input: bool) {
    if input {
        metrics.input_batches += 1;
        metrics.input_events_total += len as u64;
        metrics.input_batch_max = metrics.input_batch_max.max(len);
    } else {
        metrics.ui_batches += 1;
        metrics.ui_events_total += len as u64;
        metrics.ui_batch_max = metrics.ui_batch_max.max(len);
    }
}
