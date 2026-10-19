-- Additive metadata only. Existing jobs and helpers retain unknown values.
ALTER TABLE jobs ADD COLUMN last_heartbeat_at INTEGER;
ALTER TABLE jobs ADD COLUMN completed_at INTEGER;
ALTER TABLE jobs ADD COLUMN progress_stage TEXT CHECK(progress_stage IN ('launching','model-started','response-received','validating'));
ALTER TABLE jobs ADD COLUMN progress_updated_at INTEGER;
ALTER TABLE jobs ADD COLUMN helper_version TEXT;
ALTER TABLE jobs ADD COLUMN input_tokens INTEGER CHECK(input_tokens >= 0 AND input_tokens <= 9007199254740991);
ALTER TABLE jobs ADD COLUMN cached_input_tokens INTEGER CHECK(cached_input_tokens >= 0 AND cached_input_tokens <= 9007199254740991);
ALTER TABLE jobs ADD COLUMN cache_write_input_tokens INTEGER CHECK(cache_write_input_tokens >= 0 AND cache_write_input_tokens <= 9007199254740991);
ALTER TABLE jobs ADD COLUMN output_tokens INTEGER CHECK(output_tokens >= 0 AND output_tokens <= 9007199254740991);
ALTER TABLE jobs ADD COLUMN reasoning_output_tokens INTEGER CHECK(reasoning_output_tokens >= 0 AND reasoning_output_tokens <= 9007199254740991);
ALTER TABLE helpers ADD COLUMN helper_version TEXT;
