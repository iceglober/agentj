# agentj feature & test coverage matrix

Every distinct user-facing interaction, stated as behavior, mapped to the test(s) that pin it.
Suite: **245 unit tests + 5 PTY integration tests** (`cargo test`), clippy at zero warnings.
Updated: 2026-07-07, branch `research/long-horizon`.

Conventions: test names are `module::test_fn`. "PTY" = `tests/pty_input.rs` (real terminal,
real binary). Items in the final section are event-loop orchestration in `tui/mod.rs` that is
deliberately not unit-tested (see rationale there).

## Startup & configuration

| Interaction | Tests |
|---|---|
| Launching shows a one-line cheat sheet in the transcript | `app::startup_shows_the_cheat_sheet_and_first_run_opens_the_wizard` |
| MCP servers load at startup; any failed / needs-auth server auto-opens a status modal; all-green stays quiet | `app::mcp_modal_auto_opens_on_startup_failures_and_any_key_dismisses_it`, `view::mcp_modal_lists_server_statuses` |
| Any key dismisses the MCP modal and is swallowed (not typed) | `app::mcp_modal_auto_opens_on_startup_failures_and_any_key_dismisses_it` |
| First run with no configured provider opens the setup wizard automatically | `app::startup_shows_the_cheat_sheet_and_first_run_opens_the_wizard` |
| Config resolves env > provider block > config file > defaults; unknown keys rejected | `config::parse_defaults_and_invalid_values`, `config::file_values_fill_in_and_env_overrides_them`, `config::provider_blocks_fill_in_provider_specific_values`, `config::provider_blocks_override_top_level_file_values_but_not_env_or_cli`, `config::app_config_merge_is_layered`, `config::read_config_rejects_unknown_keys` |
| Context window comes from the model table (prefix match) unless `AGENTJ_CONTEXT_WINDOW` overrides | `config::context_window_prefix_lookup`, `config::context_window_env_overrides_model_table` |
| Compaction threshold tracks the window with an absolute fallback | `config::compact_threshold_tracks_the_window_with_an_absolute_fallback` |
| The project check command is detected (env > aj.json > heuristics) | `config::check_command_detection` |
| `AGENTJ_MANAGE` / `AGENTJ_EPIC_AUTOMERGE` seed the delegation toggles, default OFF | `config::epic_flags_default_off_and_seed_from_env` |
| `AGENTJ_ROLE=engineer` forces `manage` off — engineers can never spawn engineers | `config::epic_flags_default_off_and_seed_from_env` (role-guard assert) |
| AGENTS.md is embedded in every prompt when present; skipped cleanly when absent | `prompt::agents_md_is_embedded_when_present_and_skipped_when_not` |
| `.claude/skills` are indexed into the prompt | `prompt::skills_are_indexed_from_claude_skills_when_present` |
| Provider selection / preflight names what's missing | `model::provider_resolution`, `model::preflight_messages`, `model::ref_classification` |

## Typing & editing the input line

