-- Retire the reset monitor without changing the deployed baseline or shared history.
DROP TABLE monitor_event_posts, monitor_events, monitor_posts, monitor_state;

DELETE FROM settings WHERE key = 'models.monitor';
UPDATE settings
SET value = value - 'monitor.stuck' - 'monitor.review', updated_at = now()
WHERE key = 'alerts.state' AND value ?| ARRAY['monitor.stuck', 'monitor.review'];
