-- Retire the model leaderboard without changing the deployed baseline or shared history.
DROP TABLE lb_rankings, lb_runs, lb_prices, lb_scores, lb_snapshots, lb_aliases, lb_models, fx_rates;

DELETE FROM settings WHERE key IN ('leaderboard.fetch', 'leaderboard.last_check');
UPDATE settings
SET value = value - 'leaderboard.fetch', updated_at = now()
WHERE key = 'alerts.state' AND value ? 'leaderboard.fetch';