| Interaction | Tests |
|---|---|
| Printable keys insert (incl. shift-uppercase fallback on plain PTYs) | `keymap::base_key_shift_reports_uppercase`, `editor::insert_backspace_and_midline_insert`, PTY `shifted_printable_input_round_trips_through_pty` |
| Backspace/Delete; ⌥⌫/⌥⌦ word deletes; ⌘⌫/Ctrl-U to line start; ⌘⌦/Ctrl-K to line end | `keymap::destructive_editing_shortcuts_apply_through_actions`, `keymap::cmd_delete_and_backspace_delete_to_line_edges`, `keymap::option_delete_and_backspace_delete_words_without_crossing_lines`, `editor::delete_to_line_home_stops_at_the_line_start`, PTY `ctrl_backspace_byte_deletes_a_word_through_pty`, PTY `repeated_word_deletes_apply_before_submit_through_pty` |
| Readline chords (Ctrl-A/E/H/U/K/W) edit the line | `keymap::readline_chords_edit_the_line` |
| Arrow/word/Home/End motion; ⌥b/⌥f aliases; multi-line ↑↓ move the cursor, single-line ↑↓ scroll | `editor::word_and_buffer_motions_work`, `editor::arrows_move_the_cursor_across_lines`, `keymap::alt_word_aliases_match_alt_arrow_word_motion`, `keymap::plain_up_down_scrolls_single_line_but_moves_cursor_in_multiline` |
| Shift/Alt/Ctrl-Enter or Ctrl-J insert a newline; plain Enter submits trimmed text | `keymap::keystroke_sequence_distinguishes_submit_from_multiline_newline_chords`, `keymap::submit_binding_trims_input`, PTY `enter_submits_from_pty_in_interactive_mode` |
| Bracketed paste inserts at the cursor; ignored while a turn runs | `app::bracketed_paste_inserts_idle_and_is_ignored_while_a_turn_runs` |
| Esc (idle) clears the input | `keymap::keymap_table_covers_all_supported_non_submit_bindings` |
| Input wraps char-exact; cursor tracked across wraps/blank lines; tall input scrolls to the cursor; layout cached per revision | `view::wrapped_input_rows_and_cursor_are_tracked`, `view::blank_lines_render_and_typing_after_them_lands_on_the_right_row`, `view::cursor_stays_on_its_row_at_an_exact_wrap_boundary`, `view::tall_input_scrolls_to_keep_the_cursor_visible`, `view::input_layout_cache_skips_unchanged_refreshes`, `editor::long_edit_script_preserves_expected_text_and_cursor`, PTY `long_burst_input_survives_pty_round_trip` |
| While a turn runs the input is read-only; unsupported keys are suppressed | `keymap::running_turn_suppresses_unsupported_keys`, `keymap::keymap_table_covers_all_supported_non_submit_bindings` |
| Keyboard enhancement flags request shifted-key reporting (capitals work on kitty-protocol terminals) | `keymap::keyboard_flags_include_alternate_keys_for_shifted_input`, `keymap::keyboard_flags_request_only_needed_progressive_reporting` |

## Slash commands & completion popover

| Interaction | Tests |
|---|---|
| Typing a `/` token opens the popover, fuzzy-filtered, mid-input but never mid-word | `app::slash_popover_opens_filters_and_accepts`, `app::slash_popover_works_mid_input_but_not_mid_word`, `commands::fuzzy_scoring_orders_and_filters` |
| ↑↓ select; Tab/Enter accept (arg commands get a trailing space); accepting a no-arg command lets the next Enter submit | `app::slash_popover_arrows_select_and_esc_dismisses_until_token_changes`, `app::accepting_a_no_arg_command_lets_the_next_enter_submit` |
| Esc dismisses the popover (not the input) and it stays closed until the token changes | `app::slash_popover_arrows_select_and_esc_dismisses_until_token_changes` |
| The popover floats above the status row | `view::frame_shows_the_slash_popover_above_the_status_row` |
| The command token highlights as exact / prefix / unknown | `commands::classify_highlights` |
| Sending plain text starts a turn (message committed, spinner runs, effect flashes) | `app::submit_plain_text_starts_a_turn` |
| An unknown `/word` is sent to the model as a plain prompt (intentional — highlight is the only warning) | `app::unknown_slash_text_is_sent_to_the_model_as_a_plain_prompt` |
| Empty Enter when idle does nothing | `app::empty_enter_when_idle_does_nothing` |
| Empty Enter at the step gate continues the turn with history intact | `app::step_gate_offers_empty_enter_continue` |
| `/exit` and `/quit` quit | `app::exit_command_quits` |
| `/model` shows usage + the current provider/model; `/model <provider> [model]` switches; unknown provider explains | `app::slash_model_shows_usage_switches_and_rejects_an_unknown_provider` |
| `/mcp` reopens the status modal (or explains none are configured); `login`/`logout <name>` dispatch | `app::slash_mcp_dispatches_login_logout_and_reopens_the_status_modal` |
| `/setup` opens the provider wizard | `app::slash_setup_opens_the_wizard_and_esc_cancels_back_to_chat` |
| `/init` and `/knowledge` start their directive turns | `app::init_and_knowledge_commands_dispatch_their_effects` |
| `/task <ref>` re-keys onto a PR#/branch; `/task <verb + prose>` treats it as a freeform task and slugs a branch (the verb is never eaten) | `app::slash_task_reads_a_branch_ref_or_a_freeform_task`, `app::bare_task_reference_synthesizes_a_directive_so_work_starts` |
| `/task` refuses the primary checkout (destructive reset) unless `AGENTJ_ALLOW_PRIMARY=1` | covered inside `app::slash_task_*` guard path / `rekey::ref_classification` |
| `/epic <task>` arms Advanced delegation and starts a managing turn; bare `/epic` prints usage | `app::slash_epic_arms_management_delegation_and_requires_a_task` |

