# Control Tower Stage-By-Stage Refactor TODO

## Scope
Refactor each module under `src/control_tower` into folder-based stage architecture (like `scan_pipeline/` and `entry_dispatch/`), while preserving behavior.

---

## 1) `candidate_pipeline.mjs` → `candidate_pipeline/`
- [ ] Create `src/control_tower/candidate_pipeline/index.mjs`
- [ ] Stage: `stage_source_ingestion.mjs` (streaming + fallback source fetch)
- [ ] Stage: `stage_candidate_normalization.mjs` (shape/normalize token rows)
- [ ] Stage: `stage_source_gatekeeping.mjs` (cooldowns, quality, dedupe)
- [ ] Stage: `stage_pipeline_result.mjs` (return structure + counters updates)
- [ ] Back-compat shim in `src/control_tower/candidate_pipeline.mjs`

## 2) `diag_reporting.mjs` → `diag_reporting/`
- [ ] Create `src/control_tower/diag_reporting/index.mjs`
- [ ] Stage: `stage_diag_snapshot.mjs`
- [ ] Stage: `stage_perf_summary.mjs`
- [ ] Stage: `stage_confirm_metrics.mjs`
- [ ] Stage: `stage_watchlist_diagnostics.mjs`
- [ ] Stage: `stage_emitters.mjs` (telegram/log sinks)
- [ ] Back-compat shim in `src/control_tower/diag_reporting.mjs`

## 3) `entry_engine.mjs` → `entry_engine/`
- [ ] Create `src/control_tower/entry_engine/index.mjs`
- [ ] Stage: `stage_entry_preflight.mjs` (inputs/guardrails)
- [ ] Stage: `stage_quote_and_swap.mjs`
- [ ] Stage: `stage_entry_state_commit.mjs`
- [ ] Stage: `stage_exposure_queue.mjs`
- [ ] Back-compat shim in `src/control_tower/entry_engine.mjs`

## 4) `exit_engine.mjs` → `exit_engine/`
- [ ] Create `src/control_tower/exit_engine/index.mjs`
- [ ] Stage: `stage_price_selection.mjs`
- [ ] Stage: `stage_stop_trail_update.mjs`
- [ ] Stage: `stage_exit_decision.mjs`
- [ ] Stage: `stage_close_execution.mjs`
- [ ] Back-compat shim in `src/control_tower/exit_engine.mjs`

## 5) `operator_surfaces.mjs` → `operator_surfaces/`
- [ ] Create `src/control_tower/operator_surfaces/index.mjs`
- [ ] Stage: `stage_status_commands.mjs`
- [ ] Stage: `stage_positions_commands.mjs`
- [ ] Stage: `stage_config_filter_commands.mjs`
- [ ] Stage: `stage_diag_replay_commands.mjs`
- [ ] Back-compat shim in `src/control_tower/operator_surfaces.mjs`

## 6) `ops_reporting.mjs` → `ops_reporting/`
- [ ] Create `src/control_tower/ops_reporting/index.mjs`
- [ ] Stage: `stage_formatting.mjs`
- [ ] Stage: `stage_ops_reporting_factory.mjs`
- [ ] Stage: `stage_spend_summary_cache.mjs`
- [ ] Back-compat shim in `src/control_tower/ops_reporting.mjs`

## 7) `portfolio_control.mjs` → `portfolio_control/`
- [ ] Create `src/control_tower/portfolio_control/index.mjs`
- [ ] Stage: `stage_exposure_sync.mjs`
- [ ] Stage: `stage_equity_estimation.mjs`
- [ ] Stage: `stage_portfolio_stop_check.mjs`
- [ ] Stage: `stage_reconcile_positions.mjs`
- [ ] Back-compat shim in `src/control_tower/portfolio_control.mjs`

## 8) `position_policy.mjs` → `position_policy/`
- [ ] Create `src/control_tower/position_policy/index.mjs`
- [ ] Stage: `stage_capacity.mjs`
- [ ] Stage: `stage_token_display.mjs`
- [ ] Stage: `stage_exit_mark.mjs`
- [ ] Stage: `stage_momentum_defaults.mjs`
- [ ] Back-compat shim in `src/control_tower/position_policy.mjs`

## 9) `positions_loop.mjs` → `positions_loop/`
- [ ] Create `src/control_tower/positions_loop/index.mjs`
- [ ] Stage: `stage_loop_orchestrator.mjs`
- [ ] Stage: `stage_open_position_iteration.mjs`
- [ ] Stage: `stage_stop_eval_and_dispatch.mjs`
- [ ] Back-compat shim in `src/control_tower/positions_loop.mjs`

## 10) `route_control.mjs` → `route_control/`
- [ ] Create `src/control_tower/route_control/index.mjs`
- [ ] Stage: `stage_constants.mjs`
- [ ] Stage: `stage_backoff_utils.mjs`
- [ ] Stage: `stage_no_pair_state.mjs`
- [ ] Stage: `stage_force_attempt_policy.mjs`
- [ ] Stage: `stage_quote_failure_parse.mjs`
- [ ] Stage: `stage_route_quote_fallback.mjs`
- [ ] Stage: `stage_no_pair_classification.mjs`
- [ ] Stage: `stage_mode_and_holders_gate.mjs`
- [ ] Back-compat shim in `src/control_tower/route_control.mjs`

## 11) `runtime_timers.mjs` → `runtime_timers/`
- [ ] Create `src/control_tower/runtime_timers/index.mjs`
- [ ] Stage: `stage_positions_timer.mjs`
- [ ] Stage: `stage_watchlist_cleanup_timer.mjs`
- [ ] Stage: `stage_observability_heartbeat_timer.mjs`
- [ ] Back-compat shim in `src/control_tower/runtime_timers.mjs`

## 12) `watchlist_control.mjs` → `watchlist_control/`
- [ ] Create `src/control_tower/watchlist_control/index.mjs`
- [ ] Stage: `stage_watchlist_state.mjs`
- [ ] Stage: `stage_route_cache.mjs`
- [ ] Stage: `stage_hot_queue.mjs`
- [ ] Stage: `stage_age_and_evict.mjs`
- [ ] Stage: `stage_summary_and_counters.mjs`
- [ ] Back-compat shim in `src/control_tower/watchlist_control.mjs`

## 13) `watchlist_pipeline.mjs` → `watchlist_pipeline/`
- [ ] Create `src/control_tower/watchlist_pipeline/index.mjs`
- [ ] Stage: `stage_upsert_watchlist_mint.mjs`
- [ ] Stage: `stage_promote_route_available.mjs`
- [ ] Stage: `stage_runtime_delegate.mjs`
- [ ] Back-compat shim in `src/control_tower/watchlist_pipeline.mjs`

## 14) `watchlist_pipeline_runtime.mjs` → `watchlist_pipeline_runtime/`
- [ ] Create `src/control_tower/watchlist_pipeline_runtime/index.mjs`
- [ ] Stage: `stage_row_preflight.mjs`
- [ ] Stage: `stage_momentum_eval.mjs`
- [ ] Stage: `stage_confirm_continuation.mjs`
- [ ] Stage: `stage_attempt_policy_and_entry.mjs`
- [ ] Stage: `stage_post_attempt_outcomes.mjs`
- [ ] Back-compat shim in `src/control_tower/watchlist_pipeline_runtime.mjs`

## 15) Validation + cleanup
- [ ] Ensure all current import paths continue working (via shims or import updates)
- [ ] Remove dead code and duplicated helpers after extraction
- [ ] Run `npm test --silent` and verify 34/34, 139/139
- [ ] Commit with focused message(s)
