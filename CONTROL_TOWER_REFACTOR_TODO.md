# Control Tower Stage-By-Stage Refactor TODO

## Scope
Refactor each module under `src/control_tower` into folder-based stage architecture (like `scan_pipeline/` and `entry_dispatch/`), while preserving behavior.

---

## 1) `candidate_pipeline.mjs` → `candidate_pipeline/`
- [x] Create `src/control_tower/candidate_pipeline/index.mjs`
- [x] Stage: `stage_source_discovery.mjs` (BirdEye + DexScreener + stream merge)
- [x] Stage: `stage_jup_expansion.mjs` (BirdEye-seeded Jupiter expansion)
- [x] Stage: `stage_finalize_candidates.mjs` (dedupe + preview)
- [x] Back-compat shim in `src/control_tower/candidate_pipeline.mjs`

## 2) `diag_reporting.mjs` → `diag_reporting/`
- [x] Create `src/control_tower/diag_reporting/index.mjs`
- [x] Stage: `stage_diag_snapshot.mjs` (refreshDiagSnapshot + helper formatters)
- [x] Stage: `stage_get_diag_message.mjs` (getDiagSnapshotMessage)
- [x] Stage: `stage_maybe_refresh.mjs` (maybeRefreshDiagSnapshot)
- [x] Back-compat shim in `src/control_tower/diag_reporting.mjs`

## 3) `entry_engine.mjs` → `entry_engine/`
- [x] Create `src/control_tower/entry_engine/index.mjs`
- [x] Stage: `stage_open_position.mjs`
- [x] Stage: `stage_exposure_queue.mjs`
- [x] Back-compat shim in `src/control_tower/entry_engine.mjs`

## 4) `exit_engine.mjs` → `exit_engine/`
- [x] Create `src/control_tower/exit_engine/index.mjs`
- [x] Stage: `stage_hard_stop_policy.mjs`
- [x] Stage: `stage_close_position.mjs`
- [x] Stage: `stage_update_stops.mjs`
- [x] Back-compat shim in `src/control_tower/exit_engine.mjs`

## 5) `operator_surfaces.mjs` → `operator_surfaces/`
- [x] Create `src/control_tower/operator_surfaces/index.mjs`
- [x] Stage: `stage_status_commands.mjs`
- [x] Stage: `stage_positions_commands.mjs`
- [x] Stage: `stage_config_filter_commands.mjs`
- [x] Stage: `stage_diag_replay_commands.mjs`
- [x] Back-compat shim in `src/control_tower/operator_surfaces.mjs`

## 6) `ops_reporting.mjs` → `ops_reporting/`
- [x] Create `src/control_tower/ops_reporting/index.mjs`
- [x] Stage: `stage_formatting.mjs`
- [x] Stage: `stage_ops_reporting_factory.mjs`
- [x] Stage: `stage_spend_summary_cache.mjs`
- [x] Back-compat shim in `src/control_tower/ops_reporting.mjs`

## 7) `portfolio_control.mjs` → `portfolio_control/`
- [x] Create `src/control_tower/portfolio_control/index.mjs`
- [x] Stage: `stage_exposure_sync.mjs`
- [x] Stage: `stage_equity_estimation.mjs`
- [x] Stage: `stage_portfolio_stop_check.mjs`
- [x] Stage: `stage_reconcile_positions.mjs`
- [x] Back-compat shim in `src/control_tower/portfolio_control.mjs`

## 8) `position_policy.mjs` → `position_policy/`
- [x] Create `src/control_tower/position_policy/index.mjs`
- [x] Stage: `stage_capacity.mjs`
- [x] Stage: `stage_token_display.mjs`
- [x] Stage: `stage_exit_mark.mjs`
- [x] Stage: `stage_momentum_defaults.mjs`
- [x] Back-compat shim in `src/control_tower/position_policy.mjs`

## 9) `positions_loop.mjs` → `positions_loop/`
- [x] Create `src/control_tower/positions_loop/index.mjs`
- [x] Stage: `stage_run_positions_loop.mjs`
- [x] Stage: `stage_process_open_position.mjs`
- [x] Back-compat shim in `src/control_tower/positions_loop.mjs`

## 10) `route_control.mjs` → `route_control/`
- [x] Create `src/control_tower/route_control/index.mjs`
- [x] Stage: `stage_constants.mjs`
- [x] Stage: `stage_concurrency_utils.mjs`
- [x] Stage: `stage_no_pair_state.mjs`
- [x] Stage: `stage_force_attempt_policy.mjs`
- [x] Stage: `stage_route_quote_fallback.mjs`
- [x] Stage: `stage_quick_route_recheck.mjs`
- [x] Stage: `stage_classification_mode_holders.mjs`
- [x] Back-compat shim in `src/control_tower/route_control.mjs`

## 11) `runtime_timers.mjs` → `runtime_timers/`
- [x] Create `src/control_tower/runtime_timers/index.mjs`
- [x] Stage: `stage_positions_timer.mjs`
- [x] Stage: `stage_watchlist_cleanup_timer.mjs`
- [x] Stage: `stage_observability_heartbeat_timer.mjs`
- [x] Back-compat shim in `src/control_tower/runtime_timers.mjs`

## 12) `watchlist_control.mjs` → `watchlist_control/`
- [x] Create `src/control_tower/watchlist_control/index.mjs`
- [x] Stage: `stage_watchlist_state_cache.mjs`
- [x] Stage: `stage_hot_queue_prioritization.mjs`
- [x] Stage: `stage_age_eviction.mjs`
- [x] Stage: `stage_summary_counters.mjs`
- [x] Back-compat shim in `src/control_tower/watchlist_control.mjs`

## 13) `watchlist_pipeline.mjs` → `watchlist_pipeline/`
- [x] Create `src/control_tower/watchlist_pipeline/index.mjs`
- [x] Stage: `stage_upsert_watchlist_mint.mjs`
- [x] Stage: `stage_promote_route_available.mjs`
- [x] Stage: `stage_runtime_delegate.mjs`
- [x] Back-compat shim in `src/control_tower/watchlist_pipeline.mjs`

## 14) `watchlist_pipeline_runtime.mjs` → `watchlist_pipeline_runtime/`
- [x] Create `src/control_tower/watchlist_pipeline_runtime/index.mjs`
- [x] Stage: `stage_row_preflight.mjs`
- [x] Stage: `stage_momentum_eval.mjs`
- [x] Stage: `stage_confirm_continuation.mjs`
- [x] Stage: `stage_attempt_policy_and_entry.mjs`
- [x] Stage: `stage_post_attempt_outcomes.mjs`
- [x] Back-compat shim in `src/control_tower/watchlist_pipeline_runtime.mjs`

## 15) Validation + cleanup
- [x] Ensure all current import paths continue working (via shims or import updates)
- [x] Remove dead code and duplicated helpers after extraction
- [x] Run `npm test --silent` and verify 34/34, 139/139
- [x] Commit with focused message(s)