## Turn lifecycle & transcript

| Interaction | Tests |
|---|---|
| Assistant replies render as markdown blocks (headings, emphasis, code, lists, quotes) | `markdown::headings_and_paragraphs`, `markdown::inline_emphasis_and_code`, `markdown::fenced_code_is_verbatim_and_indented`, `markdown::nested_list_markers_and_ordering`, `markdown::blockquote_prefixed`, `markdown::plain_text_survives`, `view::assistant_block_keeps_paragraph_separators_truly_empty` |
| Your prompts and agentj's replies render as tinted "cards" with a colored left bar; tool calls and steering render plainly between; Focus (Ctrl-P) hides the machinery | `view::cards_tint_messages_leave_the_machinery_plain_and_focus_hides_it` |
| Each transcript block is labeled by type (you/agentj/tool/steering/note/thinking) once on its first row | `view::each_transcript_block_is_labeled_once_by_type` |
| The model's reasoning (when the provider returns it) shows as a labeled `thinking` block; parsed from `reasoning_content`/`reasoning`, absent otherwise | `view::model_reasoning_renders_as_a_labeled_thinking_block`, `provider::reasoning_content_is_parsed_from_either_key_and_absent_when_missing` |
| Each tool call ends as a `✓/✗ name(args) · elapsed` line; same-response batches are marked `+` | `view::tool_end_glyph_reflects_success_and_batching` |
| Supervisor nudges render dim and the Show-steering toggle collapses/restores them retroactively (the model always gets them) | `app::steering_toggle_collapses_and_restores_supervisor_notes_retroactively`, `app::ctrl_p_toggles_the_menu_and_enter_toggles_steering` |
| Hitting the step budget shows the gate line; the supervisor nudges convergence beforehand | `app::step_gate_offers_empty_enter_continue`, `agent::step_budget_nudges_convergence_and_the_gate_fires_at_the_cap` |
| A model error prints `✗ …` and ends the turn; a directive turn that errored skips the knowledge snapshot | `app::model_error_emits_error_event_and_ends_turn`, `app::command_turns_snapshot_on_clean_completion_only` |
| Esc interrupts the turn: `[interrupted]`, the turn's background jobs are killed by watermark, and an orientation note is deferred behind queued history deltas | `app::abort_defers_interrupt_marker_behind_queued_deltas`, `jobs::kill_after_spares_jobs_below_the_watermark` |
| Ctrl-C once clears input + warns; twice within the window quits | `app::double_ctrl_c_quits_within_window` |
| Committed history keeps tool-call/reply pairing across deltas | `agent::commit_deltas_preserve_toolcall_reply_pairing` |
| Token usage accrues per model call, split primary vs subagents; the menu shows the breakdown | `agent::usage_event_emitted_per_model_call`, `app::session_tokens_accumulate_primary_and_subagent_spend_separately`, `view::menu_modal_shows_the_session_token_breakdown`, `provider::usage_deserializes_with_cached_details`, `provider::usage_without_details_or_absent` |
| The status row degrades by priority as the terminal narrows | `view::right_status_drops_by_priority_as_width_shrinks` |
| The whole frame composes: transcript + markdown + status meter + panels | `view::frame_composes_markdown_status_meter_and_subagent_panel` |
| Raw tabs/control chars never reach the terminal | `view::sanitize_expands_tabs_and_drops_control_chars`, `view::pushed_lines_are_sanitized_so_raw_tabs_never_reach_the_terminal` |

## Scrolling, selection & mouse

