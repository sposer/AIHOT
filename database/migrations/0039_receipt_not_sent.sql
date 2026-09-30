-- Keep attempts that fail before transport dispatch for diagnosis without charging their budget.
ALTER TABLE receipt_attempts DROP CONSTRAINT receipt_attempts_status_check;
ALTER TABLE receipt_attempts ADD CONSTRAINT receipt_attempts_status_check
  CHECK (status IN ('pending', 'received', 'failed', 'unknown', 'not_sent'));