| Interaction | Tests |
|---|---|
| Wheel / Ctrl-↑↓ / PageUp/Dn scroll; scrolling up breaks follow; paging to the bottom restores it and the badge clears | `app::mouse_wheel_scrolls_transcript`, `view::scrolled_up_badge_shows_and_paging_to_the_bottom_restores_follow`, `view::max_scroll_counts_wrapped_transcript_rows`, `view::window_slices_the_transcript_without_cloning_all_of_it` |
| Auto-scroll toggle re-pins to the tail on new activity | `app::auto_scroll_toggle_repins_on_new_activity` |
| Click-drag selects any on-screen cells (modals included); release copies via OSC 52; drag past the edge auto-scrolls | `app::screen_selection_snapshots_and_copies_any_content_incl_a_modal`, `app::selected_screen_text_reads_the_rendered_rows_across_lines`, `app::autoscroll_selection_scrolls_and_keeps_the_anchor_on_its_text`, `tui::base64_matches_known_vectors` (OSC 52 payload) |
| A click without a drag clears the highlight | `app::a_click_without_a_drag_clears_the_selection` |

## Ctrl-P menu

| Interaction | Tests |
|---|---|
| Ctrl-P toggles the menu (works mid-turn); ↑↓ move; Enter accepts; Esc closes; other keys are swallowed | `app::ctrl_p_toggles_the_menu_and_enter_toggles_steering` |
| Show steering ON/OFF (display-only) | `app::steering_toggle_collapses_and_restores_supervisor_notes_retroactively` |
| Auto-scroll ON/OFF | `app::auto_scroll_toggle_repins_on_new_activity` |
| Focus ON/OFF (hide tool calls + steering + thinking, retroactively) | `view::cards_tint_messages_leave_the_machinery_plain_and_focus_hides_it` |
| Show thinking ON/OFF (hide/restore the model's reasoning blocks, retroactively) | `app::show_thinking_toggle_hides_and_restores_reasoning_blocks` |
| Export transcript → a labeled markdown file in the working dir | `app::export_transcript_writes_a_labeled_markdown_file` |
| Advanced delegation ON/OFF and Auto-merge engineer PRs ON/OFF flip state, notice "next turn", and rebuild the session config | `app::epic_toggles_flip_state_and_ask_for_a_session_rebuild`, `view::menu_modal_renders_the_delegation_toggles_with_their_state` |
| MCP-servers item opens the status modal (or notices when none); Provider-setup item opens the wizard | `app::menu_mcp_and_setup_items_dispatch_their_screens` |

## Provider setup wizard

| Interaction | Tests |
|---|---|
| The wizard collects provider → base URL → key (masked) → model and emits the configure effect | `app::setup_wizard_collects_details_then_emits_configure` |
| Wizard input is answers, never chat or commands | `app::wizard_submit_is_not_treated_as_a_turn_or_command` |
| Esc cancels the wizard back to normal chat | `app::slash_setup_opens_the_wizard_and_esc_cancels_back_to_chat` |
| The form renders as a centered modal with a live cursor | `view::setup_modal_renders_the_form_over_the_transcript` |

## `/task` re-key

| Interaction | Tests |
|---|---|
| While the git work runs off-loop the UI shows a busy re-keying state (no freeze) | `app::rekey_result_failure_notices_and_success_resets_history_then_starts_the_task` |
| A failed re-key surfaces its steps + error and starts nothing | same |
| A successful re-key resets history to a fresh system+task pair and spawns the turn; a bare ref just switches | same |
| PR#/branch/URL references classify correctly | `rekey::ref_classification` |

## Agent core (model loop, supervisor, delegation)

| Interaction | Tests |
|---|---|
| The turn loop drains events; transient provider errors retry with backoff; client errors don't; retries exhaust | `provider::retries_transient_errors_then_succeeds`, `provider::does_not_retry_client_errors`, `provider::gives_up_after_the_backoff_schedule`, `provider::error_hint_picks_the_error_line_over_the_node_footer` |
| Context compaction elides old tool bodies near the window, never an unseen result, idempotently; holds during read-only exploration but fires near the window regardless | `agent::compaction_*` (4 tests), `agent::estimate_prompt_tokens_scales_with_content` |
| The SPEAR nudge fires once after sustained direct execution; skipped for short/delegating turns | `agent::spear_nudge_fires_once_after_sustained_direct_execution`, `agent::spear_nudge_skipped_when_the_turn_delegates_or_stays_short` |
| The ASSESS gate demands verification for unverified edits, once; satisfied by real verification; a failed web_check doesn't clear it | `agent::assess_gate_nudges_unverified_edits_once_then_lets_go`, `agent::assess_gate_stays_quiet_when_the_agent_already_verified`, `agent::a_failed_web_check_does_not_clear_the_assess_gate` |
| The RESOLVE/ship gates flag uncommitted or partially-staged edits at finish | `agent::ship_gate_flags_edits_that_were_never_committed`, `agent::resolve_gate_flags_a_partial_commit` |
| The greenfield gate structurally BLOCKS the first file write into an empty repo (no manifest/src dir) unless the agent explored first — forcing Scope+Plan before scaffolding; one-shot with a retry escape hatch; never fires in an existing project | `agent::greenfield_gate_blocks_the_first_scaffold_write_until_the_agent_explores`, `agent::greenfield_gate_is_silent_once_the_agent_has_explored` |
| A surviving task frontier (`.aj/task/plan.md`) is injected on the first turn only | `agent::a_surviving_frontier_is_injected_on_the_first_turn_only` |
| When an autonomous turn goes idle with framed work unfinished, a fresh-context continuation judge decides CONTINUE/STOP and extends the turn (bounded, fail-safe) instead of stopping to "ask permission"; off by config or for trivial turns | `agent::continuation_judge_extends_an_idle_manager_then_lets_it_stop`, `agent::continuation_judge_stays_off_when_disabled_and_when_the_turn_never_left_scope`, `continuation::parse_verdict_reads_the_leading_word_and_fails_safe`, `continuation::capture_scope_keeps_the_task_and_the_latest_framing`, `continuation::recent_tail_takes_the_last_n_and_caps_tool_bodies`, `config::continuation_judge_defaults_on_and_only_an_explicit_off_disables_it` |
| The SAME judge gates the step-budget exit: a turn that exhausts its steps still working gets its budget extended on KEEP_GOING (bounded) rather than hard-stopping at the step gate; STOP ends it normally | `agent::continuation_judge_extends_the_step_budget_instead_of_hard_stopping`, `agent::step_budget_nudges_convergence_and_the_gate_fires_at_the_cap` |
| `delegate` fans out subagents with structured lifecycle events; titles label the tray; failures and panics surface as failed ends | `agent::delegate_emits_structured_lifecycle_events`, `agent::delegate_title_becomes_the_tray_label`, `agent::delegate_reports_failure_when_a_subagent_returns_an_error_result`, `agent::panicked_subagent_surfaces_as_failed_end` |
| Subagents get the same context/project docs, their own prompt, no re-delegation, and their token spend rides the end summary | `agent::subagents_get_the_same_context_and_project_docs`, `prompt::prompt_frames_spear_as_a_heuristic_with_a_decidable_delegate_test`, `agent::subagent_token_spend_rides_the_end_summary` |
| Tool schemas: `delegate` only for the primary; `engineer_start` additionally needs the toggle; descriptions slimmed; big MCP catalogs go lazy behind `mcp_find_tools` | `tools::delegate_and_engineer_specs_are_gated_by_role`, `tools::slimming_caps_descriptions_and_strips_schema_bloat`, `tools::small_catalogs_stay_eager_big_ones_go_lazy`, `tools::find_activates_matches_and_their_schemas_advertise` |
| Typed subagents: each `delegate` task's `type` (scout/planner/reviewer/oracle/executor) selects a specialized SPEAR identity + a scoped tool allowlist (read-only types can't write, enforced at advertisement AND dispatch); default executor keeps full-tools behavior | `agent_type::parse_defaults_to_executor_and_reads_known_types`, `agent_type::read_only_types_are_denied_writes_the_executor_is_not`, `tools::a_scout_scoped_tool_set_refuses_writes_at_dispatch`, `prompt::subagents_get_the_same_context_and_project_docs` |

## Tools (what the model can do)

| Interaction | Tests |
|---|---|
| `read_file` reads with line numbers; missing file/arg errors are structured | `tools::reading_an_existing_file_is_ok`, `tools::reading_a_missing_file_reports_not_ok`, `tools::missing_required_arg_reports_not_ok`, `tools::unknown_tool_reports_not_ok` |
| `write_file` under `.aj/` self-gitignores | `tools::writes_under_aj_create_a_self_ignoring_gitignore` |
| `edit_file`: unique-match replace, `replace_all`, nearest-match echo on miss, batched edits apply atomically in order and echo regions | `tools::edit_file_not_found_echoes_the_nearest_match`, `tools::edit_file_not_unique_suggests_replace_all`, `tools::edit_file_replace_all_replaces_every_occurrence`, `tools::batched_edits_apply_in_order_atomically_and_echo_regions` |
| `edit_lines` replaces a range and rejects a drifted anchor; all edits fail stale if the file changed since the last read | `tools::edit_lines_replaces_a_range_and_rejects_a_drifted_anchor`, `tools::edits_fail_stale_when_the_file_changed_since_the_last_read` |
| `list_dir` lists entries; missing path errors | `tools::list_dir_lists_entries_and_a_missing_path_errors` |
| `glob` matches patterns and reports no-hits plainly | `tools::glob_matches_patterns_and_reports_no_hits` |
| `grep` searches the repo (empty path = whole repo); invalid regex is a failure, not "no matches" | `tools::grep_empty_path_searches_the_repo`, `tools::grep_invalid_regex_reports_failure` |
| `bash` honors `timeout_s`; long output keeps head+tail under the cap | `tools::bash_honors_timeout_s`, `tools::cap_result_keeps_head_and_tail_under_the_cap` |
| Background jobs: start returns immediately; finish/timeout nudge the loop with the output tail; check/stop/kill-watermark/kill-all; output snapshot for the UI | `jobs::finish_nudge_carries_output_and_exit`, `jobs::timeout_nudge_fires_for_a_slow_job`, `jobs::kill_after_spares_jobs_below_the_watermark`, `jobs::output_snapshot_reports_liveness_and_the_tail`, `jobs::trim_to_cap_*` |
| `web_check` verifies a served page and reports console errors as failures | `webcheck::summarize_reports_a_clean_page_as_ok`, `webcheck::summarize_flags_console_errors_as_not_ok`, `webcheck::first_line_trims_caps_and_skips_blank_lines` |
| File tools are confined to the repo root (`safe_resolve`) | exercised throughout `tools::*` (temp-rooted harness) |

## Epic orchestration (Advanced delegation)

| Interaction | Tests |
|---|---|
| The doctrine ships in every prompt, self-gated on `engineer_start`; never to subagents; the escalation test is "one PR → do it yourself" | `prompt::epic_doctrine_ships_self_gated_and_only_to_the_primary` |
| The ledger's markdown-table shape is a contract between the doctrine and the TUI parser | same (column-string assert) + `epic::parses_title_rows_and_mapped_columns` |
| `engineer_start` spawns a child `agentj --once` in a disposable worktree on the right branch; the brief survives hostile quoting and is seeded to the engineer's frontier (re-briefs append) | `engineers::engineer_command_quotes_a_hostile_brief_and_carries_the_branch`, `engineers::seed_frontier_writes_then_appends_a_rebrief`, `worktree::shell_quote_round_trips_through_bash` |
| A full wave refuses more engineers with a wait-for-nudge error | `tools::engineer_start_refuses_when_the_wave_is_full` |
| Worktrees: new branch created from base; existing branch re-entered (restart = resume); git errors verbatim; slugs are filesystem-safe | `worktree::ensure_creates_a_new_branch_and_reenters_it_on_restart`, `worktree::ensure_checks_out_an_existing_branch_instead_of_recreating_it`, `worktree::ensure_surfaces_git_errors_verbatim`, `worktree::slugify_is_filesystem_safe` |
| The epic ledger is injected on the manager's first turn only, only for managing sessions | `agent::an_epic_ledger_is_injected_only_for_managing_sessions` |
| With auto-merge OFF the finishing gate reminds (once) to mark ready-for-review, never merge; ON stays silent | `agent::epic_merge_gate_fires_once_and_only_without_automerge` |

## The live view (work panels, DAG, Tab-cycled panes)

| Interaction | Tests |
|---|---|
| Ledger parsing: header-mapped columns in any order, unknown columns ignored, non-ledger tables skipped, no-table tolerated, pipe-lines without a separator rejected, loads from `.aj/epic/plan.md` | `epic::parses_title_rows_and_mapped_columns`, `epic::column_order_does_not_matter_and_unknown_columns_are_ignored`, `epic::skips_non_ledger_tables_and_survives_no_table_at_all`, `epic::a_pipe_line_without_a_separator_is_not_a_table`, `epic::load_reads_from_the_aj_dir_and_none_when_absent` |
| The `deps` column parses into DAG edges; wave = topological depth; a dependency cycle can't diverge (capped) | `epic::parses_title_rows_and_mapped_columns` (deps assert), `epic::waves_are_topological_depth_and_a_cycle_cannot_diverge` |
| The epic panel renders the ledger AS a dependency DAG — rails fork to dependents and merge from deps (git-graph style), each node carrying its status/PR/note inline; plus the title, `m of n done · k blocked`, and manager activity line; hidden with no ledger | `view::epic_work_panel_renders_the_ledger_with_the_manager_selected`, `view::dag_panel_draws_forks_merges_and_inline_detail`, `dag::a_linear_chain_stacks_in_one_lane`, `dag::a_fork_and_join_draw_branch_and_merge_glyphs`, `dag::independent_roots_get_their_own_lanes` |
| Tab pages manager → each live engineer → manager; the `▸` marker rides the DAG node (matched by branch) or the manager line; a viewed engineer that exits clamps back to the manager | `app::tab_cycles_manager_and_live_engineers_and_clamps_on_exit`, `view::tab_selected_engineer_fills_the_pane_and_marks_its_ledger_row`, `keymap::keymap_table_covers_all_supported_non_submit_bindings` (Tab→CycleView while running) |
| Idle Tab completes first; cycles only when there is nothing to complete | `app::idle_tab_completes_first_and_cycles_views_only_with_nothing_to_complete` |
| The engineer pane fills the main pane with the job's live output tail, a branch/job/elapsed header, and a read-only note; typing still talks to the manager | `view::tab_selected_engineer_fills_the_pane_and_marks_its_ledger_row`, `jobs::output_snapshot_reports_liveness_and_the_tail` |
| Engineer jobs are labeled by their `AGENTJ_BRANCH` marker and hidden from the generic jobs tray while the panel shows them | `app::tab_cycles_manager_and_live_engineers_and_clamps_on_exit`, `view::epic_work_panel_renders_the_ledger_with_the_manager_selected` |

## The task work panel (SPEAR spine) & delegation badge

| Interaction | Tests |
|---|---|
| The supervisor infers the turn's SPEAR phase from its tool traffic (edits → EXECUTE, a passing check → ASSESS, a commit → RESOLVE, fresh unverified edits regress) and emits it on change | `agent::spear_phase_tracks_the_turns_tool_traffic` |
| A turn seeds the spine at SCOPE; phase events advance it; it persists after the turn so a finished task's spine stays readable | `app::a_turn_resets_the_spear_phase_and_phase_events_advance_it` |
| Every running non-epic turn shows the `S─P─E─A─R` spine (done/current/future colored) with the current phase name and live activity; hidden before the first turn | `view::spear_spine_shows_for_a_running_task_and_adv_badge_when_armed` |
| An epic replaces the task spine — the two top panels are mutually exclusive | `view::the_epic_panel_replaces_the_task_spine` |
| An `adv` badge stands in the status row while Advanced delegation is armed (highest priority — kept as ctx/elapsed drop) | `view::spear_spine_shows_for_a_running_task_and_adv_badge_when_armed` |

## Subagent tray & jobs panel

| Interaction | Tests |
|---|---|
| Live delegate rows hang off a fork/join rail; the fan closes correctly; finished agents pin ✓/✗; titles win the width fight | `view::rail_connectors_draw_a_closed_fan`, `view::rail_rows_carry_the_fan_and_pin_finished_agents`, `view::tray_gives_the_title_full_width_before_the_status`, `view::clip_adds_ellipsis_only_when_truncating`, `view::fmt_mmss_ticks_seconds` |
| When the wave joins, the tray collapses into permanent transcript summaries | `app::tray_collapses_into_transcript_summaries_when_the_delegate_batch_lands`, `view::cells_to_line_coalesces_same_style_runs`, `app::strip_tok_suffix_removes_only_a_real_spend_suffix` |
| Running background jobs list with id/command/elapsed/timeout, capped with overflow | `view::jobs_panel_lists_running_jobs_with_elapsed_and_timeout` |

## Persistent sessions (resume)

| Interaction | Tests |
|---|---|
| Each interactive run has a UUID session with named artifacts in a global store (`~/.config/aj/sessions/`), never in the repo; mint / load / most-recent-for-worktree; artifact save/read round-trip; names sanitized to one safe segment | `session::mint_load_and_artifacts_round_trip`, `session::most_recent_for_matches_the_worktree_and_picks_the_latest`, `session::artifact_names_are_sanitized_to_one_safe_segment` |
| The model persists its plan via `save_artifact`/`read_artifact` (gated on a session store + the primary loop); no session → the tools refuse rather than write anywhere | `agent::artifact_specs_require_a_session_and_the_primary_loop`, `tools::artifact_tools_error_without_a_session_store` |
| The frontier resumes from the session's `plan` artifact (fresh session inherits nothing); engineers/headless still read the in-worktree `.aj/task/plan.md` | `agent::interactive_frontier_comes_from_the_session_plan_artifact_not_the_repo`, `agent::a_surviving_frontier_is_injected_on_the_first_turn_only` |
| The doctrine routes the frontier to the `plan` artifact when `save_artifact` is available, else `.aj/task/plan.md` | `prompt::prompt_frames_spear_as_a_heuristic_with_a_decidable_delegate_test` (asserts both paths named) |

## `/init` & `/knowledge`

| Interaction | Tests |
|---|---|
| `/init` writes boilerplate config once and starts the mapping turn; `/knowledge` diffs the tree against the manifest and directs only the changes | `app::init_and_knowledge_commands_dispatch_their_effects`, `knowledge::boilerplate_config_is_created_once_and_parses`, `knowledge::diff_detects_adds_mods_and_removals`, `knowledge::snapshot_and_diff_roundtrip_in_a_real_repo`, `knowledge::knowledge_directive_lists_buckets_and_caps`, `knowledge::fnv_is_stable` |
| The knowledge snapshot is stamped only after a clean directive turn | `app::command_turns_snapshot_on_clean_completion_only` |

## MCP

| Interaction | Tests |
|---|---|
| `.mcp.json` merges repo + global; local entries override; disabled lists work at both levels; transport detected | `mcp::repo_wins_and_detects_transport`, `mcp::local_overrides_the_shared_repo_entry`, `mcp::global_disabled_servers_beat_a_repo_entry`, `mcp::disabled_in_local_turns_a_shared_server_off` |
| Static auth headers only when configured and not stdio | `mcp::no_static_auth_when_empty_or_stdio` |
| OAuth login: local callback captures code+state; token cache is per-URL | `oauth::callback_listener_extracts_code_and_state`, `oauth::cache_path_is_stable_and_per_url`, `oauth::urldecode_handles_percent_and_plus` |

## Deliberately not unit-tested (event-loop orchestration, `tui/mod.rs`)

These are thin `await` glue whose pieces are all tested above; a PTY test would need a live
model or races the loop (a prior menu-only PTY test hung the suite — see git history):

- The ticker refreshing the jobs snapshot / epic ledger (mtime-gated) / viewed-engineer tail — calls `running_snapshot`, `epic::ledger_mtime/load`, `output_snapshot`, all unit-tested.
- Autonomous continuation: an idle loop waking a turn when a job nudge is queued (`jobs::has_nudges` tested; the wake is three lines).
- Applying `RebuildSession` / `SwitchModel` / `ConfigureProvider` (session swap; resolution + preflight unit-tested).
- `McpAuthDone` → reconnect → tool swap.
- `--once` headless mode end-to-end (needs a live model; the same `run_turn` is covered by `agent::*` with scripted LLMs).
